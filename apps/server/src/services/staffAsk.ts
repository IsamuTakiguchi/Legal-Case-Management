import { and, eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import * as cw from '../channels/chatwork.js';
import { ingestMessage } from './inbox.js';
import { createTask } from './tasks.js';
import { getSetting } from './settings.js';
import { appUrl } from './notify.js';
import { generateStructured } from '../integrations/anthropic.js';
import { isConfigured } from '../config.js';
import { formatJaDateTime, CASE_NOTE_KIND_LABEL, CHANNEL_LABEL, type CaseNoteKind, type Channel } from '@lcm/shared';
import { logger } from '../logger.js';

/**
 * 受信箱に届いた連絡や、事件の記録（電話・打合せのメモ）を、そのまま Chatwork で担当事務局に確認する。
 * 「この件、どうなっていますか」を口頭で聞く代わりに、元の文面を引用して投げられるようにする。
 */

/** 何について確認するか */
export type StaffAskSource = { kind: 'conversation'; conversationId: number; messageId?: number | null } | { kind: 'note'; noteId: number };

export interface StaffAskRoom {
  roomId: number;
  name: string;
  /** case=事件専用ルーム / client=依頼者のルーム / my=マイチャット / other=参加ルーム */
  kind: 'case' | 'client' | 'my' | 'other';
}

/** 引用する元ネタ（届いた連絡、または事件の記録） */
export interface StaffAskSubject {
  kind: 'message' | 'note';
  /** 引用の見出し（「Gmail・9月1日(水)10時・山田 花子」など） */
  head: string;
  /** 引用の本文 */
  body: string;
  /** アプリの中での置き場所 */
  link: string;
}

export interface StaffAskContext {
  source: StaffAskSource;
  /** 引用するもの。見つからなければ null */
  subject: StaffAskSubject | null;
  clientId: number | null;
  clientName: string | null;
  caseId: number | null;
  caseTitle: string | null;
  staff: { id: number; name: string; chatworkAccountId: number | null }[];
  defaultStaffId: number | null;
  rooms: StaffAskRoom[];
  defaultRoomId: number | null;
  /** 送れない理由（Chatwork 未接続、事務局メンバー未登録など） */
  blocked: string | null;
}

/** 引用に使う本文（長すぎるとチャットが読みにくいので頭だけ） */
function excerpt(body: string, limit = 600): string {
  const t = body.replace(/\r/g, '').trim();
  return t.length > limit ? `${t.slice(0, limit)}…` : t;
}

/** 記録の中身を、引用に載せる形にまとめる */
function noteBody(n: typeof schema.caseNotes.$inferSelect): string {
  const parts: string[] = [];
  if (n.gist) parts.push(n.gist);
  else if (n.rawText) parts.push(n.rawText);
  if (n.theirSaid.length) parts.push(`${n.counterpart ?? '相手'}: ${n.theirSaid.join(' / ')}`);
  if (n.ourSaid.length) parts.push(`こちら: ${n.ourSaid.join(' / ')}`);
  if (n.decisions) parts.push(`決定: ${n.decisions}`);
  if (n.nextActions.length) parts.push(`次のアクション: ${n.nextActions.map((a) => `${a.title}${a.due ? `（${a.due}）` : ''}`).join(' / ')}`);
  return excerpt(parts.join('\n'));
}

/** 元ネタと、それが属する依頼者・事件を引く */
function resolveSubject(source: StaffAskSource): { subject: StaffAskSubject | null; clientId: number | null; caseId: number | null; conversationId: number | null } {
  const d = db();
  if (source.kind === 'note') {
    const n = d.select().from(schema.caseNotes).where(eq(schema.caseNotes.id, source.noteId)).get();
    if (!n) throw new Error('記録が見つかりません');
    const kase = d.select().from(schema.cases).where(eq(schema.cases.id, n.caseId)).get();
    const label = CASE_NOTE_KIND_LABEL[n.kind as CaseNoteKind] ?? n.kind;
    return {
      subject: {
        kind: 'note',
        head: `${label}の記録・${formatJaDateTime(new Date(n.occurredAt))}${n.counterpart ? `・${n.counterpart}` : ''}`,
        body: noteBody(n),
        link: `/cases/${n.caseId}#note-${n.id}`,
      },
      clientId: n.clientId ?? kase?.clientId ?? null,
      caseId: n.caseId,
      conversationId: null,
    };
  }
  const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, source.conversationId)).get();
  if (!conv) throw new Error('会話が見つかりません');
  const msg = source.messageId
    ? d.select().from(schema.messages).where(eq(schema.messages.id, source.messageId)).get()
    : d
        .select()
        .from(schema.messages)
        .where(and(eq(schema.messages.conversationId, source.conversationId), eq(schema.messages.direction, 'in')))
        .orderBy(desc(schema.messages.sentAt))
        .get();
  if (source.messageId && msg && msg.conversationId !== source.conversationId) throw new Error('そのメッセージはこの会話のものではありません');
  return {
    subject: msg
      ? {
          kind: 'message',
          head: `${CHANNEL_LABEL[msg.channel as Channel] ?? msg.channel}・${formatJaDateTime(new Date(msg.sentAt))}${msg.senderName ? `・${msg.senderName}` : ''}`,
          body: excerpt(msg.body),
          link: `/inbox/${conv.id}`,
        }
      : null,
    clientId: conv.clientId ?? null,
    // 事件は、メッセージに振り分け済みならそれ、無ければ会話の事件
    caseId: msg?.caseId ?? conv.caseId ?? null,
    conversationId: conv.id,
  };
}

