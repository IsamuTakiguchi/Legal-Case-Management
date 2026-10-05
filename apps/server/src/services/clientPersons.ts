import { and, eq, inArray, ne } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { ClientPersonInput } from '@lcm/shared';
import type { IdentityHint } from '../channels/types.js';

/**
 * 法人の依頼者の担当者（代表者とは別の窓口になる社員など）。
 * 担当者ごとにメール・電話・LINE・Chatwork を持ち、届いた連絡はその法人の連絡として扱う。
 * 主担当は、期日連絡などで依頼者に連絡するときの既定の宛先になる
 */
export type ClientPersonRow = typeof schema.clientPersons.$inferSelect;

export function listClientPersons(clientId: number): ClientPersonRow[] {
  return db()
    .select()
    .from(schema.clientPersons)
    .where(eq(schema.clientPersons.clientId, clientId))
    .all()
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.id - b.id);
}

export function getClientPerson(id: number): ClientPersonRow | null {
  return db().select().from(schema.clientPersons).where(eq(schema.clientPersons.id, id)).get() ?? null;
}

function clean(input: Partial<ClientPersonInput>) {
  const out: Partial<typeof schema.clientPersons.$inferInsert> = {};
  if (input.name !== undefined) out.name = input.name.trim();
  if (input.kana !== undefined) out.kana = input.kana?.trim() || null;
  if (input.title !== undefined) out.title = input.title?.trim() || null;
  if (input.emails !== undefined) out.emails = [...new Set(input.emails.map((e) => e.trim()).filter(Boolean))];
  if (input.phones !== undefined) out.phones = [...new Set(input.phones.map((e) => e.trim()).filter(Boolean))];
  if (input.lineUserId !== undefined) out.lineUserId = input.lineUserId?.trim() || null;
  if (input.chatworkAccountId !== undefined) out.chatworkAccountId = input.chatworkAccountId ?? null;
  if (input.chatworkRoomId !== undefined) out.chatworkRoomId = input.chatworkRoomId ?? null;
  if (input.primary !== undefined) out.primary = input.primary;
  if (input.note !== undefined) out.note = input.note?.trim() || null;
  return out;
}

/** 主担当は 1 人だけ（ほかの担当者の主担当を外す） */
function clearOtherPrimary(clientId: number, keepId: number) {
  db()
    .update(schema.clientPersons)
    .set({ primary: false })
    .where(and(eq(schema.clientPersons.clientId, clientId), ne(schema.clientPersons.id, keepId), eq(schema.clientPersons.primary, true)))
    .run();
}

export function createClientPerson(clientId: number, input: ClientPersonInput): ClientPersonRow {
  const client = db().select().from(schema.clients).where(eq(schema.clients.id, clientId)).get();
  if (!client) throw new Error('依頼者が見つかりません');
  // 最初の担当者は主担当にする
  const first = listClientPersons(clientId).length === 0;
  const row = db()
    .insert(schema.clientPersons)
    .values({ ...clean(input), name: input.name.trim(), clientId, primary: input.primary ?? first })
    .returning()
    .get();
  if (row.primary) clearOtherPrimary(clientId, row.id);
  return row;
}

export function updateClientPerson(id: number, input: Partial<ClientPersonInput>): ClientPersonRow {
  const cur = getClientPerson(id);
  if (!cur) throw new Error('担当者が見つかりません');
  const row = db()
    .update(schema.clientPersons)
    .set({ ...clean(input), updatedAt: new Date().toISOString() })
    .where(eq(schema.clientPersons.id, id))
    .returning()
    .get();
  if (row.primary) clearOtherPrimary(row.clientId, row.id);
  return row;
}

/** 担当者を削除する（その担当者との会話は依頼者の会話として残す） */
export function deleteClientPerson(id: number): boolean {
  const cur = getClientPerson(id);
  if (!cur) return false;
  db().transaction((tx) => {
    tx.update(schema.conversations).set({ clientPersonId: null }).where(eq(schema.conversations.clientPersonId, id)).run();
    tx.delete(schema.clientPersons).where(eq(schema.clientPersons.id, id)).run();
  });
  return true;
}

/** 依頼者を削除するときに、その担当者もまとめて消す（会話の担当者の紐付けは外す） */
export function deletePersonsOfClient(clientId: number) {
  const ids = db().select({ id: schema.clientPersons.id }).from(schema.clientPersons).where(eq(schema.clientPersons.clientId, clientId)).all().map((r) => r.id);
  if (!ids.length) return;
  db().update(schema.conversations).set({ clientPersonId: null }).where(inArray(schema.conversations.clientPersonId, ids)).run();
  db().delete(schema.clientPersons).where(inArray(schema.clientPersons.id, ids)).run();
}

