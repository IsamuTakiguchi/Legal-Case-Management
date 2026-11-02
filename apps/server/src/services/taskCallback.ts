import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { familyName, OPEN_CASE_STATUSES, provisionalClientName, type CaseNoteInput } from '@lcm/shared';
import { addCaseNote, createCase } from './cases.js';
import { updateTask } from './tasks.js';
import { logger } from '../logger.js';
import { extractPhones, digitsOf, extractCaller } from './phoneMessage.js';

export { looksLikePhoneMessage, extractPhones } from './phoneMessage.js';

/**
 * 事務局が受けた電話の伝言（Chatwork で振られた「◯◯さんから電話、折り返しお願いします」など）から、
 * 伝言を見ながら折り返し電話をして、そのやり取りを事件の記録（電話）に残す。
 */

type TaskRow = typeof schema.tasks.$inferSelect;

export interface CallbackContext {
  taskId: number;
  title: string;
  /** 伝言の本文 */
  message: string;
  /** 伝言をくれた人（Chatwork でタスクを振った事務局） */
  from: string | null;
  receivedAt: string;
  /** 本文の電話番号と、登録済みの誰の番号か */
  phones: { number: string; who: string | null; clientId: number | null; caseId: number | null }[];
  /** 電話をくれた人の見当（番号の持ち主など） */
  callerName: string | null;
  /** 折り返し先の番号（電話をくれた人の行の近くに書かれたもの。無ければ最初の番号） */
  callerPhone: string | null;
  clientId: number | null;
  clientName: string | null;
  /** 記録を付ける事件の候補（見当の付く順） */
  cases: { id: number; title: string; clientName: string | null }[];
  defaultCaseId: number | null;
}

/** 番号から、登録済みの依頼者・担当者・事件の関係者・債権者を探す */
function whoseNumber(number: string): { who: string; clientId: number | null; caseId: number | null } | null {
  const d = db();
  const digits = digitsOf(number);
  const same = (p: string | null | undefined) => !!p && digitsOf(p) === digits;
  for (const c of d.select().from(schema.clients).all()) if (c.phones.some(same)) return { who: `${c.name}（依頼者）`, clientId: c.id, caseId: null };
  for (const p of d.select().from(schema.clientPersons).all()) {
    if (!p.phones.some(same)) continue;
    const c = d.select().from(schema.clients).where(eq(schema.clients.id, p.clientId)).get();
    return { who: `${p.name}（${c?.name ?? '依頼者'}の担当者）`, clientId: p.clientId, caseId: null };
  }
  for (const k of d.select().from(schema.caseContacts).all()) {
    if (!same(k.phone)) continue;
    const kase = d.select().from(schema.cases).where(eq(schema.cases.id, k.caseId)).get();
    return { who: `${k.organization ? `${k.organization} ` : ''}${k.name}（${kase?.title ?? '事件'}の関係者）`, clientId: kase?.clientId ?? null, caseId: k.caseId };
  }
  for (const cr of d.select().from(schema.creditors).all()) {
    if (!same(cr.phone)) continue;
    const kase = d.select().from(schema.cases).where(eq(schema.cases.id, cr.caseId)).get();
    return { who: `${cr.name}${cr.contactPerson ? ` ${cr.contactPerson}` : ''}（${kase?.title ?? '事件'}の債権者）`, clientId: kase?.clientId ?? null, caseId: cr.caseId };
  }
  return null;
}

/** 本文に名前が出てくる依頼者（フルネーム、または「姓＋様・さん」） */
function clientsNamedIn(text: string): number[] {
  const t = text.normalize('NFKC').replace(/[\s　]+/g, '');
  const ids: number[] = [];
  for (const c of db().select().from(schema.clients).all()) {
    const full = c.name.normalize('NFKC').replace(/[\s　]+/g, '');
    const fam = familyName(c.name);
    const hit = (full.length >= 2 && t.includes(full)) || (fam.length >= 2 && fam !== full && (t.includes(`${fam}様`) || t.includes(`${fam}さん`) || t.includes(`${fam}氏`)));
    if (hit) ids.push(c.id);
  }
  return ids;
}

