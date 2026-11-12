import { and, eq, gte, lte, like, or, desc } from 'drizzle-orm';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { runToolLoop, agentTool, type AgentTool } from '../integrations/anthropic.js';
import { searchAll, SEARCH_KINDS, SEARCH_KIND_LABEL, type SearchHit } from './search.js';
import { getSetting } from './settings.js';
import { addCaseNote } from './cases.js';
import { createTask } from './tasks.js';
import { createCalendarEvent } from './court.js';
import { CASE_NOTE_KINDS, CASE_NOTE_KIND_LABEL, EVENT_KINDS, EVENT_KIND_LABEL, TASK_STATUSES, TASK_STATUS_LABEL, formatJaDateTime, toJstParts, phoneDigits, isPhoneLike, representativeLabel } from '@lcm/shared';
import { logger } from '../logger.js';
import { extendedActionSchemas, extendedReadTools, previewExtended, applyExtended, EXTENDED_TYPES, normalizeStaffMessage, type ExtendedAction, type Change } from './secretaryActions.js';

/**
 * AI 秘書。
 *
 * 日本語の頼みごと（「山田さんから電話があった。…と記録して」「来週火曜 14 時に打合せを入れて」）を受けて、
 * 依頼者や事件を自分で調べ、やることの案を返す。案を出すところまでが秘書の仕事で、
 * 実際に登録するのは、弁護士が中身を確かめて「登録する」を押したときだけ。
 *
 * 記録・予定・タスクの追加に加えて、事件・依頼者・関係者の登録と変更、タスク・予定の変更と削除、
 * メッセージの送信（依頼者・関係者・事務局）も案にできる（secretaryActions.ts）。どれも確認のあとに実行する。
 */

const WD = ['日', '月', '火', '水', '木', '金', '土'];

// ---- やることの案（この形のまま画面に出し、直してから登録する） ----

/** ISO の日時。時差を必ず付ける（例 2026-10-03T14:00:00+09:00） */
const isoAt = z.string().describe('日時。日本時間で時差を付けた ISO（例 2026-10-03T14:00:00+09:00）');

export const noteActionSchema = z.object({
  type: z.literal('note'),
  summary: z.string().describe('画面に出す一行の説明（例「佐藤太郎／交通事故 の電話記録を追加」）'),
  caseId: z.number().int().describe('記録を付ける事件の ID。find_case で調べたもの'),
  kind: z.enum(CASE_NOTE_KINDS).describe('記録の種類'),
  occurredAt: isoAt.nullable().optional().describe('その出来事があった日時。分からなければ空（今になる）'),
  counterpart: z.string().nullable().optional().describe('相手（「依頼者」「相手方代理人 ○○」など）'),
  phone: z.string().nullable().optional().describe('電話の相手の番号（分かるときだけ）'),
  rawText: z.string().describe('記録の本文。頼まれた内容をそのまま落とさずに書く。要旨や決定事項への整理はアプリ側で行う'),
});

export const eventActionSchema = z.object({
  type: z.literal('event'),
  summary: z.string().describe('画面に出す一行の説明'),
  title: z.string().describe('予定の件名（例「佐藤　打合せ」）'),
  startAt: isoAt,
  endAt: isoAt,
  kind: z.enum(EVENT_KINDS).describe('予定の種類'),
  clientId: z.number().int().nullable().optional(),
  caseId: z.number().int().nullable().optional(),
  location: z.string().nullable().optional().describe('場所。WEB 会議なら「WEB」など'),
  description: z.string().nullable().optional(),
  tentative: z.boolean().optional().describe('仮押さえなら true'),
});

