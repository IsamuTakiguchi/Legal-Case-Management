import { and, desc, eq, or, like } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { IdentityHint } from '../channels/types.js';
import { upsertAlert } from './alerts.js';

export type ClientRow = typeof schema.clients.$inferSelect;

export function findClientByIdentity(id: IdentityHint): ClientRow | null {
  const all = db().select().from(schema.clients).where(eq(schema.clients.archived, false)).all();
  if (id.channel === 'gmail' && id.email) {
    const e = id.email.toLowerCase();
    return all.find((c) => c.emails.map((x) => x.toLowerCase()).includes(e)) ?? null;
  }
  if (id.channel === 'line' && id.lineUserId) {
    return all.find((c) => c.lineUserId === id.lineUserId) ?? null;
  }
  if (id.channel === 'chatwork') {
    if (id.chatworkRoomId) {
      const byRoom = all.find((c) => c.chatworkRoomId === id.chatworkRoomId);
      if (byRoom) return byRoom;
    }
    if (id.chatworkAccountId) return all.find((c) => c.chatworkAccountId === id.chatworkAccountId) ?? null;
  }
  return null;
}

/** 表示名のあいまい一致で候補を返す（未紐付け連絡先の紐付け補助） */
export function suggestClients(displayName: string | null | undefined, limit = 5): ClientRow[] {
  if (!displayName) return [];
  const norm = displayName.replace(/[\s　]/g, '');
  const all = db().select().from(schema.clients).where(eq(schema.clients.archived, false)).all();
  const scored = all
    .map((c) => {
      const names = [c.name, c.kana ?? '', ...c.aliases].map((n) => n.replace(/[\s　]/g, ''));
      let score = 0;
      for (const n of names) {
        if (!n) continue;
        if (n === norm) score = Math.max(score, 100);
        else if (norm.includes(n) || n.includes(norm)) score = Math.max(score, 60);
        else if (n.length >= 2 && norm.startsWith(n.slice(0, 2))) score = Math.max(score, 30);
      }
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map((x) => x.c);
}

/**
 * 表示名の掃除。LINE の表示名が絵文字の飾り（異体字セレクタ）やゼロ幅文字だけのことがあり、
 * そのままだと画面に何も見えない名前になるため、見えない文字を除いて空なら null にする
 */
export function cleanDisplayName(name: string | null | undefined): string | null {
  if (!name) return null;
  const cleaned = name
    .replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFE00-\uFE0F\uFEFF\u034F]/g, '')
    .replace(/[\s　]+/g, ' ')
    .trim();
  return cleaned || null;
}

const CHANNEL_LABEL: Record<string, string> = { line: 'LINE公式', chatwork: 'Chatwork', gmail: 'Gmail' };

