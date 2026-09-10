import { and, eq, desc, sql, inArray, isNull, isNotNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { InboundMessage } from '../channels/types.js';
import { findClientByIdentity, raiseUnlinkedContact, cleanDisplayName } from './identity.js';
import { processAttachment } from './attachments.js';
import { logger } from '../logger.js';
import { onInboundForTasks } from './tasks.js';
import { staffByChatworkAccount, caseForChatworkRoom, guessClientFromText } from './staff.js';
import { linkGmailMessageToCreditor } from './creditors.js';
import { findContactByIdentity, contactBriefs } from './contacts.js';
import { getSetting } from './settings.js';
import { NON_PRIMARY_CATEGORIES, type GmailCategory } from '../channels/gmail.js';

export type ConversationRow = typeof schema.conversations.$inferSelect;
export type MessageRow = typeof schema.messages.$inferSelect;

/** 受信メッセージを保存。重複は無視。添付は即時ダウンロード→保存 */
export async function ingestMessage(
  m: InboundMessage,
  opts: { processAttachments?: boolean } = {},
): Promise<{ message: MessageRow; conversation: ConversationRow; isNew: boolean }> {
  const d = db();
  let conv = d
    .select()
    .from(schema.conversations)
    .where(and(eq(schema.conversations.channel, m.channel), eq(schema.conversations.externalThreadId, m.externalThreadId)))
    .get();
  const counterpartName = cleanDisplayName(m.direction === 'in' ? (m.senderName ?? m.identity.displayName ?? null) : (m.identity.displayName ?? null));
  const unlinkedInfo = { body: m.body, sentAt: m.sentAt, subject: m.subject ?? null };
  const counterpartAddress = m.identity.email ?? m.identity.lineUserId ?? (m.identity.chatworkAccountId ? String(m.identity.chatworkAccountId) : null);
  // Chatwork: 事務局メンバーからの伝言か／事件専用ルームか
  const staff = m.channel === 'chatwork' && m.direction === 'in' ? staffByChatworkAccount(m.identity.chatworkAccountId) : null;
  const roomCase = m.channel === 'chatwork' ? caseForChatworkRoom(m.identity.chatworkRoomId) : null;
  // 事件の関係者（相手方代理人など）からの連絡か。依頼者より先に照合する（同じ人が依頼者にも登録されていることはない前提）
  const contactHit = !staff && !roomCase ? findContactByIdentity(m.identity) : null;
  if (!conv) {
    const client = contactHit
      ? (d.select().from(schema.clients).where(eq(schema.clients.id, contactHit.kase.clientId)).get() ?? null)
      : (findClientByIdentity(m.identity) ?? (roomCase ? (d.select().from(schema.clients).where(eq(schema.clients.id, roomCase.clientId)).get() ?? null) : null));
    conv = d
      .insert(schema.conversations)
      .values({
        channel: m.channel,
        externalThreadId: m.externalThreadId,
        clientId: client?.id ?? null,
        caseId: contactHit?.kase.id ?? null,
        contactId: contactHit?.contact.id ?? null,
        subject: m.subject ?? null,
        counterpartName,
        counterpartAddress,
        meta: { ...(m.threadMeta ?? {}), ...(staff ? { staff: true } : {}) },
      })
      .returning()
      .get();
    if (!client && m.direction === 'in' && !staff) raiseUnlinkedContact(conv.id, m.identity, counterpartName, unlinkedInfo);
  } else if (!conv.clientId) {
    // 相手の名前が後から分かったら会話にも入れる（LINE のプロフィール取得が後で成功した場合など）
    if (m.direction === 'in' && counterpartName && !cleanDisplayName(conv.counterpartName)) {
      d.update(schema.conversations).set({ counterpartName }).where(eq(schema.conversations.id, conv.id)).run();
      conv = { ...conv, counterpartName };
    }
    if (contactHit) {
      d.update(schema.conversations).set({ clientId: contactHit.kase.clientId, caseId: contactHit.kase.id, contactId: contactHit.contact.id }).where(eq(schema.conversations.id, conv.id)).run();
      conv = { ...conv, clientId: contactHit.kase.clientId, caseId: contactHit.kase.id, contactId: contactHit.contact.id };
    } else {
      const client = findClientByIdentity(m.identity) ?? (roomCase ? (d.select().from(schema.clients).where(eq(schema.clients.id, roomCase.clientId)).get() ?? null) : null);
      if (client) {
        d.update(schema.conversations).set({ clientId: client.id }).where(eq(schema.conversations.id, conv.id)).run();
        conv = { ...conv, clientId: client.id };
      } else if (m.direction === 'in' && !staff) {
        raiseUnlinkedContact(conv.id, m.identity, counterpartName ?? conv.counterpartName, unlinkedInfo);
      }
    }
  }
  if (staff && !(conv.meta as { staff?: boolean }).staff) {
    const meta = { ...(conv.meta as Record<string, unknown>), staff: true };
    d.update(schema.conversations).set({ meta }).where(eq(schema.conversations.id, conv.id)).run();
    conv = { ...conv, meta };
  }
  // メッセージ単位の紐付け: 事件専用ルームならその事件、事務局の伝言なら本文の依頼者名から推定
  let msgClientId: number | null = null;
  let msgCaseId: number | null = null;
  if (conv.contactId && conv.caseId) {
    // 関係者との会話は、その事件のやり取りとして記録する
    msgClientId = conv.clientId;
    msgCaseId = conv.caseId;
  } else if (roomCase) {
    msgClientId = roomCase.clientId;
    msgCaseId = roomCase.id;
  } else if (staff) {
    const g = guessClientFromText(m.body);
    if (g) {
      msgClientId = g.clientId;
      msgCaseId = g.caseId;
    }
  }

  const existing = d
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.channel, m.channel), eq(schema.messages.externalId, m.externalId)))
    .get();
  if (existing) return { message: existing, conversation: conv, isNew: false };

  const message = d
    .insert(schema.messages)
    .values({
      conversationId: conv.id,
      channel: m.channel,
      externalId: m.externalId,
      direction: m.direction,
      senderName: m.senderName ?? null,
      senderAddress: m.senderAddress ?? null,
      body: m.body,
      sentAt: m.sentAt,
      raw: m.raw ?? null,
      clientId: msgClientId,
      caseId: msgCaseId,
      replyToken: m.replyToken ?? null,
      replyTokenAt: m.replyToken ? new Date().toISOString() : null,
    })
    .returning()
    .get();

  // 過去分の取り込み（Chatwork のポーリングが後からさかのぼって拾った古い発言など）は、
  // 会話の「最終受信日時」を巻き戻さず、未読・要返信・アーカイブ解除もしない
  const backfill = !!conv.lastMessageAt && m.sentAt < conv.lastMessageAt;
  const patch: Partial<typeof schema.conversations.$inferInsert> = {};
  if (!backfill) patch.lastMessageAt = m.sentAt;
  if (m.direction === 'in') {
    if (!conv.lastInboundAt || m.sentAt > conv.lastInboundAt) patch.lastInboundAt = m.sentAt;
    if (!backfill) {
      patch.unread = (conv.unread ?? 0) + 1;
      patch.needsReply = true;
      patch.archived = false;
    }
    if (!conv.counterpartName && counterpartName) patch.counterpartName = counterpartName;
    if (!conv.counterpartAddress && counterpartAddress) patch.counterpartAddress = counterpartAddress;
  } else {
    if (!conv.lastOutboundAt || m.sentAt > conv.lastOutboundAt) patch.lastOutboundAt = m.sentAt;
    if (!backfill) patch.needsReply = false;
  }
  if (m.subject && !conv.subject) patch.subject = m.subject;
  if (Object.keys(patch).length) d.update(schema.conversations).set(patch).where(eq(schema.conversations.id, conv.id)).run();

  // 受信ファイルは相手から届いたものだけ。自分が送った添付は登録しない
  for (const a of m.direction === 'in' ? m.attachments : []) {
    const row = d
      .insert(schema.attachments)
      .values({
        messageId: message.id,
        clientId: conv.clientId ?? null,
        filename: a.filename,
        mime: a.mime ?? null,
        size: a.size ?? null,
        channelRef: a.ref,
        status: 'pending',
      })
      .returning()
      .get();
    if (opts.processAttachments !== false) {
      processAttachment(row.id).catch((err) => logger.error({ err, attachmentId: row.id }, '添付の保存に失敗'));
    }
  }

  if (m.direction === 'in') {
    try {
      onInboundForTasks(conv.id, message);
    } catch (err) {
      logger.warn({ err }, '返信待ちタスクの更新に失敗');
    }
  }
  if (m.channel === 'gmail') {
    try {
      linkGmailMessageToCreditor(conv, message, m);
    } catch (err) {
      logger.warn({ err }, '債権者への紐付けに失敗');
    }
  }
  return { message, conversation: { ...conv, ...patch } as ConversationRow, isNew: true };
}