export const taskActionSchema = z.object({
  type: z.literal('task'),
  summary: z.string().describe('画面に出す一行の説明'),
  title: z.string().describe('タスクの名前。何をするかが分かるように'),
  note: z.string().nullable().optional(),
  clientId: z.number().int().nullable().optional(),
  caseId: z.number().int().nullable().optional(),
  status: z.enum(TASK_STATUSES).describe('open=自分がやる / waiting_client=依頼者の返事待ち / waiting_other=相手方・裁判所の返事待ち / waiting_staff=事務局の回答・作業待ち（新しく作るときに drafted・done は使わない）'),
  dueAt: isoAt.nullable().optional().describe('期限（自分がやるとき）'),
  followUpAt: isoAt.nullable().optional().describe('催促する日（返事待ちのとき）。空なら営業日で自動'),
});

export const secretaryActionSchema = z.discriminatedUnion('type', [noteActionSchema, eventActionSchema, taskActionSchema, ...extendedActionSchemas]);
type BasicAction = z.infer<typeof noteActionSchema> | z.infer<typeof eventActionSchema> | z.infer<typeof taskActionSchema>;
export type SecretaryAction = BasicAction | ExtendedAction;
const isExtended = (a: SecretaryAction): a is ExtendedAction => (EXTENDED_TYPES as string[]).includes(a.type);

/** 秘書が最後に返すまとめ */
const proposalSchema = z.object({
  reply: z.string().describe('弁護士への返事。何をするつもりか、何が分からなかったかを日本語で簡潔に'),
  actions: z.array(secretaryActionSchema).max(12).describe('登録・変更・送信したいことの案。質問に答えるだけのときは空にする'),
  questions: z.array(z.string()).max(3).describe('登録の前に確かめたいこと。無ければ空'),
});

export interface SecretaryPlan {
  /** 秘書からの返事 */
  reply: string;
  /** 確認待ちの案（画面で直せる） */
  actions: SecretaryAction[];
  /** 案ごとの説明と、変更の一覧（いま → 変更後）。actions と同じ並び */
  previews: { label: string; changes: Change[] }[];
  /** 足りないので聞きたいこと */
  questions: string[];
  /** 調べるのに使った資料（根拠として画面に出す） */
  sources: SearchHit[];
  /** 使った道具の名前 */
  used: string[];
}

// ---- 調べるための道具（どれも読み取りだけ） ----

const shorten = (s: string | null | undefined, n = 80) => (s ?? '').replace(/\s+/g, ' ').slice(0, n);

/** 秘書に渡す依頼者の要約（法人なら代表者も） */
function clientSummary(c: typeof schema.clients.$inferSelect) {
  return { id: c.id, name: c.name, kana: c.kana, representative: representativeLabel(c), preferredChannel: c.preferredChannel, phones: c.phones ?? [] };
}

/** 名前・かな・別名・電話番号・法人の代表者名から依頼者を探す */
export function findClients(name: string, limit = 8) {
  const q = name.trim();
  if (!q) return [];
  // 「090-1234-5678 から電話」のように番号で来たときは、書き方の違いを無視して番号で当てる
  if (isPhoneLike(q)) {
    const digits = phoneDigits(q);
    return db()
      .select()
      .from(schema.clients)
      .where(eq(schema.clients.archived, false))
      .all()
      .filter((c) => (c.phones ?? []).some((p) => phoneDigits(p) === digits))
      .slice(0, limit)
      .map(clientSummary);
  }
  const pat = `%${q}%`;
  const rows = db()
    .select()
    .from(schema.clients)
    .where(and(eq(schema.clients.archived, false), or(like(schema.clients.name, pat), like(schema.clients.kana, pat), like(schema.clients.representativeName, pat), like(schema.clients.representativeKana, pat))))
    .all();
  // 別名（旧姓・通称）でも拾う
  const byAlias = db()
    .select()
    .from(schema.clients)
    .where(eq(schema.clients.archived, false))
    .all()
    .filter((c) => (c.aliases ?? []).some((a) => a.includes(q)));
  const hit = [...rows, ...byAlias.filter((b) => !rows.some((r) => r.id === b.id))];
  // 名前が短い順（「山田」で「山田花子」より「山田」を先に）
  return hit
    .sort((a, b) => a.name.length - b.name.length)
    .slice(0, limit)
    .map(clientSummary);
}