/** 受信本文を 1 行の抜粋にする（Chatwork の装飾タグや改行を除く） */
export function excerpt(body: string | null | undefined, max = 80): string {
  if (!body) return '';
  const t = body
    .replace(/\[(?:To|rp|qt|\/qt|qtmeta|info|\/info|title|\/title|hr|download|preview)[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export interface UnlinkedMessageInfo {
  body?: string | null;
  sentAt?: string | null;
  subject?: string | null;
}

/**
 * 未紐付けの連絡先の警告。誰から・どのメッセージかが分かるよう、相手の名前（無ければ ID や
 * アドレス）と受信本文の抜粋・受信日時を題名と本文に入れる。同じ相手から続けて届いたら最新の内容に更新する
 */
export function raiseUnlinkedContact(conversationId: number, id: IdentityHint, displayName: string | null | undefined, msg: UnlinkedMessageInfo = {}) {
  const key = `unlinked:${id.channel}:${id.email ?? id.lineUserId ?? id.chatworkRoomId ?? id.chatworkAccountId ?? conversationId}`;
  const existing = db().select().from(schema.alerts).where(eq(schema.alerts.dedupeKey, key)).get();
  const count = existing?.status === 'open' ? Number((existing.payload as { messageCount?: number }).messageCount ?? 1) + 1 : 1;
  upsertAlert({ type: 'unlinked_contact', dedupeKey: key, ...buildUnlinkedAlert(conversationId, id, displayName, msg, count), refresh: true });
}

/** 警告の題名・本文・付随情報を組み立てる */
function buildUnlinkedAlert(conversationId: number, id: IdentityHint, displayName: string | null | undefined, msg: UnlinkedMessageInfo, count: number) {
  const name = cleanDisplayName(displayName);
  const who = (() => {
    if (name) return id.channel === 'gmail' && id.email && !name.includes('@') ? `${name}（${id.email}）` : name;
    if (id.channel === 'gmail') return id.email ?? '差出人不明';
    if (id.channel === 'line') return `名前が取得できない LINE の相手（ID 末尾 …${(id.lineUserId ?? '').slice(-6)}）`;
    if (id.channel === 'chatwork') return msg.subject ? `ルーム「${msg.subject}」` : `Chatwork アカウント ${id.chatworkAccountId ?? id.chatworkRoomId ?? ''}`;
    return '相手不明';
  })();
  const preview = excerpt(msg.body);
  const lines = [
    preview ? `「${preview}」` : '（本文なし）',
    count > 1 ? `この相手からの受信 ${count} 件（最新: ${msg.sentAt ? fmtJst(msg.sentAt) : '不明'}）` : msg.sentAt ? `受信: ${fmtJst(msg.sentAt)}` : '',
    '依頼者か事件の関係者に紐付けると、以後の受信と添付ファイルが自動で振り分けられます。',
  ].filter(Boolean);
  return {
    title: `${CHANNEL_LABEL[id.channel] ?? id.channel}: ${who}${msg.subject && id.channel === 'gmail' ? `「${msg.subject}」` : ''}`,
    body: lines.join('\n'),
    payload: { conversationId, identity: id, displayName: name, preview, sentAt: msg.sentAt ?? null, subject: msg.subject ?? null, channel: id.channel, messageCount: count },
  };
}

/**
 * 旧形式（相手や本文の抜粋が無い）の未紐付け警告を、会話の最新の受信から作り直す。
 * 起動時に 1 回だけ呼ぶ（すでに要確認に並んでいるものを新しい表示にするため）
 */
export function refreshUnlinkedAlerts(): number {
  const d = db();
  const open = d.select().from(schema.alerts).where(and(eq(schema.alerts.status, 'open'), eq(schema.alerts.type, 'unlinked_contact'))).all();
  let n = 0;
  for (const a of open) {
    const p = a.payload as { conversationId?: number; identity?: IdentityHint; displayName?: string | null; preview?: string };
    if (p.preview !== undefined || !p.conversationId) continue;
    const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, p.conversationId)).get();
    if (!conv) continue;
    // 識別子が無い古い警告は会話から補う
    const identity: IdentityHint = p.identity ?? {
      channel: conv.channel as IdentityHint['channel'],
      email: conv.channel === 'gmail' ? conv.counterpartAddress : null,
      lineUserId: conv.channel === 'line' ? conv.externalThreadId : null,
      chatworkRoomId: conv.channel === 'chatwork' ? Number(conv.externalThreadId) || null : null,
    };
    const last = d
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conv.id), eq(schema.messages.direction, 'in')))
      .orderBy(desc(schema.messages.sentAt))
      .limit(1)
      .get();
    // 件数は数え直さず 1 として、その警告自体を書き換える
    const built = buildUnlinkedAlert(conv.id, identity, conv.counterpartName ?? p.displayName, { body: last?.body ?? null, sentAt: last?.sentAt ?? null, subject: conv.subject }, 1);
    d.update(schema.alerts).set({ title: built.title, body: built.body, payload: { ...p, ...built.payload } }).where(eq(schema.alerts.id, a.id)).run();
    n++;
  }
  return n;
}

function fmtJst(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  if (Number.isNaN(d.getTime())) return iso;
  const wd = ['日', '月', '火', '水', '木', '金', '土'][d.getUTCDay()];
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${wd}) ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** 会話を依頼者に紐付け、識別子を依頼者にも学習させる */
export function linkConversationToClient(conversationId: number, clientId: number) {
  const conv = db().select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get();
  if (!conv) throw new Error('会話が見つかりません');
  const client = db().select().from(schema.clients).where(eq(schema.clients.id, clientId)).get();
  if (!client) throw new Error('依頼者が見つかりません');
  db().update(schema.conversations).set({ clientId }).where(eq(schema.conversations.id, conversationId)).run();
  const patch: Partial<typeof schema.clients.$inferInsert> = {};
  if (conv.channel === 'gmail' && conv.counterpartAddress && !client.emails.includes(conv.counterpartAddress)) {
    patch.emails = [...client.emails, conv.counterpartAddress];
  }
  if (conv.channel === 'line' && !client.lineUserId) patch.lineUserId = conv.externalThreadId;
  if (conv.channel === 'chatwork' && !client.chatworkRoomId) patch.chatworkRoomId = Number(conv.externalThreadId);
  if (conv.channel === 'chatwork' && !client.chatworkAccountId && conv.counterpartAddress) patch.chatworkAccountId = Number(conv.counterpartAddress);
  if (!client.preferredChannel) patch.preferredChannel = conv.channel;
  if (Object.keys(patch).length) db().update(schema.clients).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(schema.clients.id, clientId)).run();
  // 添付・メッセージにも反映
  const msgs = db().select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).all();
  for (const m of msgs) db().update(schema.attachments).set({ clientId }).where(eq(schema.attachments.messageId, m.id)).run();
  // 同一識別子の未紐付けアラートを解決
  const openAlerts = db().select().from(schema.alerts).where(eq(schema.alerts.status, 'open')).all();
  for (const a of openAlerts) {
    if (a.type === 'unlinked_contact' && (a.payload as { conversationId?: number }).conversationId === conversationId) {
      db().update(schema.alerts).set({ status: 'resolved', resolvedAt: new Date().toISOString() }).where(eq(schema.alerts.id, a.id)).run();
    }
  }
  return conv;
}

export function searchClients(q: string) {
  const pat = `%${q}%`;
  return db()
    .select()
    .from(schema.clients)
    .where(or(like(schema.clients.name, pat), like(schema.clients.kana, pat)))
    .all();
}
