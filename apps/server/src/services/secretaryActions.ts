import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { agentTool, type AgentTool } from '../integrations/anthropic.js';
import {
  CASE_STATUSES,
  CASE_STATUS_LABEL,
  CASE_CONTACT_ROLES,
  CASE_CONTACT_ROLE_LABEL,
  EVENT_KINDS,
  EVENT_KIND_LABEL,
  TASK_STATUSES,
  TASK_STATUS_LABEL,
  ACTIVE_TASK_STATUSES,
  CHANNEL_LABEL,
  formatJaEventTime,
  familyName,
  messageLink,
  type CaseContactRole,
  type CaseStatus,
  type EventKind,
  type TaskStatus,
} from '@lcm/shared';
import { createCase, updateCase, getCase, listCaseTypes } from './cases.js';
import { createClientRecord, updateClientRecord } from './clientWrite.js';
import { createContact, updateContact, getContact, listContacts } from './contacts.js';
import { updateTask, deleteTask } from './tasks.js';
import { editCalendarEvent, removeCalendarEvent } from './court.js';
import { listStaff, createStaff, updateStaff } from './staff.js';
import { clientSendTargets, contactSendTargets, staffSendTargets, startClientConversation, startContactConversation, startRoomConversation } from './newMessage.js';
import { sendToConversation } from './send.js';
import { listClientPersons } from './clientPersons.js';

/**
 * AI 秘書が扱う「変更・作成・削除・送信」の案（記録・予定・タスクの追加以外）。
 * 案を出すところまでが秘書の仕事で、実行するのは弁護士が確かめて「この内容で登録」を押したときだけ。
 *
 * 変更の案は、変える項目だけを持つ（書いていない項目は変えない）。
 * 項目を空にするのは、clear に項目名を書いたときだけ（null や空文字を「変えない」と取り違えて消さないため）。
 */

const isoAt = z.string().describe('日時。日本時間で時差を付けた ISO（例 2026-10-03T14:00:00+09:00）');
const summary = z.string().describe('画面に出す一行の説明');

export const caseUpdateSchema = z.object({
  type: z.literal('case_update'),
  summary,
  caseId: z.number().int().describe('変える事件の ID（find_case で確かめたもの）'),
  title: z.string().optional().describe('事件名'),
  status: z.enum(CASE_STATUSES).optional().describe('区分: consultation=相談 / active=進行事件 / wrapup=残務処理 / closed=終了事件'),
  stage: z.string().optional().describe('現在の段階（例「第2回弁論準備」）'),
  caseType: z.string().optional().describe('事件類型のキー（list_staff_and_types で確かめたもの）'),
  courtName: z.string().optional(),
  caseNumber: z.string().optional(),
  staffId: z.number().int().optional().describe('担当事務局の ID（list_staff_and_types で確かめたもの）'),
  staffName: z.string().optional().describe('担当事務局の名前。ID がまだ無いとき（同じ案の中の staff_create で登録する人）だけ使う。登録のときに名前で事務局を探す'),
  policy: z.string().optional().describe('方針メモ（全文を置き換える）'),
  referrer: z.string().optional().describe('紹介者'),
  clear: z.array(z.enum(['staffId', 'stage', 'courtName', 'caseNumber', 'policy', 'referrer'])).optional().describe('空にする項目（担当事務局を外す、など）'),
});

export const caseCreateSchema = z.object({
  type: z.literal('case_create'),
  summary,
  clientId: z.number().int().describe('依頼者の ID（find_client で確かめたもの。新しい依頼者なら、先に client_create を入れ、その依頼者は登録の後で選び直してもらう）'),
  title: z.string().describe('事件名（例「山田 自己破産」）'),
  caseType: z.string().optional(),
  status: z.enum(CASE_STATUSES).optional(),
  courtName: z.string().optional(),
  caseNumber: z.string().optional(),
  staffId: z.number().int().optional(),
  staffName: z.string().optional().describe('担当事務局の名前（ID がまだ無いとき）'),
  referrer: z.string().optional(),
});

export const staffCreateSchema = z.object({
  type: z.literal('staff_create'),
  summary,
  name: z.string().describe('事務局メンバーの名前（例「藤田」「藤田 花子」）'),
  kana: z.string().optional().describe('ふりがな'),
});

