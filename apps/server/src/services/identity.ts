import { eq, or, like } from 'drizzle-orm';
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

export function raiseUnlinkedContact(conversationId: number, id: IdentityHint, displayName: string | null | undefined) {
  const key = `unlinked:${id.channel}:${id.email ?? id.lineUserId ?? id.chatworkRoomId ?? id.chatworkAccountId ?? conversationId}`;
  const who = displayName ?? id.email ?? id.lineUserId ?? String(id.chatworkRoomId ?? '');
  upsertAlert({
    type: 'unlinked_contact',
    dedupeKey: key,
    title: `未紐付けの連絡先: ${who}（${id.channel}）`,
    body: '依頼者に紐付けると、以後の受信と添付ファイルが自動で振り分けられます。',
    payload: { conversationId, identity: id, displayName: displayName ?? null },
  });
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