export function listConversations(filter: {
  clientId?: number;
  channel?: string;
  needsReply?: boolean;
  unlinked?: boolean;
  q?: string;
  limit?: number;
  archived?: boolean;
  /** true なら相手からの受信が 1 件も無い会話（自分の送信だけ）を除く */
  inboundOnly?: boolean;
}) {
  const d = db();
  const conds = [];
  if (filter.clientId) conds.push(eq(schema.conversations.clientId, filter.clientId));
  if (filter.inboundOnly) conds.push(isNotNull(schema.conversations.lastInboundAt));
  if (filter.channel) conds.push(eq(schema.conversations.channel, filter.channel));
  if (filter.needsReply) conds.push(eq(schema.conversations.needsReply, true));
  if (filter.unlinked) conds.push(isNull(schema.conversations.clientId));
  conds.push(eq(schema.conversations.archived, filter.archived ?? false));
  let rows = d
    .select()
    .from(schema.conversations)
    .where(and(...conds))
    .orderBy(desc(schema.conversations.lastMessageAt))
    .limit(filter.limit ?? 200)
    .all();
  // Gmail は「メインだけ」の設定なら、取込済みのプロモーション等の会話も一覧から外す
  if (getSetting('gmail_categories') === 'primary') {
    rows = rows.filter((r) => r.channel !== 'gmail' || !NON_PRIMARY_CATEGORIES.includes(((r.meta as { category?: string }).category ?? 'primary') as GmailCategory));
  }
  if (filter.q) {
    const ids = d
      .all<{ rowid: number }>(sql`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${ftsQuery(filter.q)} LIMIT 500`)
      .map((r) => r.rowid);
    if (ids.length === 0) return [];
    const convIds = new Set(
      d
        .select({ conversationId: schema.messages.conversationId })
        .from(schema.messages)
        .where(inArray(schema.messages.id, ids))
        .all()
        .map((r) => r.conversationId),
    );
    rows = rows.filter((r) => convIds.has(r.id));
  }
  const clientIds = [...new Set(rows.map((r) => r.clientId).filter((x): x is number => !!x))];
  const clients = clientIds.length ? d.select().from(schema.clients).where(inArray(schema.clients.id, clientIds)).all() : [];
  const byId = new Map(clients.map((c) => [c.id, c]));
  const contacts = contactBriefs(rows.map((r) => r.contactId ?? 0));
  return rows.map((r) => {
    const last = d.select().from(schema.messages).where(eq(schema.messages.conversationId, r.id)).orderBy(desc(schema.messages.sentAt)).limit(1).get();
    return {
      contact: r.contactId ? (contacts.get(r.contactId) ?? null) : null,
      ...r,
      staff: !!(r.meta as { staff?: boolean }).staff,
      client: r.clientId ? (byId.get(r.clientId) ?? null) : null,
      lastMessage: last ? { body: last.body.slice(0, 600), truncated: last.body.length > 600, direction: last.direction, sentAt: last.sentAt, senderName: last.senderName } : null,
    };
  });
}