export const clientCreateSchema = z.object({
  type: z.literal('client_create'),
  summary,
  name: z.string().describe('氏名・名称'),
  kana: z.string().optional().describe('ふりがな（ひらがな）'),
  entityType: z.enum(['individual', 'corporation']).optional(),
  phones: z.array(z.string()).optional(),
  emails: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

export const clientUpdateSchema = z.object({
  type: z.literal('client_update'),
  summary,
  clientId: z.number().int(),
  name: z.string().optional(),
  kana: z.string().optional(),
  addPhones: z.array(z.string()).optional().describe('足す電話番号'),
  removePhones: z.array(z.string()).optional().describe('外す電話番号'),
  addEmails: z.array(z.string()).optional().describe('足すメールアドレス'),
  removeEmails: z.array(z.string()).optional().describe('外すメールアドレス'),
  preferredChannel: z.enum(['gmail', 'line', 'chatwork']).optional().describe('連絡に使う手段'),
  notes: z.string().optional().describe('メモ（全文を置き換える）'),
});

export const contactCreateSchema = z.object({
  type: z.literal('contact_create'),
  summary,
  caseId: z.number().int(),
  role: z.enum(CASE_CONTACT_ROLES).describe('opponent=相手方 / opponent_counsel=相手方代理人 / opponent_insurer=相手方保険会社 / client_insurer=依頼者側保険会社 / court=裁判所 / insurer=保険会社 / other=その他'),
  name: z.string(),
  organization: z.string().optional().describe('所属（法律事務所・会社・裁判所の部など）'),
  emails: z.array(z.string()).optional(),
  phone: z.string().optional(),
  fax: z.string().optional(),
  note: z.string().optional(),
});

export const contactUpdateSchema = z.object({
  type: z.literal('contact_update'),
  summary,
  contactId: z.number().int().describe('変える関係者の ID（get_case で確かめたもの）'),
  role: z.enum(CASE_CONTACT_ROLES).optional(),
  name: z.string().optional(),
  organization: z.string().optional(),
  addEmails: z.array(z.string()).optional(),
  phone: z.string().optional(),
  fax: z.string().optional(),
  note: z.string().optional(),
});

export const taskUpdateSchema = z.object({
  type: z.literal('task_update'),
  summary,
  taskId: z.number().int().describe('変えるタスクの ID（find_tasks で確かめたもの）'),
  title: z.string().optional(),
  note: z.string().optional(),
  status: z.enum(TASK_STATUSES).optional().describe('open=対応中 / drafted=起案・検討完了 / waiting_client・waiting_other・waiting_staff=待ち / memo=時期未定 / done=完了'),
  dueAt: isoAt.optional().describe('締切'),
  followUpAt: isoAt.optional().describe('返事を待つ期限'),
  clear: z.array(z.enum(['dueAt', 'followUpAt', 'note'])).optional(),
});

export const taskDeleteSchema = z.object({ type: z.literal('task_delete'), summary, taskId: z.number().int() });

export const eventUpdateSchema = z.object({
  type: z.literal('event_update'),
  summary,
  eventId: z.number().int().describe('変える予定の ID（check_calendar で確かめたもの）'),
  title: z.string().optional(),
  startAt: isoAt.optional(),
  endAt: isoAt.optional(),
  kind: z.enum(EVENT_KINDS).optional(),
  location: z.string().optional(),
  tentative: z.boolean().optional().describe('仮押さえにするなら true、確定にするなら false'),
});

export const eventDeleteSchema = z.object({ type: z.literal('event_delete'), summary, eventId: z.number().int() });

export const messageSendSchema = z.object({
  type: z.literal('message_send'),
  summary,
  to: z.enum(['client', 'contact', 'staff']).describe('client=依頼者（窓口を含む） / contact=事件の関係者（相手方代理人など） / staff=事務局'),
  clientId: z.number().int().optional().describe('to=client のとき'),
  personId: z.number().int().optional().describe('依頼者の窓口・担当者宛のとき（get_client で確かめたもの）'),
  contactId: z.number().int().optional().describe('to=contact のとき'),
  staffId: z.number().int().optional().describe('to=staff のとき'),
  channel: z.enum(['gmail', 'line', 'chatwork']).describe('送る手段（get_client / get_case で送れると分かったもの。事務局は chatwork）'),
  subject: z.string().optional().describe('メールの件名（新しいメールにするとき）。空なら、その相手との最後のメールの続きにする'),
  text: z.string().describe('送る本文（弁護士本人から送る文）'),
  caseId: z.number().int().optional().describe('送った文を付ける事件'),
});

/**
 * 事務局へのチャットは、1 行目に誰の件か（依頼者の氏名）を書き、2 行目から本題を書く形にそろえる。
 * 例: 「吉堂さん（自己破産）について、本人から書類が届きましたので…」→「吉堂壱星\n本人から書類が届きましたので…」
 */
export function normalizeStaffMessage<T extends { type: string }>(a: T): T {
  if (a.type !== 'message_send') return a;
  const m = a as unknown as z.infer<typeof messageSendSchema>;
  if (m.to !== 'staff' || !m.text.trim()) return a;
  const d = db();
  const clientId = m.caseId ? (d.select({ clientId: schema.cases.clientId }).from(schema.cases).where(eq(schema.cases.id, m.caseId)).get()?.clientId ?? null) : (m.clientId ?? null);
  const client = clientId ? d.select({ name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, clientId)).get() : null;
  if (!client) return a;
  const squash = (x: string) => x.replace(/[\s　]+/g, '');
  const name = squash(client.name);
  const surname = squash(familyName(client.name));
  const lines = m.text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && !lines[0]!.trim()) lines.shift();
  // すでに 1 行目が氏名（「さん」「様」付きも）なら、そのまま
  if (squash(lines[0] ?? '').replace(/(さん|様|氏)$/, '') === name) return a;
  // 1 行目の頭の「吉堂さん（自己破産）について、」「吉堂壱星様の件で、」のような前置きは外す（氏名の行と重なるので）
  const lead = new RegExp(`^\\s*(${[name, surname].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[\\s　]*(さん|様|氏)?[\\s　]*([（(][^）)]*[）)])?[\\s　]*((の件について|について|の件で|の件)[、,：:\\s　]*|[、,：:]+[\\s　]*)`);
  const first = (lines[0] ?? '').replace(lead, '');
  const body = [first, ...lines.slice(1)].join('\n').replace(/^\n+/, '');
  return { ...a, text: `${name}\n${body}` };
}

export const extendedActionSchemas = [
  staffCreateSchema,
  caseUpdateSchema,
  caseCreateSchema,
  clientCreateSchema,
  clientUpdateSchema,
  contactCreateSchema,
  contactUpdateSchema,
  taskUpdateSchema,
  taskDeleteSchema,
  eventUpdateSchema,
  eventDeleteSchema,
  messageSendSchema,
] as const;

export type ExtendedAction =
  | z.infer<typeof staffCreateSchema>
  | z.infer<typeof caseUpdateSchema>
  | z.infer<typeof caseCreateSchema>
  | z.infer<typeof clientCreateSchema>
  | z.infer<typeof clientUpdateSchema>
  | z.infer<typeof contactCreateSchema>
  | z.infer<typeof contactUpdateSchema>
  | z.infer<typeof taskUpdateSchema>
  | z.infer<typeof taskDeleteSchema>
  | z.infer<typeof eventUpdateSchema>
  | z.infer<typeof eventDeleteSchema>
  | z.infer<typeof messageSendSchema>;

export const EXTENDED_TYPES = extendedActionSchemas.map((s) => s.shape.type.value) as ExtendedAction['type'][];

// ---- 名前を引く（画面の説明と、変更前の値に使う） ----

const nameOf = {
  staff: (id: number | null | undefined) => (id ? (db().select({ name: schema.staffMembers.name }).from(schema.staffMembers).where(eq(schema.staffMembers.id, id)).get()?.name ?? `ID ${id}`) : '（なし）'),
  caseType: (key: string | null | undefined) => (key ? (listCaseTypes().find((t) => t.key === key)?.label ?? key) : '（なし）'),
  case: (id: number) => {
    const k = getCase(id);
    return k ? `${k.client?.name ?? ''}／${k.title}` : `事件 ${id}`;
  },
  client: (id: number) => db().select({ name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, id)).get()?.name ?? `依頼者 ${id}`,
};

const squash = (s: string) => s.normalize('NFKC').replace(/[\s　]+/g, '').replace(/(さん|様|氏)$/, '');

/**
 * 名前から事務局メンバーを探す（空白・「さん」の違いは無視）。
 * 名前がそのまま一致する人 → 名前がその語で始まる人（「藤田」で「藤田 花子」）の順。1 人に決まらなければ null
 */
export function findStaffByName(name: string) {
  const q = squash(name);
  if (!q) return null;
  const all = db().select().from(schema.staffMembers).all();
  const exact = all.filter((s) => squash(s.name) === q);
  const pick = (list: typeof all) => list.find((s) => s.active) ?? list[0] ?? null;
  if (exact.length) return pick(exact);
  const prefix = all.filter((s) => squash(s.name).startsWith(q) || q.startsWith(squash(s.name)));
  const active = prefix.filter((s) => s.active);
  if (active.length === 1) return active[0]!;
  if (!active.length && prefix.length === 1) return prefix[0]!;
  return null;
}

/** 担当事務局を ID か名前で決める。名前のときは実行の時点で探す（同じ案で登録した人も見つかる） */
function resolveStaffId(a: { staffId?: number; staffName?: string }): number | undefined {
  if (a.staffId !== undefined) {
    if (!db().select().from(schema.staffMembers).where(eq(schema.staffMembers.id, a.staffId)).get()) throw new Error('担当事務局が見つかりません');
    return a.staffId;
  }
  if (a.staffName?.trim()) {
    const s = findStaffByName(a.staffName);
    if (!s) throw new Error(`事務局メンバー「${a.staffName}」が見つかりません（設定の「事務局メンバー」で登録するか、同じ案で「事務局の登録」を入れてください）`);
    return s.id;
  }
  return undefined;
}

/** 変更の一覧（項目・いま・変更後）。画面で「いま: …」と並べて見せる */
export interface Change {
  field: string;
  label: string;
  before: string;
  after: string;
}

const show = (v: unknown) => (v === undefined || v === null || v === '' ? '（なし）' : String(v));

/** 案の説明と、変更の一覧 */
export function previewExtended(a: ExtendedAction): { label: string; changes: Change[] } {
  const d = db();
  const ch: Change[] = [];
  const push = (field: string, label: string, before: unknown, after: unknown) => {
    if (show(before) !== show(after)) ch.push({ field, label, before: show(before), after: show(after) });
  };
  switch (a.type) {
    case 'staff_create': {
      const same = findStaffByName(a.name);
      return { label: same && squash(same.name) === squash(a.name) ? `事務局メンバーの登録: ${a.name}（すでに登録されています。登録のときは何もしません）` : `事務局メンバーの登録: ${a.name}`, changes: [] };
    }
    case 'case_update': {
      const k = d.select().from(schema.cases).where(eq(schema.cases.id, a.caseId)).get();
      if (!k) return { label: `事件の変更（事件 ${a.caseId} が見つかりません）`, changes: [] };
      const cl = new Set(a.clear ?? []);
      if (a.title !== undefined) push('title', '事件名', k.title, a.title);
      if (a.status !== undefined) push('status', '区分', CASE_STATUS_LABEL[k.status as CaseStatus], CASE_STATUS_LABEL[a.status]);
      if (a.stage !== undefined || cl.has('stage')) push('stage', '段階', k.stage, cl.has('stage') ? null : a.stage);
      if (a.caseType !== undefined) push('caseType', '事件類型', nameOf.caseType(k.caseType), nameOf.caseType(a.caseType));
      if (a.courtName !== undefined || cl.has('courtName')) push('courtName', '裁判所', k.courtName, cl.has('courtName') ? null : a.courtName);
      if (a.caseNumber !== undefined || cl.has('caseNumber')) push('caseNumber', '事件番号', k.caseNumber, cl.has('caseNumber') ? null : a.caseNumber);
      if (a.staffId !== undefined || a.staffName !== undefined || cl.has('staffId'))
        push(a.staffName !== undefined && a.staffId === undefined ? 'staffName' : 'staffId', '担当事務局', nameOf.staff(k.staffId), cl.has('staffId') ? '（なし）' : a.staffId !== undefined ? nameOf.staff(a.staffId) : (findStaffByName(a.staffName!)?.name ?? `${a.staffName}（登録のときに探します）`));
      if (a.policy !== undefined || cl.has('policy')) push('policy', '方針メモ', k.policy, cl.has('policy') ? null : a.policy);
      if (a.referrer !== undefined || cl.has('referrer')) push('referrer', '紹介者', k.referrer, cl.has('referrer') ? null : a.referrer);
      return { label: `事件の変更: ${nameOf.case(a.caseId)}`, changes: ch };
    }
    case 'case_create':
      return {
        label: `事件の新規登録: ${nameOf.client(a.clientId)}／${a.title}`,
        changes: [
          ...(a.caseType ? [{ field: 'caseType', label: '事件類型', before: '', after: nameOf.caseType(a.caseType) }] : []),
          ...(a.status ? [{ field: 'status', label: '区分', before: '', after: CASE_STATUS_LABEL[a.status] }] : []),
          ...(a.staffId ? [{ field: 'staffId', label: '担当事務局', before: '', after: nameOf.staff(a.staffId) }] : []),
          ...(!a.staffId && a.staffName ? [{ field: 'staffName', label: '担当事務局', before: '', after: findStaffByName(a.staffName)?.name ?? `${a.staffName}（登録のときに探します）` }] : []),
        ],
      };
    case 'client_create':
      return { label: `依頼者の新規登録: ${a.name}`, changes: [] };
    case 'client_update': {
      const c = d.select().from(schema.clients).where(eq(schema.clients.id, a.clientId)).get();
      if (!c) return { label: `依頼者の変更（依頼者 ${a.clientId} が見つかりません）`, changes: [] };
      if (a.name !== undefined) push('name', '氏名', c.name, a.name);
      if (a.kana !== undefined) push('kana', 'ふりがな', c.kana, a.kana);
      if (a.addPhones?.length || a.removePhones?.length) push('phones', '電話番号', (c.phones ?? []).join('、'), mergeList(c.phones ?? [], a.addPhones, a.removePhones).join('、'));
      if (a.addEmails?.length || a.removeEmails?.length) push('emails', 'メール', c.emails.join('、'), mergeList(c.emails, a.addEmails, a.removeEmails, true).join('、'));
      if (a.preferredChannel !== undefined) push('preferredChannel', '連絡手段', c.preferredChannel ? CHANNEL_LABEL[c.preferredChannel as 'gmail'] : null, CHANNEL_LABEL[a.preferredChannel]);
      if (a.notes !== undefined) push('notes', 'メモ', c.notes, a.notes);
      return { label: `依頼者の変更: ${c.name}`, changes: ch };
    }
    case 'contact_create':
      return { label: `関係者の追加: ${nameOf.case(a.caseId)} の${CASE_CONTACT_ROLE_LABEL[a.role]} ${a.organization ? `${a.organization} ` : ''}${a.name}`, changes: [] };
    case 'contact_update': {
      const k = getContact(a.contactId);
      if (!k) return { label: `関係者の変更（関係者 ${a.contactId} が見つかりません）`, changes: [] };
      if (a.role !== undefined) push('role', '立場', CASE_CONTACT_ROLE_LABEL[k.role as CaseContactRole], CASE_CONTACT_ROLE_LABEL[a.role]);
      if (a.name !== undefined) push('name', '名前', k.name, a.name);
      if (a.organization !== undefined) push('organization', '所属', k.organization, a.organization);
      if (a.addEmails?.length) push('emails', 'メール', k.emails.join('、'), mergeList(k.emails, a.addEmails, [], true).join('、'));
      if (a.phone !== undefined) push('phone', '電話', k.phone, a.phone);
      if (a.fax !== undefined) push('fax', 'FAX', k.fax, a.fax);
      if (a.note !== undefined) push('note', 'メモ', k.note, a.note);
      return { label: `関係者の変更: ${k.name}`, changes: ch };
    }
    case 'task_update': {
      const t = d.select().from(schema.tasks).where(eq(schema.tasks.id, a.taskId)).get();
      if (!t) return { label: `タスクの変更（タスク ${a.taskId} が見つかりません）`, changes: [] };
      const cl = new Set(a.clear ?? []);
      if (a.status !== undefined) push('status', '状態', TASK_STATUS_LABEL[t.status as TaskStatus], TASK_STATUS_LABEL[a.status]);
      if (a.title !== undefined) push('title', 'タスク名', t.title, a.title);
      if (a.note !== undefined || cl.has('note')) push('note', 'メモ', t.note, cl.has('note') ? null : a.note);
      if (a.dueAt !== undefined || cl.has('dueAt')) push('dueAt', '締切', t.dueAt ? formatJaEventTime(t.dueAt, t.dueAt) : null, cl.has('dueAt') ? null : formatJaEventTime(a.dueAt!, a.dueAt!));
      if (a.followUpAt !== undefined || cl.has('followUpAt')) push('followUpAt', '返信期限', t.followUpAt ? formatJaEventTime(t.followUpAt, t.followUpAt) : null, cl.has('followUpAt') ? null : formatJaEventTime(a.followUpAt!, a.followUpAt!));
      return { label: `タスクの変更: ${t.title}`, changes: ch };
    }
    case 'task_delete': {
      const t = d.select().from(schema.tasks).where(eq(schema.tasks.id, a.taskId)).get();
      return { label: `タスクの削除: ${t?.title ?? `タスク ${a.taskId}（見つかりません）`}`, changes: [] };
    }
    case 'event_update': {
      const e = d.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, a.eventId)).get();
      if (!e) return { label: `予定の変更（予定 ${a.eventId} が見つかりません）`, changes: [] };
      if (a.title !== undefined) push('title', '件名', e.title, a.title);
      if (a.startAt !== undefined || a.endAt !== undefined) push('time', '日時', formatJaEventTime(e.startAt, e.endAt), formatJaEventTime(a.startAt ?? e.startAt, a.endAt ?? e.endAt));
      if (a.kind !== undefined) push('kind', '種類', EVENT_KIND_LABEL[e.kind as EventKind], EVENT_KIND_LABEL[a.kind]);
      if (a.location !== undefined) push('location', '場所', e.location, a.location);
      if (a.tentative !== undefined) push('tentative', '確定', e.status === 'tentative' ? '仮' : '確定', a.tentative ? '仮' : '確定');
      return { label: `予定の変更: ${e.title}（${formatJaEventTime(e.startAt, e.endAt)}）`, changes: ch };
    }
    case 'event_delete': {
      const e = d.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, a.eventId)).get();
      return { label: `予定の削除: ${e ? `${e.title}（${formatJaEventTime(e.startAt, e.endAt)}）` : `予定 ${a.eventId}（見つかりません）`}`, changes: [] };
    }
    case 'message_send': {
      const who =
        a.to === 'client'
          ? `${a.clientId ? nameOf.client(a.clientId) : '依頼者'}${a.personId ? `（${listClientPersons(a.clientId ?? 0).find((p) => p.id === a.personId)?.name ?? '窓口'}）` : ''}`
          : a.to === 'contact'
            ? (getContact(a.contactId ?? 0)?.name ?? '関係者')
            : `事務局 ${nameOf.staff(a.staffId)}`;
      return { label: `メッセージの送信: ${who}へ ${CHANNEL_LABEL[a.channel]}`, changes: [] };
    }
  }
}

