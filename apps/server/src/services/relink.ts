import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

type ConversationRow = typeof schema.conversations.$inferSelect;

/** 会話の相手の識別子（その会話の相手のメールアドレス・LINE ID・Chatwork のルームやアカウント） */
function identityOf(conv: ConversationRow) {
  const addr = conv.counterpartAddress?.trim() || null;
  return {
    email: conv.channel === 'gmail' && addr ? addr.toLowerCase() : null,
    // LINE のグループの ID は人の ID ではない（U で始まるのが個人）
    lineUserId: conv.channel === 'line' && conv.externalThreadId.startsWith('U') ? conv.externalThreadId : null,
    chatworkRoomId: conv.channel === 'chatwork' ? Number(conv.externalThreadId) || null : null,
    chatworkAccountId: conv.channel === 'chatwork' && addr && /^\d+$/.test(addr) ? Number(addr) : null,
  };
}

/**
 * 会話の紐付けを別の相手に付け替えるとき、前の相手（事件の関係者・依頼者・依頼者の窓口）から、
 * この会話の相手のメールアドレス・LINE ID などを外す。
 * 外さないと、次に同じアドレスから届いた連絡が、また前の相手に自動で紐付いてしまう。
 * next には付け替え先を渡す（同じ相手のままなら何もしない）
 */
export function detachConversationIdentity(conv: ConversationRow, next: { contactId?: number | null; clientId?: number | null }) {
  const d = db();
  const id = identityOf(conv);
  const now = new Date().toISOString();
  // 前が関係者で、別の関係者・依頼者に付け替える
  if (conv.contactId && conv.contactId !== (next.contactId ?? null)) {
    const k = d.select().from(schema.caseContacts).where(eq(schema.caseContacts.id, conv.contactId)).get();
    if (k) {
      const patch: Partial<typeof schema.caseContacts.$inferInsert> = {};
      if (id.email && k.emails.some((e) => e.toLowerCase() === id.email)) patch.emails = k.emails.filter((e) => e.toLowerCase() !== id.email);
      if (id.lineUserId && k.lineUserId === id.lineUserId) patch.lineUserId = null;
      if (id.chatworkAccountId && k.chatworkAccountId === id.chatworkAccountId) patch.chatworkAccountId = null;
      if (Object.keys(patch).length) d.update(schema.caseContacts).set({ ...patch, updatedAt: now }).where(eq(schema.caseContacts.id, k.id)).run();
    }
  }
  // 前が依頼者本人（または窓口）の会話で、関係者や別の依頼者に付け替える
  const leavingClient = !conv.contactId && conv.clientId && (next.contactId || (next.clientId ?? null) !== conv.clientId);
  if (!leavingClient) return;
  const c = d.select().from(schema.clients).where(eq(schema.clients.id, conv.clientId!)).get();
  if (c) {
    const patch: Partial<typeof schema.clients.$inferInsert> = {};
    if (id.email && c.emails.some((e) => e.toLowerCase() === id.email)) patch.emails = c.emails.filter((e) => e.toLowerCase() !== id.email);
    if (id.lineUserId && c.lineUserId === id.lineUserId) patch.lineUserId = null;
    if (id.chatworkRoomId && c.chatworkRoomId === id.chatworkRoomId) patch.chatworkRoomId = null;
    if (id.chatworkAccountId && c.chatworkAccountId === id.chatworkAccountId) patch.chatworkAccountId = null;
    if (Object.keys(patch).length) d.update(schema.clients).set({ ...patch, updatedAt: now }).where(eq(schema.clients.id, c.id)).run();
  }
  if (conv.clientPersonId) {
    const p = d.select().from(schema.clientPersons).where(eq(schema.clientPersons.id, conv.clientPersonId)).get();
    if (p) {
      const patch: Partial<typeof schema.clientPersons.$inferInsert> = {};
      if (id.email && p.emails.some((e) => e.toLowerCase() === id.email)) patch.emails = p.emails.filter((e) => e.toLowerCase() !== id.email);
      if (id.lineUserId && p.lineUserId === id.lineUserId) patch.lineUserId = null;
      if (id.chatworkRoomId && p.chatworkRoomId === id.chatworkRoomId) patch.chatworkRoomId = null;
      if (id.chatworkAccountId && p.chatworkAccountId === id.chatworkAccountId) patch.chatworkAccountId = null;
      if (Object.keys(patch).length) d.update(schema.clientPersons).set({ ...patch, updatedAt: now }).where(eq(schema.clientPersons.id, p.id)).run();
    }
  }
}
