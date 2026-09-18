import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import * as cw from '../channels/chatwork.js';
import { getSetting } from './settings.js';
import { resolveAlertsByKeyPrefix } from './alerts.js';
import { chatworkMyAccountId } from '../jobs/chatworkPoll.js';
import { isConfigured } from '../config.js';
import { logger } from '../logger.js';

/**
 * 取込済みの Chatwork メッセージに、いまの取込範囲をもう一度当てる。
 *
 * 取込範囲を「自分宛だけ」に変えても、それまでに取り込んだ分はそのまま残る。
 * そのため受信箱と要確認に範囲外のやり取りが並び続け、アイコンの件数（未返信の会話の数）も
 * 実態より大きいままになる。ここでその取りこぼしを片付ける。
 *
 * 消すのは「相手からの受信で、いまの範囲に入らないもの」だけ。
 * 自分が送った分は、アプリから送った控えを失わないよう残す。
 */

export interface ChatworkRecheckResult {
  scope: cw.ChatworkScope;
  /** 見た会話の数 */
  conversations: number;
  /** 見たメッセージの数 */
  messages: number;
  /** 範囲外だった受信の数 */
  outOfScope: number;
  /** 実際に消した数（下書きのときは 0） */
  removed: number;
  /** 受信が 1 件も残らず、受信箱から外した会話の数 */
  emptied: number;
  /** 室の種別が分からず、触らなかった会話の数 */
  skipped: number;
  /** 下書き（まだ何も変えていない）か */
  dryRun: boolean;
  /** 実行できなかった理由 */
  reason: string | null;
}

const EMPTY = (scope: cw.ChatworkScope, reason: string | null, dryRun: boolean): ChatworkRecheckResult => ({
  scope,
  conversations: 0,
  messages: 0,
  outOfScope: 0,
  removed: 0,
  emptied: 0,
  skipped: 0,
  dryRun,
  reason,
});

/**
 * @param opts.apply true なら実際に片付ける。既定は下書き（件数を数えるだけ）
 */