function mergeList(cur: string[], add: string[] | undefined, remove: string[] | undefined, lower = false): string[] {
  const norm = (s: string) => (lower ? s.trim().toLowerCase() : s.trim());
  const rm = new Set((remove ?? []).map(norm));
  const out = cur.filter((x) => !rm.has(norm(x)));
  for (const x of add ?? []) if (x.trim() && !out.some((y) => norm(y) === norm(x))) out.push(lower ? norm(x) : x.trim());
  return out;
}

/** 変更の案から、事件の変更内容を作る（書いていない項目は変えない。clear の項目は空にする） */
function casePatch(a: z.infer<typeof caseUpdateSchema>) {
  const cl = new Set(a.clear ?? []);
  const p: Parameters<typeof updateCase>[1] = {};
  if (a.title !== undefined) p.title = a.title;
  if (a.status !== undefined) p.status = a.status;
  if (a.caseType !== undefined) p.caseType = a.caseType;
  if (a.stage !== undefined) p.stage = a.stage;
  if (a.courtName !== undefined) p.courtName = a.courtName;
  if (a.caseNumber !== undefined) p.caseNumber = a.caseNumber;
  if (a.policy !== undefined) p.policy = a.policy;
  if (a.referrer !== undefined) p.referrer = a.referrer;
  for (const k of cl) (p as Record<string, unknown>)[k] = null;
  return p;
}