/** FTS5 の MATCH 用にクエリをフレーズ化（trigram は 3 文字以上必要） */
export function ftsQuery(q: string): string {
  const terms = q
    .split(/[\s　]+/)
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => t.length >= 3);
  if (terms.length === 0) return `"${q.replace(/"/g, '')}"`;
  return terms.map((t) => `"${t}"`).join(' AND ');
}

/** 返信先のメッセージ（自分の送信は raw.replyToMessageId、Chatwork の受信は [rp] タグの message_id）を同じ会話から探す */
function replyTargetOf(m: MessageRow, all: MessageRow[]): { id: number; senderName: string | null; direction: string; excerpt: string } | null {
  const raw = (m.raw ?? {}) as { replyToMessageId?: number | null; replyToExternalId?: string | null };
  const target = raw.replyToMessageId ? all.find((x) => x.id === raw.replyToMessageId) : raw.replyToExternalId ? all.find((x) => x.externalId === raw.replyToExternalId) : null;
  if (!target) return null;
  const excerpt = target.body.replace(/\s+/g, ' ').trim();
  return { id: target.id, senderName: target.direction === 'out' ? null : target.senderName, direction: target.direction, excerpt: excerpt.length > 60 ? `${excerpt.slice(0, 60)}…` : excerpt };
}