/** 事件を探す。依頼者を指定すると、その依頼者の事件だけ */
export function findCases(input: { query?: string | null; clientId?: number | null; limit?: number }) {
  const q = (input.query ?? '').trim();
  const rows = db()
    .select({
      id: schema.cases.id,
      title: schema.cases.title,
      caseType: schema.cases.caseType,
      status: schema.cases.status,
      stage: schema.cases.stage,
      clientId: schema.cases.clientId,
      clientName: schema.clients.name,
      nextHearingAt: schema.cases.nextHearingAt,
    })
    .from(schema.cases)
    .leftJoin(schema.clients, eq(schema.cases.clientId, schema.clients.id))
    .where(input.clientId ? eq(schema.cases.clientId, input.clientId) : undefined)
    .orderBy(desc(schema.cases.updatedAt))
    .all();
  const hit = q ? rows.filter((r) => r.title.includes(q) || (r.clientName ?? '').includes(q) || (r.caseType ?? '').includes(q)) : rows;
  // 進行中を先に出す（終了した事件に記録を付けてしまわないように）
  return hit
    .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'))
    .slice(0, input.limit ?? 8);
}

/** その期間の予定（空きの確認と、重なりの警告に使う） */
export function calendarInRange(fromIso: string, toIso: string) {
  return db()
    .select()
    .from(schema.calendarEvents)
    .where(and(gte(schema.calendarEvents.startAt, fromIso), lte(schema.calendarEvents.startAt, toIso)))
    .orderBy(schema.calendarEvents.startAt)
    .all()
    .slice(0, 60)
    .map((e) => ({
      id: e.id,
      title: e.title,
      startAt: e.startAt,
      endAt: e.endAt,
      kind: e.kind,
      status: e.status,
      clientId: e.clientId,
      caseId: e.caseId,
      location: e.location,
    }));
}

function readTools(sources: SearchHit[]): AgentTool[] {
  return [
    ...extendedReadTools(),
    agentTool({
      name: 'find_client',
      description: '依頼者を名前・かな・別名・電話番号で探して、ID と正式な名前を返します。記録・予定・タスクを誰かに紐付けるときは、必ずこれで ID を確かめます。電話番号だけ分かっているときは番号をそのまま渡します。',
      schema: z.object({ name: z.string().describe('探す名前の一部（例「山田」）、または電話番号（例「090-1234-5678」）') }),
      run: (i) => findClients(i.name),
    }),
    agentTool({
      name: 'find_case',
      description: '事件を探して ID を返します。記録は必ず事件に付けるので、記録を作る前にこれで事件を確かめます。依頼者の ID が分かっていれば clientId を付けると、その人の事件だけに絞れます。',
      schema: z.object({
        query: z.string().nullable().optional().describe('事件名・依頼者名・事件類型の一部'),
        clientId: z.number().int().nullable().optional(),
      }),
      run: (i) => findCases(i),
    }),
    agentTool({
      name: 'search_data',
      description: `事務所のデータ（${SEARCH_KINDS.map((k) => SEARCH_KIND_LABEL[k]).join('・')}）を語で探します。過去の経緯を確かめたいときや、質問に答えるときに使います。`,
      schema: z.object({
        query: z.string().describe('探す語。人名・書面名などの固有名詞を優先する'),
        kinds: z.array(z.enum(SEARCH_KINDS)).nullable().optional().describe('探す先を絞るとき。迷ったら空'),
      }),
      run: (i) => {
        const hits = searchAll(i.query, { kinds: i.kinds ?? undefined, limit: 12 });
        for (const h of hits) if (!sources.some((s) => s.kind === h.kind && s.id === h.id)) sources.push(h);
        return hits.map((h) => ({ kind: h.kind, id: h.id, title: h.title, at: h.at, clientName: h.clientName, caseTitle: h.caseTitle, snippet: shorten(h.snippet, 160) }));
      },
    }),
    agentTool({
      name: 'check_calendar',
      description: 'その期間に入っている予定を返します。予定を入れる前に、重なっていないか必ず確かめます。',
      schema: z.object({ from: isoAt.describe('この日時から'), to: isoAt.describe('この日時まで') }),
      run: (i) => calendarInRange(new Date(i.from).toISOString(), new Date(i.to).toISOString()),
    }),
    agentTool({
      name: 'propose',
      description: '調べ終わったら、これを呼んで終わります。登録・変更・送信したいことがあれば actions に入れ、聞くだけ・答えるだけのときは actions を空にして reply だけ書きます。',
      schema: proposalSchema,
      // run を持たないので、これが呼ばれた時点で往復が終わる
    }),
  ];
}