/** 実行する。ここで初めてデータが変わる（送信なら送られる） */
export async function applyExtended(a: ExtendedAction): Promise<{ label: string; link?: string }> {
  const label = previewExtended(a).label;
  const d = db();
  switch (a.type) {
    case 'staff_create': {
      const same = findStaffByName(a.name);
      // 同じ名前の人がいれば作らない（二重登録しない）。止めている人なら戻す
      if (same && squash(same.name) === squash(a.name)) {
        if (!same.active) updateStaff(same.id, { active: true });
        return { label: `事務局メンバーの登録: ${same.name}（すでに登録されていました）`, link: '/settings' };
      }
      createStaff({ name: a.name, kana: a.kana ?? null });
      return { label, link: '/settings' };
    }
    case 'case_update': {
      if (!d.select().from(schema.cases).where(eq(schema.cases.id, a.caseId)).get()) throw new Error('事件が見つかりません');
      if (a.caseType !== undefined && !listCaseTypes().some((t) => t.key === a.caseType)) throw new Error('事件類型が見つかりません');
      const staffId = resolveStaffId(a);
      updateCase(a.caseId, { ...casePatch(a), ...(staffId !== undefined && !(a.clear ?? []).includes('staffId') ? { staffId } : {}) });
      return { label: previewExtended({ ...a, ...(staffId !== undefined ? { staffId, staffName: undefined } : {}) }).label, link: `/cases/${a.caseId}` };
    }
    case 'case_create': {
      const staffId = resolveStaffId(a) ?? null;
      const row = createCase({ clientId: a.clientId, title: a.title, status: a.status ?? 'active', courtName: a.courtName ?? null, caseNumber: a.caseNumber ?? null, caseType: a.caseType, staffId, referrer: a.referrer ?? null });
      return { label, link: `/cases/${row.id}` };
    }
    case 'client_create': {
      const row = createClientRecord({ name: a.name, kana: a.kana ?? null, entityType: a.entityType, aliases: [], emails: a.emails ?? [], phones: a.phones ?? [], notes: a.notes ?? null });
      return { label, link: `/clients/${row.id}` };
    }
    case 'client_update': {
      const c = d.select().from(schema.clients).where(eq(schema.clients.id, a.clientId)).get();
      if (!c) throw new Error('依頼者が見つかりません');
      await updateClientRecord(a.clientId, {
        ...(a.name !== undefined ? { name: a.name } : {}),
        ...(a.kana !== undefined ? { kana: a.kana } : {}),
        ...(a.addPhones?.length || a.removePhones?.length ? { phones: mergeList(c.phones ?? [], a.addPhones, a.removePhones) } : {}),
        ...(a.addEmails?.length || a.removeEmails?.length ? { emails: mergeList(c.emails, a.addEmails, a.removeEmails, true) } : {}),
        ...(a.preferredChannel !== undefined ? { preferredChannel: a.preferredChannel } : {}),
        ...(a.notes !== undefined ? { notes: a.notes } : {}),
      });
      return { label, link: `/clients/${a.clientId}` };
    }
    case 'contact_create': {
      createContact(a.caseId, { role: a.role, name: a.name, organization: a.organization ?? null, emails: a.emails ?? [], phone: a.phone ?? null, fax: a.fax ?? null, note: a.note ?? null });
      return { label, link: `/cases/${a.caseId}#contacts` };
    }
    case 'contact_update': {
      const k = getContact(a.contactId);
      if (!k) throw new Error('関係者が見つかりません');
      updateContact(a.contactId, {
        ...(a.role !== undefined ? { role: a.role } : {}),
        ...(a.name !== undefined ? { name: a.name } : {}),
        ...(a.organization !== undefined ? { organization: a.organization } : {}),
        ...(a.addEmails?.length ? { emails: mergeList(k.emails, a.addEmails, [], true) } : {}),
        ...(a.phone !== undefined ? { phone: a.phone } : {}),
        ...(a.fax !== undefined ? { fax: a.fax } : {}),
        ...(a.note !== undefined ? { note: a.note } : {}),
      });
      return { label, link: `/cases/${k.caseId}#contacts` };
    }
    case 'task_update': {
      if (!d.select().from(schema.tasks).where(eq(schema.tasks.id, a.taskId)).get()) throw new Error('タスクが見つかりません');
      const cl = new Set(a.clear ?? []);
      updateTask(a.taskId, {
        ...(a.title !== undefined ? { title: a.title } : {}),
        ...(a.note !== undefined ? { note: a.note } : cl.has('note') ? { note: null } : {}),
        ...(a.status !== undefined ? { status: a.status } : {}),
        ...(a.dueAt !== undefined ? { dueAt: new Date(a.dueAt).toISOString() } : cl.has('dueAt') ? { dueAt: null } : {}),
        ...(a.followUpAt !== undefined ? { followUpAt: new Date(a.followUpAt).toISOString() } : cl.has('followUpAt') ? { followUpAt: null } : {}),
      });
      return { label, link: `/tasks#task-${a.taskId}` };
    }
    case 'task_delete': {
      if (!d.select().from(schema.tasks).where(eq(schema.tasks.id, a.taskId)).get()) throw new Error('タスクが見つかりません');
      deleteTask(a.taskId);
      return { label };
    }
    case 'event_update': {
      if (!d.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, a.eventId)).get()) throw new Error('予定が見つかりません');
      await editCalendarEvent(a.eventId, {
        ...(a.title !== undefined ? { title: a.title } : {}),
        ...(a.startAt !== undefined ? { startAt: a.startAt } : {}),
        ...(a.endAt !== undefined ? { endAt: a.endAt } : {}),
        ...(a.kind !== undefined ? { kind: a.kind } : {}),
        ...(a.location !== undefined ? { location: a.location } : {}),
        ...(a.tentative !== undefined ? { tentative: a.tentative } : {}),
      });
      return { label, link: `/calendar?focus=${a.eventId}` };
    }
    case 'event_delete': {
      if (!d.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, a.eventId)).get()) throw new Error('予定が見つかりません');
      await removeCalendarEvent(a.eventId);
      return { label };
    }
    case 'message_send': {
      if (!a.text.trim()) throw new Error('本文が空です');
      let conversationId: number;
      let text = a.text;
      if (a.to === 'client') {
        if (!a.clientId) throw new Error('送る依頼者が決まっていません');
        // 件名が無ければ、その相手との最後のメールの続きにする
        const thread = a.channel === 'gmail' && !a.subject?.trim() ? clientSendTargets(a.clientId).gmailThreads.find((t) => (t.personId ?? null) === (a.personId ?? null)) : null;
        if (a.channel === 'gmail' && !a.subject?.trim() && !thread) throw new Error('この相手とのメールがまだ無いので、件名を入れてください');
        conversationId = startClientConversation(a.clientId, { channel: a.channel, personId: a.personId ?? null, subject: a.subject ?? null, threadConversationId: thread?.conversationId ?? null }).conversationId;
      } else if (a.to === 'contact') {
        if (!a.contactId) throw new Error('送る関係者が決まっていません');
        if (a.channel === 'chatwork') throw new Error('関係者には Chatwork では送れません');
        const thread = a.channel === 'gmail' && !a.subject?.trim() ? contactSendTargets(a.contactId).gmailThreads[0] : null;
        if (a.channel === 'gmail' && !a.subject?.trim() && !thread) throw new Error('この相手とのメールがまだ無いので、件名を入れてください');
        conversationId = startContactConversation(a.contactId, { channel: a.channel, subject: a.subject ?? null, threadConversationId: thread?.conversationId ?? null }).conversationId;
      } else {
        // 事務局へは Chatwork（その人の指示ルーム、無ければ全員向けのルーム）。宛先（To）を付けて送る
        if (a.channel !== 'chatwork') throw new Error('事務局へは Chatwork で送ります');
        const t = await staffSendTargets();
        if (!t.configured) throw new Error('Chatwork が未設定です');
        const s = t.staff.find((x) => x.id === a.staffId);
        if (!s) throw new Error('送る事務局が見つかりません');
        const roomId = s.roomId ?? t.defaultRoomId;
        if (!roomId) throw new Error('事務局に送る Chatwork のルームがありません');
        if (s.chatworkAccountId && !text.includes(`[To:${s.chatworkAccountId}]`)) text = `[To:${s.chatworkAccountId}]${s.name}さん\n${text}`;
        conversationId = startRoomConversation(roomId, t.rooms.find((r) => r.roomId === roomId)?.name ?? null).conversationId;
      }
      const r = await sendToConversation(conversationId, { text, attachmentIds: [], driveFiles: [], createWaitingTask: false });
      if (a.caseId) {
        const k = d.select({ clientId: schema.cases.clientId }).from(schema.cases).where(eq(schema.cases.id, a.caseId)).get();
        if (k) d.update(schema.messages).set({ caseId: a.caseId, clientId: k.clientId }).where(eq(schema.messages.id, r.messageId)).run();
      }
      return { label, link: messageLink(conversationId, r.messageId) };
    }
  }
}

