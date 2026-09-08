import { eq, and, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { IdentityHint } from '../channels/types.js';
import { CASE_CONTACT_ROLE_LABEL, type CaseContactInput, type CaseContactRole } from '@lcm/shared';

export type ContactRow = typeof schema.caseContacts.$inferSelect;

export function contactRoleLabel(role: string): string {
  return CASE_CONTACT_ROLE_LABEL[role as CaseContactRole] ?? role;
}

function normEmails(list: string[] | undefined): string[] {
  return [...new Set((list ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];
}

export function listContacts(caseId: number): ContactRow[] {
  return db().select().from(schema.caseContacts).where(eq(schema.caseContacts.caseId, caseId)).orderBy(schema.caseContacts.role, schema.caseContacts.name).all();
}

export function getContact(id: number): ContactRow | null {
  return db().select().from(schema.caseContacts).where(eq(schema.caseContacts.id, id)).get() ?? null;
}

export function createContact(caseId: number, input: CaseContactInput): ContactRow {
  const kase = db().select().from(schema.cases).where(eq(schema.cases.id, caseId)).get();
  if (!kase) throw new Error('事件が見つかりません');
  return db()
    .insert(schema.caseContacts)
    .values({
      caseId,
      role: input.role,
      name: input.name.trim(),
      kana: input.kana?.trim() || null,
      organization: input.organization?.trim() || null,
      emails: normEmails(input.emails),
      lineUserId: input.lineUserId?.trim() || null,
      chatworkAccountId: input.chatworkAccountId ?? null,
      phone: input.phone?.trim() || null,
      note: input.note?.trim() || null,
    })
    .returning()
    .get();
}

export function updateContact(id: number, patch: Partial<CaseContactInput>): ContactRow {
  const set: Partial<typeof schema.caseContacts.$inferInsert> = { updatedAt: new Date().toISOString() };
  if (patch.role !== undefined) set.role = patch.role;
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.kana !== undefined) set.kana = patch.kana?.trim() || null;
  if (patch.organization !== undefined) set.organization = patch.organization?.trim() || null;
  if (patch.emails !== undefined) set.emails = normEmails(patch.emails);
  if (patch.lineUserId !== undefined) set.lineUserId = patch.lineUserId?.trim() || null;
  if (patch.chatworkAccountId !== undefined) set.chatworkAccountId = patch.chatworkAccountId ?? null;
  if (patch.phone !== undefined) set.phone = patch.phone?.trim() || null;
  if (patch.note !== undefined) set.note = patch.note?.trim() || null;
  db().update(schema.caseContacts).set(set).where(eq(schema.caseContacts.id, id)).run();
  const row = getContact(id);
  if (!row) throw new Error('関係者が見つかりません');
  return row;
}

/** 関係者を削除。紐付いていた会話は関係者の紐付けだけ外す（依頼者・事件への紐付けは残す） */
export function deleteContact(id: number) {
  db().update(schema.conversations).set({ contactId: null }).where(eq(schema.conversations.contactId, id)).run();
  db().delete(schema.caseContacts).where(eq(schema.caseContacts.id, id)).run();
}

/** 受信した相手の識別子（メール・LINE ID・Chatwork アカウント）に一致する関係者。終了事件の関係者は後回し */
export function findContactByIdentity(id: IdentityHint): { contact: ContactRow; kase: typeof schema.cases.$inferSelect } | null {
  const all = db()
    .select({ contact: schema.caseContacts, kase: schema.cases })
    .from(schema.caseContacts)
    .innerJoin(schema.cases, eq(schema.cases.id, schema.caseContacts.caseId))
    .all();
  const hits = all.filter(({ contact }) => {
    if (id.channel === 'gmail' && id.email) return contact.emails.includes(id.email.toLowerCase());
    if (id.channel === 'line' && id.lineUserId) return contact.lineUserId === id.lineUserId;
    if (id.channel === 'chatwork' && id.chatworkAccountId) return contact.chatworkAccountId === id.chatworkAccountId;
    return false;
  });
  if (hits.length === 0) return null;
  // 進行中の事件を優先し、同順なら更新が新しい事件
  return hits.sort((a, b) => Number(b.kase.status !== 'closed') - Number(a.kase.status !== 'closed') || b.kase.updatedAt.localeCompare(a.kase.updatedAt))[0];
}

/**
 * 会話を事件の関係者として紐付ける。
 * 会話は事件・その依頼者にも紐付くが、依頼者の連絡先（メール・LINE ID）は書き換えない。
 * 会話の相手の識別子は関係者側に登録する。
 */
export function linkConversationToContact(conversationId: number, contactId: number) {
  const d = db();
  const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get();
  if (!conv) throw new Error('会話が見つかりません');
  const contact = getContact(contactId);
  if (!contact) throw new Error('関係者が見つかりません');
  const kase = d.select().from(schema.cases).where(eq(schema.cases.id, contact.caseId)).get();
  if (!kase) throw new Error('事件が見つかりません');
  d.update(schema.conversations).set({ contactId: contact.id, caseId: kase.id, clientId: kase.clientId }).where(eq(schema.conversations.id, conversationId)).run();
  const patch: Partial<typeof schema.caseContacts.$inferInsert> = {};
  if (conv.channel === 'gmail' && conv.counterpartAddress) {
    const e = conv.counterpartAddress.toLowerCase();
    if (!contact.emails.includes(e)) patch.emails = [...contact.emails, e];
  }
  if (conv.channel === 'line' && !contact.lineUserId) patch.lineUserId = conv.externalThreadId;
  if (conv.channel === 'chatwork' && !contact.chatworkAccountId && conv.counterpartAddress && /^\d+$/.test(conv.counterpartAddress)) patch.chatworkAccountId = Number(conv.counterpartAddress);
  if (Object.keys(patch).length) d.update(schema.caseContacts).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(schema.caseContacts.id, contact.id)).run();
  // メッセージ・添付にも反映
  d.update(schema.messages).set({ clientId: kase.clientId, caseId: kase.id }).where(eq(schema.messages.conversationId, conversationId)).run();
  const msgIds = d.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).all().map((m) => m.id);
  if (msgIds.length) d.update(schema.attachments).set({ clientId: kase.clientId }).where(inArray(schema.attachments.messageId, msgIds)).run();
  resolveUnlinkedAlerts(conversationId);
  return { conversation: { ...conv, contactId: contact.id, caseId: kase.id, clientId: kase.clientId }, contact: { ...contact, ...patch }, kase };
}