/**
 * 届いた連絡の送り主が、どこかの依頼者（アーカイブしていないもの）の担当者か。
 * thread=true は「その会話が担当者との会話か」を見る（Chatwork はアカウントでなくルームで判断する。
 * 依頼者のグループルームで担当者が発言しても、ルームそのものは担当者との会話ではないため）
 */
export function findPersonByIdentity(id: IdentityHint, opts: { thread?: boolean } = {}): ClientPersonRow | null {
  const live = new Set(
    db()
      .select({ id: schema.clients.id })
      .from(schema.clients)
      .where(eq(schema.clients.archived, false))
      .all()
      .map((r) => r.id),
  );
  const all = db().select().from(schema.clientPersons).all().filter((p) => live.has(p.clientId));
  if (id.channel === 'gmail' && id.email) {
    const e = id.email.toLowerCase();
    return all.find((p) => p.emails.some((x) => x.toLowerCase() === e)) ?? null;
  }
  if (id.channel === 'line' && id.lineUserId) return all.find((p) => p.lineUserId === id.lineUserId) ?? null;
  if (id.channel === 'chatwork') {
    if (id.chatworkRoomId) {
      const byRoom = all.find((p) => p.chatworkRoomId === id.chatworkRoomId);
      if (byRoom) return byRoom;
    }
    if (id.chatworkAccountId && !opts.thread) return all.find((p) => p.chatworkAccountId === id.chatworkAccountId) ?? null;
  }
  return null;
}

/**
 * 会話の相手を、法人の担当者に決める（personId=null は「会社・代表として」に戻す）。
 * newPerson を渡すとその場で担当者を登録する。
 * 会話の連絡先（メールアドレス・LINE・Chatwork ルーム）は担当者のものとして覚え、
 * 依頼者本人の連絡先として覚えていた分は外す（会社宛の連絡が担当者個人に行かないように）
 */
export function setConversationPerson(conversationId: number, input: { personId?: number | null; newPerson?: { name: string; title?: string | null } | null }) {
  const d = db();
  const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get();
  if (!conv) throw new Error('会話が見つかりません');
  if (!conv.clientId) throw new Error('先に依頼者に紐付けてください');
  if (conv.contactId) throw new Error('事件の関係者との会話は、担当者にできません');
  const client = d.select().from(schema.clients).where(eq(schema.clients.id, conv.clientId)).get();
  if (!client) throw new Error('依頼者が見つかりません');
  let person: ClientPersonRow | null = null;
  if (input.newPerson) {
    person = createClientPerson(client.id, { name: input.newPerson.name, title: input.newPerson.title ?? null, emails: [], phones: [] });
  } else if (input.personId) {
    person = getClientPerson(input.personId);
    if (!person || person.clientId !== client.id) throw new Error('この依頼者の担当者ではありません');
  }
  return d.transaction((tx) => {
    tx.update(schema.conversations).set({ clientPersonId: person?.id ?? null }).where(eq(schema.conversations.id, conversationId)).run();
    if (!person) return { conversationId, person: null };
    const addr = conv.counterpartAddress;
    const personPatch: Partial<typeof schema.clientPersons.$inferInsert> = {};
    const clientPatch: Partial<typeof schema.clients.$inferInsert> = {};
    if (conv.channel === 'gmail' && addr) {
      if (!person.emails.some((e) => e.toLowerCase() === addr.toLowerCase())) personPatch.emails = [...person.emails, addr];
      if (client.emails.some((e) => e.toLowerCase() === addr.toLowerCase())) clientPatch.emails = client.emails.filter((e) => e.toLowerCase() !== addr.toLowerCase());
    }
    if (conv.channel === 'line' && conv.externalThreadId.startsWith('U')) {
      if (!person.lineUserId) personPatch.lineUserId = conv.externalThreadId;
      if (client.lineUserId === conv.externalThreadId) clientPatch.lineUserId = null;
    }
    if (conv.channel === 'chatwork') {
      const room = Number(conv.externalThreadId) || null;
      if (room && !person.chatworkRoomId) personPatch.chatworkRoomId = room;
      if (room && client.chatworkRoomId === room) clientPatch.chatworkRoomId = null;
      const account = Number(addr) || null;
      if (account && !person.chatworkAccountId) personPatch.chatworkAccountId = account;
      if (account && client.chatworkAccountId === account) clientPatch.chatworkAccountId = null;
    }
    const now = new Date().toISOString();
    if (Object.keys(personPatch).length) tx.update(schema.clientPersons).set({ ...personPatch, updatedAt: now }).where(eq(schema.clientPersons.id, person.id)).run();
    if (Object.keys(clientPatch).length) tx.update(schema.clients).set({ ...clientPatch, updatedAt: now }).where(eq(schema.clients.id, client.id)).run();
    return { conversationId, person: tx.select().from(schema.clientPersons).where(eq(schema.clientPersons.id, person.id)).get()! };
  });
}