// ---- 調べるための道具（どれも読み取りだけ） ----

const shorten = (s: string | null | undefined, n = 80) => (s ?? '').replace(/\s+/g, ' ').slice(0, n);

export function extendedReadTools(): AgentTool[] {
  return [
    agentTool({
      name: 'get_case',
      description: '事件の詳細（区分・段階・類型・裁判所・事件番号・担当事務局・方針・関係者とその連絡先・未了のタスク・これからの予定）を返します。事件を変えるとき・関係者に送るときは、まずこれで今の内容を確かめます。',
      schema: z.object({ caseId: z.number().int() }),
      run: (i) => {
        const k = getCase(i.caseId);
        if (!k) return { error: '事件が見つかりません' };
        const d = db();
        const tasks = d
          .select()
          .from(schema.tasks)
          .where(and(eq(schema.tasks.caseId, i.caseId), inArray(schema.tasks.status, [...ACTIVE_TASK_STATUSES, 'memo'])))
          .all()
          .map((t) => ({ id: t.id, title: t.title, status: t.status, dueAt: t.dueAt, followUpAt: t.followUpAt }));
        const events = d
          .select()
          .from(schema.calendarEvents)
          .where(and(eq(schema.calendarEvents.caseId, i.caseId), gte(schema.calendarEvents.startAt, new Date(Date.now() - 86400_000).toISOString())))
          .orderBy(schema.calendarEvents.startAt)
          .all()
          .slice(0, 10)
          .map((e) => ({ id: e.id, title: e.title, startAt: e.startAt, endAt: e.endAt, kind: e.kind, status: e.status, location: e.location }));
        const contacts = listContacts(i.caseId).map((c) => {
          const t = contactSendTargets(c.id);
          return { id: c.id, role: c.role, name: c.name, organization: c.organization, emails: c.emails, phone: c.phone, fax: c.fax, canSend: t.targets.map((x) => x.channel) };
        });
        return {
          id: k.id,
          title: k.title,
          client: k.client ? { id: k.client.id, name: k.client.name } : null,
          status: k.status,
          stage: k.stage,
          caseType: k.caseType,
          courtName: k.courtName,
          caseNumber: k.caseNumber,
          staff: k.staffId ? { id: k.staffId, name: nameOf.staff(k.staffId) } : null,
          policy: shorten(k.policy, 400),
          referrer: k.referrer,
          contacts,
          openTasks: tasks,
          upcomingEvents: events,
        };
      },
    }),
    agentTool({
      name: 'get_client',
      description: '依頼者の詳細（連絡先・窓口や担当者・事件の一覧・送れる宛先と手段）を返します。依頼者の情報を変えるとき・依頼者にメッセージを送るときは、まずこれで確かめます。',
      schema: z.object({ clientId: z.number().int() }),
      run: (i) => {
        const c = db().select().from(schema.clients).where(eq(schema.clients.id, i.clientId)).get();
        if (!c) return { error: '依頼者が見つかりません' };
        const cases = db().select({ id: schema.cases.id, title: schema.cases.title, status: schema.cases.status }).from(schema.cases).where(eq(schema.cases.clientId, c.id)).all();
        const st = clientSendTargets(c.id);
        return {
          id: c.id,
          name: c.name,
          kana: c.kana,
          entityType: c.entityType,
          phones: c.phones ?? [],
          emails: c.emails,
          preferredChannel: c.preferredChannel,
          notes: shorten(c.notes, 300),
          persons: listClientPersons(c.id).map((p) => ({ id: p.id, name: p.name, title: p.title, primary: p.primary })),
          cases,
          sendTargets: st.targets.map((t) => ({ channel: t.channel, personId: t.personId, recipient: t.recipient, to: t.to })),
          cannotSend: st.missing,
          recentMails: st.gmailThreads.map((t) => ({ subject: t.subject, personId: t.personId })),
        };
      },
    }),
    agentTool({
      name: 'list_staff_and_types',
      description:
        '事務局メンバー（事件の担当事務局になる人）の一覧と ID、事件類型のキーと名前を返します。「担当」「担当事務」「担当事務局」を決めるとき・事件類型を決めるときは、これで ID・キーを確かめます。一覧にいない人を担当にするときは、staff_create でその人を登録する案と、staffName で名前を書いた case_update の案を続けて出します。',
      schema: z.object({}),
      run: () => ({
        // 止めている人も出す（担当に戻すことがある）
        staff: listStaff({ includeInactive: true }).map((s) => ({ id: s.id, name: s.name, kana: s.kana, active: s.active })),
        caseTypes: listCaseTypes().map((t) => ({ key: t.key, label: t.label })),
        caseStatuses: CASE_STATUSES.map((s) => ({ key: s, label: CASE_STATUS_LABEL[s] })),
      }),
    }),
    agentTool({
      name: 'find_tasks',
      description: 'タスクを探して ID を返します。タスクを完了にする・期限を変える・消すときは、これで ID を確かめます。',
      schema: z.object({
        query: z.string().nullable().optional().describe('タスク名の一部'),
        clientId: z.number().int().nullable().optional(),
        caseId: z.number().int().nullable().optional(),
        includeDone: z.boolean().nullable().optional().describe('完了したものも含める'),
      }),
      run: (i) => {
        const conds = [];
        if (i.clientId) conds.push(eq(schema.tasks.clientId, i.clientId));
        if (i.caseId) conds.push(eq(schema.tasks.caseId, i.caseId));
        if (!i.includeDone) conds.push(inArray(schema.tasks.status, [...ACTIVE_TASK_STATUSES, 'memo']));
        const rows = db().select().from(schema.tasks).where(conds.length ? and(...conds) : undefined).orderBy(desc(schema.tasks.updatedAt)).all();
        const q = (i.query ?? '').trim();
        return rows
          .filter((t) => !q || t.title.includes(q) || (t.note ?? '').includes(q))
          .slice(0, 15)
          .map((t) => ({ id: t.id, title: t.title, status: t.status, clientId: t.clientId, caseId: t.caseId, dueAt: t.dueAt, followUpAt: t.followUpAt }));
      },
    }),
  ];
}