export async function recheckChatworkScope(opts: { apply?: boolean } = {}): Promise<ChatworkRecheckResult> {
  const dryRun = !opts.apply;
  const scope: cw.ChatworkScope = getSetting('chatwork_scope') === 'to_me' ? 'to_me' : 'all';
  if (scope !== 'to_me') return EMPTY(scope, '取込範囲が「すべて」なので、外すものはありません', dryRun);
  if (!isConfigured('chatwork')) return EMPTY(scope, 'Chatwork が未設定です', dryRun);

  let me: number | null;
  try {
    me = await chatworkMyAccountId();
  } catch (err) {
    return EMPTY(scope, `Chatwork に接続できませんでした（${(err as Error).message}）`, dryRun);
  }
  if (me === null) return EMPTY(scope, '自分のアカウント ID を取得できませんでした', dryRun);
  // ルームの種別は Chatwork から取り直す。ダイレクトチャットを取り違えると、
  // 範囲内のやり取りまで外してしまうため、分からないルームは触らない
  let roomType = new Map<string, string>();
  try {
    roomType = new Map((await cw.listRooms()).map((r) => [String(r.room_id), r.type]));
  } catch (err) {
    return EMPTY(scope, `Chatwork のルーム一覧を取得できませんでした（${(err as Error).message}）`, dryRun);
  }
  // 自分に振られたタスクは、終わったものも範囲内として扱う（当時は範囲内で取り込んでいるため）
  const taskMessageIds = new Set<string>();
  for (const status of ['open', 'done'] as const) {
    try {
      for (const t of await cw.myTasks(status)) taskMessageIds.add(t.message_id);
    } catch (err) {
      return EMPTY(scope, `Chatwork のタスク一覧を取得できませんでした（${(err as Error).message}）`, dryRun);
    }
  }

  const d = db();
  const convs = d.select().from(schema.conversations).where(eq(schema.conversations.channel, 'chatwork')).all();
  const out: ChatworkRecheckResult = { ...EMPTY(scope, null, dryRun), conversations: convs.length };
  const removeIds: number[] = [];
  /** 受信が 1 件も残らない会話（受信箱から外す） */
  const emptied = new Map<number, string>();
  /** メッセージを外した会話（日時と未読を作り直す） */
  const touched = new Map<number, string>();

  for (const conv of convs) {
    const type = roomType.get(conv.externalThreadId);
    if (!type) {
      out.skipped++;
      continue;
    }
    const msgs = d
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conv.id))
      .all()
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.id - b.id);
    out.messages += msgs.length;
    // 取り込んだときと同じ順で見ていく。「取り込み済みへの返信」は、残す側だけを既知として扱う
    const kept = new Set<string>();
    const drop: number[] = [];
    for (const m of msgs) {
      const inScope = cw.chatworkInScope(
        scope,
        { body: m.body, message_id: m.externalId, account: { account_id: Number(m.senderAddress) || -1 } },
        {
          myAccountId: me,
          roomType: type,
          taskMessageIds,
          conversationExists: true,
          isReplyToKnownMessage: (body) => {
            const t = cw.parseChatworkReplyTo(body);
            return !!t && kept.has(t.messageId);
          },
        },
      );
      // 自分の送信は、範囲外でも消さない（アプリから送った控えを失わないため）
      if (inScope || m.direction === 'out') {
        kept.add(m.externalId);
        continue;
      }
      out.outOfScope++;
      drop.push(m.id);
    }
    if (!drop.length) continue;
    removeIds.push(...drop);
    touched.set(conv.id, conv.externalThreadId);
    // 受信が 1 件も残らない会話は、受信箱から外す（会話自体は消さない）
    if (!msgs.some((m) => m.direction === 'in' && !drop.includes(m.id))) emptied.set(conv.id, conv.externalThreadId);
  }

  if (dryRun || !removeIds.length) return out;

  for (let i = 0; i < removeIds.length; i += 200) {
    const batch = removeIds.slice(i, i + 200);
    // 受信ファイルの控えを先に外す（メッセージを参照しているため）
    d.delete(schema.attachments).where(inArray(schema.attachments.messageId, batch)).run();
    out.removed += d.delete(schema.messages).where(inArray(schema.messages.id, batch)).run().changes;
  }
  // 残ったメッセージから、会話の日時と未読・未返信を作り直す
  for (const [convId, roomId] of touched) recomputeConversation(convId, emptied.has(convId) ? roomId : null);
  out.emptied = emptied.size;
  logger.info({ removed: out.removed, emptied: out.emptied }, 'Chatwork の取込範囲を当て直しました');
  return out;
}

/**
 * 残っているメッセージから、会話の最終日時と未読・未返信を作り直す。
 * emptiedRoomId が入っていれば、受信が無くなった会話としてアーカイブし、その要確認も消す
 */
function recomputeConversation(conversationId: number, emptiedRoomId: string | null) {
  const d = db();
  const msgs = d.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).all();
  const last = (dir?: 'in' | 'out') =>
    msgs
      .filter((m) => !dir || m.direction === dir)
      .map((m) => m.sentAt)
      .sort()
      .at(-1) ?? null;
  const lastInboundAt = last('in');
  const patch: Partial<typeof schema.conversations.$inferInsert> = {
    lastMessageAt: last(),
    lastInboundAt,
    lastOutboundAt: last('out'),
  };
  if (emptiedRoomId) {
    // 受信が無くなった会話は、受信箱にも要確認にも出さない
    patch.needsReply = false;
    patch.unread = 0;
    patch.archived = true;
    resolveAlertsByKeyPrefix(`unlinked:chatwork:${emptiedRoomId}`);
  } else {
    // 未読は、残っている受信の数を超えないようにする
    const inbound = msgs.filter((m) => m.direction === 'in').length;
    const cur = d.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get();
    if (cur && (cur.unread ?? 0) > inbound) patch.unread = inbound;
    // 最後が自分の送信で終わっているなら、返す必要はない
    if (lastInboundAt && patch.lastOutboundAt && patch.lastOutboundAt > lastInboundAt) patch.needsReply = false;
    if (!lastInboundAt) patch.needsReply = false;
  }
  d.update(schema.conversations).set(patch).where(and(eq(schema.conversations.id, conversationId))).run();
}
