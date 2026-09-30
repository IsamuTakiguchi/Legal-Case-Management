import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { isConfigured } from '../config.js';
import { generateStructured } from '../integrations/anthropic.js';
import { CASE_CONTACT_ROLES, parseContactMemo, parseJaDate, type ContactMemo, type MemoContact } from '@lcm/shared';
import { createContact, listContacts, updateContact } from './contacts.js';
import { updateCase } from './cases.js';

const aiSchema = z.object({
  accidentDateText: z.string().nullable().describe('事故日として書かれている文字そのまま（例: R5.9.10）。無ければ null'),
  accidentDate: z.string().nullable().describe('事故日を西暦 YYYY-MM-DD にしたもの。無ければ null'),
  contacts: z.array(
    z.object({
      role: z.enum(CASE_CONTACT_ROLES).describe('opponent=相手方本人, opponent_counsel=相手方代理人, opponent_insurer=相手方の保険会社, client_insurer=依頼者側の保険会社, court=裁判所, insurer=どちら側か分からない保険会社, other=その他'),
      organization: z.string().nullable().describe('会社名・事務所名'),
      department: z.string().nullable().describe('担当の区分（物損・人損など）'),
      name: z.string().describe('担当者名。個人名が無ければ会社名'),
      phone: z.string().nullable(),
      fax: z.string().nullable(),
      emails: z.array(z.string()),
    }),
  ),
});

/**
 * 貼り付けたメモから事故日と連絡先を読み取る。
 * 決まった書き方（「事故日：」「依頼者側保険会社」「TEL:」など）は規則で読む（AI を使わず、すぐ・無料）。
 * 規則で何も読めず AI が使えるときだけ AI に読ませる
 */
export async function readContactMemo(text: string): Promise<ContactMemo & { by: 'rule' | 'ai' }> {
  const rule = parseContactMemo(text);
  if (rule.contacts.length || rule.accidentDate || !isConfigured('anthropic')) return { ...rule, by: 'rule' };
  const r = await generateStructured({
    system: '法律事務所の事件管理で使います。貼り付けられたメモから、事故日と、保険会社・相手方などの連絡先（担当者・電話・FAX・メール）を読み取ってください。書かれていないことは null にし、推測で埋めないでください。',
    user: text,
    schema: aiSchema,
    tier: 'light',
    effort: 'low',
    purpose: '連絡先メモの読み取り',
  });
  return {
    accidentDate: parseJaDate(r.accidentDateText) ?? parseJaDate(r.accidentDate),
    accidentDateText: r.accidentDateText,
    contacts: r.contacts.filter((c) => c.name.trim()).map((c) => ({ ...c, emails: c.emails.filter((e) => e.includes('@')) })),
    by: 'ai',
  };
}

const norm = (s: string | null | undefined) => (s ?? '').normalize('NFKC').replace(/\s+/g, '');

/**
 * 読み取った内容を事件に登録する。
 * 同じ会社・同じ担当者（区分も同じ）が登録済みなら新しく作らず、空いている電話・FAX・メールだけ補う
 */
export function importContactMemo(caseId: number, input: { accidentDate?: string | null; contacts: MemoContact[] }) {
  const kase = db().select().from(schema.cases).where(eq(schema.cases.id, caseId)).get();
  if (!kase) throw new Error('事件が見つかりません');
  if (input.accidentDate) {
    const iso = parseJaDate(input.accidentDate);
    if (!iso) throw new Error(`事故日「${input.accidentDate}」を日付として読めません`);
    if (iso !== kase.accidentDate) updateCase(caseId, { accidentDate: iso });
  }
  let created = 0;
  let updated = 0;
  const existing = listContacts(caseId);
  for (const c of input.contacts) {
    if (!c.name.trim()) continue;
    const same = existing.find((x) => norm(x.name) === norm(c.name) && norm(x.organization) === norm(c.organization) && norm(x.department) === norm(c.department));
    if (same) {
      const patch: Parameters<typeof updateContact>[1] = {};
      if (!same.phone && c.phone) patch.phone = c.phone;
      if (!same.fax && c.fax) patch.fax = c.fax;
      const emails = [...new Set([...same.emails, ...c.emails.map((e) => e.trim().toLowerCase())])];
      if (emails.length !== same.emails.length) patch.emails = emails;
      if ((same.role === 'insurer' || same.role === 'other') && c.role !== same.role && c.role !== 'other') patch.role = c.role;
      if (Object.keys(patch).length) {
        updateContact(same.id, patch);
        updated++;
      }
      continue;
    }
    existing.push(createContact(caseId, { ...c, kana: null, lineUserId: null, chatworkAccountId: null, note: null }));
    created++;
  }
  return { created, updated, accidentDate: db().select().from(schema.cases).where(eq(schema.cases.id, caseId)).get()!.accidentDate };
}