export async function staffAskContext(source: StaffAskSource): Promise<StaffAskContext> {
  const d = db();
  const { subject, clientId, caseId } = resolveSubject(source);
  const client = clientId ? (d.select().from(schema.clients).where(eq(schema.clients.id, clientId)).get() ?? null) : null;
  const kase = caseId ? (d.select().from(schema.cases).where(eq(schema.cases.id, caseId)).get() ?? null) : null;
  const staff = d
    .select()
    .from(schema.staffMembers)
    .where(eq(schema.staffMembers.active, true))
    .all()
    .map((s) => ({ id: s.id, name: s.name, chatworkAccountId: s.chatworkAccountId }));

  const rooms: StaffAskRoom[] = [];
  const add = (roomId: number | null | undefined, name: string, kind: StaffAskRoom['kind']) => {
    if (!roomId || rooms.some((r) => r.roomId === roomId)) return;
    rooms.push({ roomId, name, kind });
  };
  add(kase?.chatworkRoomId, `${kase?.title ?? '事件'}の専用ルーム`, 'case');
  add(client?.chatworkRoomId, `${client?.name ?? '依頼者'}のルーム`, 'client');
  if (isConfigured('chatwork')) {
    const my = await cw.myChatRoomId().catch(() => null);
    add(my, 'マイチャット（自分用）', 'my');
    // 参加している他のルームも選べるようにする（事務局の全体ルームなど）
    const all = await cw.listRooms().catch(() => []);
    for (const r of all) {
      if (r.type === 'my') continue;
      add(r.room_id, r.name, 'other');
    }
  }
  const defaultStaffId = kase?.staffId ?? (staff.length === 1 ? staff[0]!.id : null);
  const blocked = !isConfigured('chatwork')
    ? 'Chatwork が未設定です。初期設定で接続してください'
    : staff.length === 0
      ? '事務局メンバーが登録されていません。設定 → 事務局メンバーで登録してください'
      : rooms.length === 0
        ? '送り先の Chatwork ルームが見つかりません'
        : null;
  return {
    source,
    subject,
    clientId: client?.id ?? null,
    clientName: client?.name ?? null,
    caseId,
    caseTitle: kase?.title ?? null,
    staff,
    defaultStaffId,
    rooms,
    defaultRoomId: rooms[0]?.roomId ?? null,
    blocked,
  };
}

const askDraftSchema = z.object({
  text: z.string().describe('事務局への確認・依頼の本文。1〜3 文。依頼者の前では書けないことは書かない'),
  title: z.string().describe('タスクにするときの短い題名。30 字以内'),
});