export function getConversation(id: number) {
  const d = db();
  const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, id)).get();
  if (!conv) return null;
  const messages = d.select().from(schema.messages).where(eq(schema.messages.conversationId, id)).orderBy(schema.messages.sentAt).all();
  const msgIds = messages.map((m) => m.id);
  const atts = msgIds.length ? d.select().from(schema.attachments).where(inArray(schema.attachments.messageId, msgIds)).all() : [];
  const client = conv.clientId ? d.select().from(schema.clients).where(eq(schema.clients.id, conv.clientId)).get() : null;
  const cases = conv.clientId ? d.select().from(schema.cases).where(eq(schema.cases.clientId, conv.clientId)).all() : [];
  const contact = conv.contactId ? (contactBriefs([conv.contactId]).get(conv.contactId) ?? null) : null;
  const msgClientIds = [...new Set(messages.map((m) => m.clientId).filter((x): x is number => !!x))];
  const msgCaseIds = [...new Set(messages.map((m) => m.caseId).filter((x): x is number => !!x))];
  const msgClients = msgClientIds.length ? d.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(inArray(schema.clients.id, msgClientIds)).all() : [];
  const msgCases = msgCaseIds.length ? d.select({ id: schema.cases.id, title: schema.cases.title }).from(schema.cases).where(inArray(schema.cases.id, msgCaseIds)).all() : [];
  return {
    ...conv,
    staff: !!(conv.meta as { staff?: boolean }).staff,
    client: client ?? null,
    contact,
    cases,
    messages: messages.map((m) => ({
      ...m,
      raw: undefined,
      replyTo: replyTargetOf(m, messages),
      attachments: atts.filter((a) => a.messageId === m.id),
      clientName: m.clientId ? (msgClients.find((c) => c.id === m.clientId)?.name ?? null) : null,
      caseTitle: m.caseId ? (msgCases.find((c) => c.id === m.caseId)?.title ?? null) : null,
    })),
  };
}

/** メッセージ単位の紐付け（事務局の伝言をどの依頼者・事件の話か指定する） */
export function linkMessage(id: number, patch: { clientId?: number | null; caseId?: number | null }) {
  const d = db();
  const m = d.select().from(schema.messages).where(eq(schema.messages.id, id)).get();
  if (!m) throw new Error('メッセージが見つかりません');
  let clientId = m.clientId;
  let caseId = m.caseId;
  if (patch.caseId !== undefined) {
    caseId = patch.caseId;
    if (caseId) {
      const c = d.select().from(schema.cases).where(eq(schema.cases.id, caseId)).get();
      if (!c) throw new Error('事件が見つかりません');
      clientId = c.clientId;
    } else if (patch.clientId !== undefined) {
      clientId = patch.clientId;
    }
  } else if (patch.clientId !== undefined) {
    // 依頼者だけ変えた（または外した）ときは、事件の紐付けは付け直しになる
    clientId = patch.clientId;
    if (clientId !== m.clientId) caseId = null;
  }
  d.update(schema.messages).set({ clientId, caseId }).where(eq(schema.messages.id, id)).run();
  return d.select().from(schema.messages).where(eq(schema.messages.id, id)).get()!;
}

export function markRead(id: number) {
  db().update(schema.conversations).set({ unread: 0 }).where(eq(schema.conversations.id, id)).run();
}

export function setNeedsReply(id: number, needsReply: boolean) {
  db().update(schema.conversations).set({ needsReply }).where(eq(schema.conversations.id, id)).run();
}

export function archiveConversation(id: number, archived: boolean) {
  db().update(schema.conversations).set({ archived }).where(eq(schema.conversations.id, id)).run();
}

export type BulkConversationAction = 'resolve' | 'archive' | 'unarchive' | 'read';