export function callbackContext(taskId: number): CallbackContext {
  const d = db();
  const t = d.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (!t) throw new Error('タスクが見つかりません');
  const message = (t.note?.trim() || t.title).trim();
  const text = `${t.title}\n${t.note ?? ''}`;
  const phones = extractPhones(text).map((number) => {
    const w = whoseNumber(number);
    return { number, who: w?.who ?? null, clientId: w?.clientId ?? null, caseId: w?.caseId ?? null };
  });

  // 事件の候補: タスクの事件 → 番号の持ち主の事件 → タスクの依頼者・番号の持ち主・本文に名前が出る依頼者の進行中の事件
  const caseIds: number[] = [];
  const addCase = (id: number | null | undefined) => {
    if (id && !caseIds.includes(id)) caseIds.push(id);
  };
  addCase(t.caseId);
  for (const p of phones) addCase(p.caseId);
  const clientIds = [t.clientId, ...phones.map((p) => p.clientId), ...clientsNamedIn(text)].filter((x, i, a): x is number => !!x && a.indexOf(x) === i);
  if (clientIds.length) {
    const open = d
      .select()
      .from(schema.cases)
      .where(and(inArray(schema.cases.clientId, clientIds), inArray(schema.cases.status, OPEN_CASE_STATUSES)))
      .all()
      .sort((a, b) => clientIds.indexOf(a.clientId) - clientIds.indexOf(b.clientId) || b.id - a.id);
    for (const c of open) addCase(c.id);
  }
  const cases = caseIds
    .slice(0, 8)
    .map((id) => {
      const k = d.select().from(schema.cases).where(eq(schema.cases.id, id)).get();
      if (!k) return null;
      const c = d.select().from(schema.clients).where(eq(schema.clients.id, k.clientId)).get();
      return { id: k.id, title: k.title, clientName: c?.name ?? null };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  const clientId = t.clientId ?? clientIds[0] ?? null;
  const client = clientId ? d.select().from(schema.clients).where(eq(schema.clients.id, clientId)).get() : null;
  // 折り返し先: 伝言に書かれた名前（「東京海上日動　ひめのさん」）を優先し、番号の持ち主として登録済みの名前がそれを含むなら登録の名前
  // （「山田様」と「山田 花子（依頼者）」なら「山田 花子」）。番号は、その人の行の近くに書かれたもの
  const written = extractCaller(text);
  const registered = phones.find((p) => p.who)?.who?.replace(/（[^（）]*）$/, '') ?? null;
  const squash = (s: string) => s.normalize('NFKC').replace(/[\s　]+/g, '');
  const callerName = written && registered && squash(registered).includes(squash(written.name)) ? registered : (written?.name ?? registered);
  return {
    taskId: t.id,
    title: t.title,
    message,
    from: t.chatworkAssignedByName ?? null,
    receivedAt: t.createdAt,
    phones,
    callerName,
    callerPhone: written?.phone ?? phones[0]?.number ?? null,
    clientId: client?.id ?? null,
    clientName: client?.name ?? null,
    cases,
    defaultCaseId: cases[0]?.id ?? null,
  };
}

/** 記録に添える伝言（記録だけ読んでも、何の折り返しか分かるように） */
export function callbackMessageBlock(ctx: Pick<CallbackContext, 'from' | 'message'>): string {
  return `――${ctx.from ? `${ctx.from}さんからの` : ''}伝言――\n${ctx.message}`;
}

/**
 * 誰の事件かまだ分からない電話のために、「氏名未確認」の依頼者と相談の事件を作る。
 * 依頼者ページで氏名を確定するか、既存の依頼者に統合すれば、記録もそちらに付く
 */
function createProvisionalCallbackCase(ctx: CallbackContext, label: string | null) {
  const name = provisionalClientName(label, null);
  const client = db()
    .insert(schema.clients)
    .values({ name, provisional: true, phones: ctx.callerPhone ? [ctx.callerPhone] : [], notes: '折り返し電話の記録から作りました（誰の事件か未確定）' })
    .returning()
    .get();
  const d = new Date(ctx.receivedAt);
  const md = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }).format(Number.isNaN(d.getTime()) ? new Date() : d);
  return createCase({ clientId: client.id, title: `電話相談（${md}）`, status: 'consultation', courtName: null, caseNumber: null });
}

/**
 * 折り返し電話のやり取りを事件の記録（電話）に残し、タスクを事件に紐付ける（完了にもできる）。
 * provisional を渡すと、誰の事件か未確定の電話として「氏名未確認」の相談を作ってそこに記録する
 */
export async function saveCallbackNote(
  taskId: number,
  input: Omit<CaseNoteInput, 'kind' | 'caseId'> & { caseId?: number | null },
  opts: { completeTask?: boolean; createTasks?: boolean | 'each' | 'single'; taskIndexes?: number[]; provisional?: { label: string | null } | null } = {},
) {
  const ctx = callbackContext(taskId);
  const memo = input.rawText.trim();
  if (!memo) throw new Error('通話の内容を入力してください');
  const kase = opts.provisional ? createProvisionalCallbackCase(ctx, opts.provisional.label) : input.caseId ? db().select().from(schema.cases).where(eq(schema.cases.id, input.caseId)).get() : undefined;
  if (!kase) throw new Error('事件を選んでください');
  const note = await addCaseNote(
    { ...input, caseId: kase.id, kind: 'phone', rawText: `${memo}\n\n${callbackMessageBlock(ctx)}` },
    { createTasks: opts.createTasks, taskIndexes: opts.taskIndexes },
  );
  // タスクにも、どの事件の話だったかを付けておく（一覧で事件が分かるように）
  const t = db().select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get()!;
  const patch: Partial<TaskRow> = {};
  if (!t.caseId) patch.caseId = kase.id;
  if (!t.clientId) patch.clientId = kase.clientId;
  if (Object.keys(patch).length) db().update(schema.tasks).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(schema.tasks.id, taskId)).run();
  let status = t.status;
  if (opts.completeTask && t.status !== 'done') status = updateTask(taskId, { status: 'done' }).status;
  logger.info({ taskId, noteId: note.id, caseId: kase.id, provisional: !!opts.provisional, completed: status === 'done' }, '折り返し電話を記録しました');
  return { note, taskStatus: status, caseId: kase.id };
}