/** 元ネタの内容から、事務局に何を確認したいかの下書きを作る */
export async function draftStaffAsk(source: StaffAskSource, opts: { instruction?: string | null } = {}) {
  const ctx = await staffAskContext(source);
  if (!ctx.subject) throw new Error('確認のもとになる内容が見つかりません');
  const staffName = ctx.staff.find((s) => s.id === ctx.defaultStaffId)?.name ?? '事務局';
  const fromLabel = ctx.subject.kind === 'note' ? '事件の記録' : '届いた連絡';
  return generateStructured({
    purpose: '事務局への確認の下書き',
    system: [
      '法律事務所の弁護士に代わって、事務局（パラリーガル）に送る短い確認・依頼の文を書きます。',
      '相手は同じ事務所の職員なので、丁寧だが簡潔に。挨拶や署名は不要。',
      `${fromLabel}の内容から「事務局に確かめてほしいこと・やってほしいこと」を書きます。書かれていないことは作りません。`,
      '依頼者への回答そのものではなく、事務局への指示・確認であることに注意します（例: 「◯◯の受領状況を確認してください」「前回の書面の控えを探してください」）。',
      ctx.subject.kind === 'note'
        ? '記録に「次のアクション」や「決定事項」があれば、そのうち事務局にやってもらうことを優先して書きます。'
        : '',
      '弁護士の指示があるときは、それを最優先で反映します。',
    ]
      .filter(Boolean)
      .join('\n'),
    user: [
      `事務局の担当: ${staffName}`,
      ctx.clientName ? `依頼者: ${ctx.clientName}` : '',
      ctx.caseTitle ? `事件: ${ctx.caseTitle}` : '',
      `${fromLabel}（${ctx.subject.head}）:`,
      ctx.subject.body,
      opts.instruction ? `弁護士の指示: ${opts.instruction}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    schema: askDraftSchema,
    effort: 'low',
    maxTokens: 1000,
  });
}

export interface StaffAskInput {
  staffId?: number | null;
  roomId: number;
  text: string;
  /** Chatwork のタスクとして送る（事務局のタスク一覧に残る） */
  asTask?: boolean;
  /** タスクの期限（YYYY-MM-DD） */
  due?: string | null;
  /** 引用（元ネタ）を付ける */
  quote?: boolean;
  /** アプリ側にも「事務局の返事待ち」のタスクを作る */
  createWaitingTask?: boolean;
}

/** Chatwork に送る本文を組み立てる（宛先のメンション＋確認内容＋元ネタの引用＋アプリへのリンク） */
export function buildStaffAskBody(
  ctx: StaffAskContext,
  input: { text: string; quote?: boolean; staff?: { name: string; chatworkAccountId: number | null } | null },
): string {
  const lines: string[] = [];
  if (input.staff?.chatworkAccountId) lines.push(`[To:${input.staff.chatworkAccountId}] ${input.staff.name}さん`);
  const who = [ctx.clientName, ctx.caseTitle].filter(Boolean).join(' / ');
  if (who) lines.push(`【${who}】`);
  lines.push(input.text.trim());
  if (input.quote !== false && ctx.subject) {
    const label = ctx.subject.kind === 'note' ? '事件の記録' : '届いた連絡';
    lines.push(`[info][title]${label}（${ctx.subject.head}）[/title]${ctx.subject.body}[/info]`);
  }
  if (ctx.subject) lines.push(appUrl(ctx.subject.link));
  return lines.join('\n');
}

/** 事務局に確認を送る。送った控えはアプリにも残す */
export async function sendStaffAsk(source: StaffAskSource, input: StaffAskInput) {
  if (!isConfigured('chatwork')) throw new Error('Chatwork が未設定です');
  if (!input.text.trim()) throw new Error('確認したいことを入力してください');
  const ctx = await staffAskContext(source);
  const room = ctx.rooms.find((r) => r.roomId === input.roomId);
  if (!room) throw new Error('送り先のルームが選ばれていません');
  const staff = input.staffId ? (ctx.staff.find((s) => s.id === input.staffId) ?? null) : null;
  if (input.staffId && !staff) throw new Error('担当の事務局メンバーが見つかりません');
  const body = buildStaffAskBody(ctx, { text: input.text, quote: input.quote, staff });

  let chatworkTaskId: number | null = null;
  let externalId: string;
  if (input.asTask) {
    if (!staff?.chatworkAccountId) throw new Error('タスクとして送るには、担当者の Chatwork アカウントの登録が必要です');
    const limit = input.due ? Math.floor(new Date(`${input.due}T18:00:00+09:00`).getTime() / 1000) : undefined;
    const r = await cw.createTask(room.roomId, body, [staff.chatworkAccountId], limit);
    chatworkTaskId = r.task_ids[0] ?? null;
    externalId = `task-${chatworkTaskId ?? Date.now()}`;
  } else {
    const r = await cw.postMessage(room.roomId, body);
    externalId = r.message_id;
  }

  const from =
    source.kind === 'note'
      ? { noteId: source.noteId, chatworkTaskId }
      : { fromConversationId: source.conversationId, messageId: source.messageId ?? null, chatworkTaskId };
  // 送った控えを、その Chatwork ルームの会話にも残す（あとで取り込む分と重複しないよう ID をそろえる）
  const saved = await ingestMessage(
    {
      channel: 'chatwork',
      externalThreadId: String(room.roomId),
      externalId,
      direction: 'out',
      sentAt: new Date().toISOString(),
      senderName: getSetting('lawyer_name') || '自分',
      body: cw.stripChatworkMarkup(body),
      attachments: [],
      raw: { staffAsk: from },
      identity: { channel: 'chatwork', chatworkRoomId: room.roomId },
    },
    { processAttachments: false },
  ).catch((err) => {
    logger.warn({ err, roomId: room.roomId }, '事務局への確認の控えを保存できませんでした');
    return null;
  });

  let waitingTaskId: number | null = null;
  if (input.createWaitingTask) {
    const title = `事務局に確認: ${input.text.trim().split('\n')[0]!.slice(0, 40)}`;
    const t = await createTask({
      title,
      clientId: ctx.clientId,
      caseId: ctx.caseId,
      conversationId: source.kind === 'conversation' ? source.conversationId : null,
      status: 'waiting_other',
      followUpAt: input.due ? new Date(`${input.due}T09:00:00+09:00`).toISOString() : null,
      note: `${staff ? `${staff.name}さんへ` : ''}\n${input.text.trim()}`.trim(),
      syncToChatwork: false,
    });
    waitingTaskId = t.id;
  }

  logger.info({ source, roomId: room.roomId, asTask: !!input.asTask, staffId: staff?.id ?? null }, '事務局に確認を送りました');
  return { roomId: room.roomId, roomName: room.name, staffName: staff?.name ?? null, asTask: !!input.asTask, chatworkTaskId, messageId: saved?.message.id ?? null, waitingTaskId };
}