/** 会話の紐付け（依頼者・事件・関係者）をすべて外す。依頼者・関係者の連絡先は変更しない */
export function unlinkConversation(conversationId: number) {
  const d = db();
  const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get();
  if (!conv) throw new Error('会話が見つかりません');
  d.update(schema.conversations).set({ clientId: null, caseId: null, contactId: null }).where(eq(schema.conversations.id, conversationId)).run();
  d.update(schema.messages).set({ clientId: null, caseId: null }).where(eq(schema.messages.conversationId, conversationId)).run();
  const msgIds = d.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).all().map((m) => m.id);
  // 保存済みの添付はフォルダに入っているので触らない。未保存のものだけ依頼者を外す
  if (msgIds.length) {
    d.update(schema.attachments)
      .set({ clientId: null })
      .where(and(inArray(schema.attachments.messageId, msgIds), inArray(schema.attachments.status, ['held', 'pending', 'failed', 'unassigned'])))
      .run();
  }
  return { ...conv, clientId: null, caseId: null, contactId: null };
}

function resolveUnlinkedAlerts(conversationId: number) {
  const open = db().select().from(schema.alerts).where(and(eq(schema.alerts.status, 'open'), eq(schema.alerts.type, 'unlinked_contact'))).all();
  for (const a of open) {
    if ((a.payload as { conversationId?: number }).conversationId === conversationId) {
      db().update(schema.alerts).set({ status: 'resolved', resolvedAt: new Date().toISOString() }).where(eq(schema.alerts.id, a.id)).run();
    }
  }
}

/** 会話一覧・詳細に添える関係者情報 */
export interface ContactBrief {
  id: number;
  name: string;
  role: string;
  roleLabel: string;
  organization: string | null;
  caseId: number;
  caseTitle: string;
}

export function contactBriefs(contactIds: number[]): Map<number, ContactBrief> {
  const ids = [...new Set(contactIds.filter((x): x is number => !!x))];
  if (ids.length === 0) return new Map();
  const rows = db()
    .select({ contact: schema.caseContacts, caseTitle: schema.cases.title })
    .from(schema.caseContacts)
    .innerJoin(schema.cases, eq(schema.cases.id, schema.caseContacts.caseId))
    .where(inArray(schema.caseContacts.id, ids))
    .all();
  return new Map(rows.map((r) => [r.contact.id, { id: r.contact.id, name: r.contact.name, role: r.contact.role, roleLabel: contactRoleLabel(r.contact.role), organization: r.contact.organization, caseId: r.contact.caseId, caseTitle: r.caseTitle }]));
}

/** 依頼者本人との会話だけを返す（関係者・事務局の会話を除く）。期日報告など依頼者宛の送信先を選ぶときに使う */
export function clientOwnConversations(clientId: number) {
  return db()
    .select()
    .from(schema.conversations)
    .where(and(eq(schema.conversations.clientId, clientId), isNull(schema.conversations.contactId)))
    .all()
    .filter((c) => !(c.meta as { staff?: boolean }).staff);
}