function systemPrompt(): string {
  const now = new Date();
  const p = toJstParts(now);
  const lawyer = getSetting('lawyer_name');
  const office = getSetting('office_name');
  return [
    `あなたは日本の法律事務所（${office || '法律事務所'}）の秘書です。${lawyer ? `弁護士の${lawyer}先生` : '弁護士本人'}から口頭で頼まれた内容を、事務システムに登録する形に整えます。`,
    `今は ${p.year}年${p.month}月${p.day}日(${WD[p.weekday]}) ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}（日本時間）です。「来週火曜」「あさって」はこれを基準に読みます。`,
    '',
    '【できること（どれも案を出すだけで、弁護士が確認して「登録」を押したときに実行されます）】',
    '・記録の追加（note）、予定の登録（event）、タスクの作成（task）',
    '・事件の変更（case_update: 担当事務局・区分・段階・事件類型・裁判所・事件番号・方針・紹介者・事件名）、事件の新規登録（case_create）',
    '・事務局メンバーの登録（staff_create。まだ登録されていない人を担当事務局にするとき）',
    '・依頼者の新規登録（client_create）、依頼者の変更（client_update: 氏名・ふりがな・電話・メール・連絡手段・メモ）',
    '・事件の関係者（相手方代理人など）の追加（contact_create）・変更（contact_update）',
    '・タスクの変更（task_update: 完了・起案・検討完了・待ちなどの状態、期限、名前）、タスクの削除（task_delete）',
    '・予定の変更（event_update: 日時・件名・場所・種類・仮/確定）、予定の削除（event_delete）',
    '・メッセージの送信（message_send: 依頼者・窓口へ Gmail/LINE/Chatwork、関係者へ Gmail/LINE、事務局へ Chatwork）',
    'できないこと: 記録の書き換え・削除、依頼者・事件の削除、ファイルの操作、書面の作成。頼まれたら、その旨を reply に書き、どの画面でできるかを添えてください。',
    '',
    '【手順】',
    '1. 誰の・どの事件の話かを find_client と find_case で確かめます。ID を推測してはいけません。',
    '2. 事件・依頼者を変えるときは get_case・get_client でいまの内容を見ます。担当事務局・事件類型は list_staff_and_types で ID・キーを確かめます。タスクは find_tasks、予定は check_calendar で ID を確かめます。',
    '3. 予定を入れる・動かすときは check_calendar でその日の前後を見て、重なっていれば reply で知らせます。',
    '4. 過去の経緯が要るときは search_data で調べます。',
    '5. 最後に必ず propose を呼びます。',
    '',
    '【決まりごと】',
    '・記録は必ず事件（caseId）に付けます。事件が 1 つに絞れないときは、案を作らずに questions で尋ねます。',
    '・予定とタスクは、事件が分からなくても依頼者だけでも作れます。どちらも分からなければ無しで構いません。',
    '・日時は日本時間で時差を付けた ISO（例 2026-10-03T14:00:00+09:00）で書きます。終わりの時刻が分からない打合せは 1 時間とします。',
    '・言われていないことを足しません。金額・期限・相手の名前を作ってはいけません。分からないことは questions に書きます。',
    '・記録の本文（rawText）は、頼まれた内容を落とさずにそのまま書きます。要旨や決定事項への整理はアプリが行うので、あなたが作文する必要はありません。',
    '・予定の件名は「名字　内容」の形（例「佐藤　打合せ」）にします。',
    '・「担当」「担当事務」「担当事務局」「担当は○○さん」は、事件の担当事務局（case_update の staffId）のことです。記録（note）で代わりにしてはいけません。list_staff_and_types で ID を確かめて case_update を出します。一覧にいない人なら、staff_create（その人の登録）を先に、続けて staffName に名前を書いた case_update を出します。',
    '・【できること】にあるものを「システム上できない」と答えてはいけません。必ずその種類の案を作ります。',
    '・変更の案（〜_update）には、変える項目だけを書きます。変えない項目は書きません。項目を空にする（担当事務局を外す など）ときだけ clear に項目名を書きます。',
    '・削除（task_delete・event_delete）は、はっきり頼まれたときだけ案にします。',
    '・メッセージの送信は、送ってほしいとはっきり頼まれたときだけ案にします。宛先と手段は get_client・get_case の送れる宛先から選びます。本文は弁護士本人から送る文として、頼まれた内容だけを書きます（事実・期限・金額を足さない）。メールで、その相手とのメールがまだ無いときは件名を付けます。',
    '・事務局へのチャット（message_send の to=staff）は、1 行目に誰の件か（依頼者の氏名をフルネームで。「さん」「様」・事件の種類は付けない）だけを書き、2 行目から本題を書きます。本題に「○○さんについて」のような前置きは付けません。例:「吉堂壱星（改行）本人から書類が届きましたので、法テラスへ審査回付をお願いします。」事件が分かっていれば caseId を付けます。',
    '・質問された（「どうなっている？」など）だけのときは、search_data で調べて reply に答えを書き、actions は空にします。',
    '・reply は 2〜4 文。登録したい内容は画面に一覧で出るので、繰り返しません。',
  ].join('\n');
}