/** 受信箱の一括操作。resolve=対応済み（要返信を外して既読に）、archive=アーカイブ（既読・要返信解除も） */
export function bulkUpdateConversations(ids: number[], action: BulkConversationAction): number {
  if (ids.length === 0) return 0;
  const patch =
    action === 'resolve'
      ? { needsReply: false, unread: 0 }
      : action === 'archive'
        ? { archived: true, needsReply: false, unread: 0 }
        : action === 'unarchive'
          ? { archived: false }
          : { unread: 0 };
  const r = db().update(schema.conversations).set(patch).where(inArray(schema.conversations.id, ids)).run();
  return r.changes;
}


/**
 * 会話の最終日時をメッセージから計算し直す（過去分の取り込みで巻き戻っていたものを直す）。
 * 起動時に一度だけ呼ぶ。未読・要返信は手で変えていることがあるので触らない
 */
export function repairConversationTimes(): number {
  const d = db();
  const convs = d.select().from(schema.conversations).all();
  let fixed = 0;
  for (const c of convs) {
    const msgs = d.select({ sentAt: schema.messages.sentAt, direction: schema.messages.direction }).from(schema.messages).where(eq(schema.messages.conversationId, c.id)).all();
    if (!msgs.length) continue;
    const max = (rows: { sentAt: string }[]) => rows.reduce<string | null>((a, r) => (a && a > r.sentAt ? a : r.sentAt), null);
    const last = max(msgs);
    const lastIn = max(msgs.filter((m) => m.direction === 'in'));
    const lastOut = max(msgs.filter((m) => m.direction === 'out'));
    const patch: Partial<typeof schema.conversations.$inferInsert> = {};
    if (last && last !== c.lastMessageAt) patch.lastMessageAt = last;
    if (lastIn && lastIn !== c.lastInboundAt) patch.lastInboundAt = lastIn;
    if (lastOut && lastOut !== c.lastOutboundAt) patch.lastOutboundAt = lastOut;
    if (Object.keys(patch).length) {
      d.update(schema.conversations).set(patch).where(eq(schema.conversations.id, c.id)).run();
      fixed++;
    }
  }
  return fixed;
}

/**
 * 自分のアドレス（別名・他アカウント）から送ったのに「受信」として取り込まれていたメールを「送信」に直し、
 * 会話の要返信・未読・最終受信日時を計算し直す。設定「自分のメールアドレス」を変えたときと、設定画面のボタンから呼ぶ
 */
export function refixOwnMessages(myAddrs: string[]): { fixed: number; conversations: number } {
  const d = db();
  const addrs = new Set(myAddrs.map((a) => a.toLowerCase()));
  if (!addrs.size) return { fixed: 0, conversations: 0 };
  const wrong = d
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.channel, 'gmail'), eq(schema.messages.direction, 'in')))
    .all()
    .filter((m) => m.senderAddress && addrs.has(m.senderAddress.toLowerCase()));
  const convIds = new Set<number>();
  for (const m of wrong) {
    d.update(schema.messages).set({ direction: 'out' }).where(eq(schema.messages.id, m.id)).run();
    convIds.add(m.conversationId);
  }
  for (const id of convIds) {
    const msgs = d.select().from(schema.messages).where(eq(schema.messages.conversationId, id)).orderBy(schema.messages.sentAt).all();
    const last = msgs.at(-1);
    const lastIn = [...msgs].reverse().find((m) => m.direction === 'in');
    const lastOut = [...msgs].reverse().find((m) => m.direction === 'out');
    d.update(schema.conversations)
      .set({
        lastInboundAt: lastIn?.sentAt ?? null,
        lastOutboundAt: lastOut?.sentAt ?? null,
        needsReply: !!last && last.direction === 'in',
        unread: lastIn ? undefined : 0,
      })
      .where(eq(schema.conversations.id, id))
      .run();
    // 受信が無くなった会話の「未紐付けの連絡先」は消す
    if (!lastIn) {
      for (const a of d.select().from(schema.alerts).where(eq(schema.alerts.status, 'open')).all()) {
        if (a.type === 'unlinked_contact' && (a.payload as { conversationId?: number }).conversationId === id) {
          d.update(schema.alerts).set({ status: 'resolved', resolvedAt: new Date().toISOString() }).where(eq(schema.alerts.id, a.id)).run();
        }
      }
    }
  }
  return { fixed: wrong.length, conversations: convIds.size };
}