/**
 * 頼みごとを読んで、やることの案を返す。ここでは何も登録しない。
 *
 * @param history これまでのやり取り（秘書が聞き返したときの続き）
 */
export async function planSecretary(text: string, history: { role: 'user' | 'assistant'; text: string }[] = []): Promise<SecretaryPlan> {
  const q = text.trim();
  if (!q) throw new Error('頼みたいことを入力してください');
  const sources: SearchHit[] = [];
  const messages: Anthropic.MessageParam[] = [
    ...history.slice(-8).map((m) => ({ role: m.role, content: m.text }) as Anthropic.MessageParam),
    { role: 'user' as const, content: q },
  ];
  const r = await runToolLoop({
    purpose: 'AI 秘書',
    system: systemPrompt(),
    messages,
    tools: readTools(sources),
    maxRounds: 8,
    effort: 'medium',
    maxTokens: 4000,
  });
  const parsed = r.final?.name === 'propose' ? proposalSchema.safeParse(r.final.input) : null;
  if (!parsed?.success) {
    // propose を呼ばずに終わった（聞き返しなど）。文章だけ返す
    logger.info({ used: r.used }, 'AI 秘書: 案なしで終わりました');
    return { reply: r.text || 'うまく聞き取れませんでした。もう一度、具体的に書いてください。', actions: [], previews: [], questions: [], sources, used: r.used };
  }
  const plan = parsed.data;
  // 事務局へのチャットは、1 行目に依頼者の氏名、2 行目から本題の形にそろえる（AI が崩しても直す）
  plan.actions = plan.actions.map(normalizeStaffMessage);
  logger.info({ used: r.used, actions: plan.actions.length }, 'AI 秘書が案を作りました');
  return { reply: plan.reply.trim(), actions: plan.actions, previews: plan.actions.map(previewAction), questions: plan.questions, sources, used: r.used };
}

// ---- 確認のあとに実行する ----

export interface AppliedAction {
  type: SecretaryAction['type'];
  ok: boolean;
  /** 画面に出す一行 */
  label: string;
  /** 登録したものへのリンク */
  link?: string;
  error?: string;
}

/** 案の説明と変更の一覧（確認画面に出す） */
export function previewAction(a: SecretaryAction): { label: string; changes: Change[] } {
  return isExtended(a) ? previewExtended(a) : { label: describeAction(a), changes: [] };
}

/** 案 1 件を、人が読める一行にする（確認画面と結果に出す） */
export function describeAction(a: SecretaryAction): string {
  if (isExtended(a)) return previewExtended(a).label;
  if (a.type === 'note') return `記録（${CASE_NOTE_KIND_LABEL[a.kind]}）: ${shorten(a.rawText, 40)}`;
  if (a.type === 'event') return `予定（${EVENT_KIND_LABEL[a.kind]}）: ${a.title}　${formatJaDateTime(new Date(a.startAt), { withWeekday: true })}`;
  return `タスク（${TASK_STATUS_LABEL[a.status]}）: ${a.title}`;
}

/** 案をひとつ実行する。ここで初めてデータが増える（変わる・送られる） */
async function applyOne(a: SecretaryAction): Promise<AppliedAction> {
  if (isExtended(a)) {
    const r = await applyExtended(a);
    return { type: a.type, ok: true, label: r.label, link: r.link };
  }
  if (a.type === 'note') {
    const input = {
      caseId: a.caseId,
      kind: a.kind,
      occurredAt: a.occurredAt ?? undefined,
      counterpart: a.counterpart ?? null,
      phone: a.phone ?? null,
      rawText: a.rawText,
      theirSaid: [],
      ourSaid: [],
      decisions: [],
      nextActions: [],
      attachments: [],
    };
    let row;
    let structured = true;
    try {
      // 要旨・決定事項・次のアクションへの整理は、これまでの電話メモと同じ扱いにする
      row = await addCaseNote(input, { structure: true });
    } catch (err) {
      if (!db().select().from(schema.cases).where(eq(schema.cases.id, a.caseId)).get()) throw err;
      // 整理ができなくても、聞き取った中身は必ず残す（あとから事件ページで整理できる）
      logger.warn({ err, caseId: a.caseId }, 'AI 秘書: 記録の整理に失敗したので、本文だけ保存します');
      row = await addCaseNote(input, { structure: false });
      structured = false;
    }
    const label = structured ? describeAction(a) : `${describeAction(a)}（要旨の整理はできませんでした。本文は残しています）`;
    return { type: 'note', ok: true, label, link: `/cases/${a.caseId}#note-${row.id}` };
  }
  if (a.type === 'event') {
    const row = await createCalendarEvent({
      title: a.title,
      startAt: a.startAt,
      endAt: a.endAt,
      kind: a.kind,
      clientId: a.clientId ?? null,
      caseId: a.caseId ?? null,
      location: a.location ?? null,
      description: a.description ?? null,
      tentative: a.tentative ?? false,
    });
    return { type: 'event', ok: true, label: describeAction(a), link: `/calendar?focus=${row.id}` };
  }
  const row = await createTask({
    title: a.title,
    note: a.note ?? null,
    clientId: a.clientId ?? null,
    caseId: a.caseId ?? null,
    status: a.status,
    dueAt: a.dueAt ?? null,
    followUpAt: a.followUpAt ?? null,
    syncToChatwork: false,
  });
  return { type: 'task', ok: true, label: describeAction(a), link: `/tasks#task-${row.id}` };
}

/**
 * 確認のあとに、案をまとめて実行する。
 * 1 件が失敗しても残りは続ける（どれが入ってどれが入らなかったかを返す）。
 */
export async function applySecretaryActions(actions: SecretaryAction[]): Promise<{ applied: AppliedAction[] }> {
  const applied: AppliedAction[] = [];
  for (const a of actions) {
    try {
      applied.push(await applyOne(a));
    } catch (err) {
      logger.warn({ err, type: a.type }, 'AI 秘書の登録に失敗しました');
      applied.push({ type: a.type, ok: false, label: describeAction(a), error: (err as Error).message });
    }
  }
  logger.info({ ok: applied.filter((a) => a.ok).length, ng: applied.filter((a) => !a.ok).length }, 'AI 秘書が登録しました');
  return { applied };
}
