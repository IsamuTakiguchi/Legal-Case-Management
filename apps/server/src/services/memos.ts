import { z } from 'zod';
import { and, eq, isNotNull, lt, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { generateStructured } from '../integrations/anthropic.js';
import { isConfigured } from '../config.js';
import { formatJaDate } from '@lcm/shared';
import { upsertAlert, resolveAlertsByKeyPrefix } from './alerts.js';
import { createTask, defaultMemoReview, type TaskRow } from './tasks.js';
import { getSetting } from './settings.js';
import { stripQuotedReply } from './style.js';
import { logger } from '../logger.js';

/**
 * 時期未定の備忘。
 * 「和解の前に和解案を教えてほしい」「決まり次第ご連絡ください」のように、日付はまだ決まらないが、
 * あるきっかけが来たらやること（主に報告）を、きっかけ（trigger）付きのタスクとして残す。
 * - 受信したメッセージから AI が候補を見つけ、要確認と会話の画面に出す
 * - 見直す日（reviewAt）が来たら要確認に出す
 * - 後の受信や事件の記録でそのきっかけが来たようなら要確認に出す
 */

export interface MemoCandidate {
  title: string;
  trigger: string;
  reportTo: string | null;
}

const detectSchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string().describe('弁護士がやること。誰に何を伝える・渡すかが分かる言い方で 40 字以内（例: 和解案を東京海上日動 岡田様に報告）'),
        trigger: z.string().describe('いつ・何がきっかけでやるか。メッセージにある言い方で短く（例: 和解の前、次回期日の後、示談がまとまったら）'),
        reportTo: z.string().nullable().describe('伝える相手（会社名・氏名）。分からなければ null'),
      }),
    )
    .describe('時期がまだ決まらない（日付が書かれていない、条件付きの）依頼・約束だけ。日付のある依頼、今すぐ答えれば済む質問、資料のアップロードなどすぐの作業は含めない。多くても 3 件。無ければ空'),
  triggered: z
    .array(z.object({ id: z.number().int().describe('下の「時期未定の備忘」の ID'), reason: z.string().describe('きっかけが来たと考えた理由。1 文') }))
    .describe('このメッセージで、下の備忘のきっかけが来た（または近づいた）と読めるもの。はっきりしなければ含めない'),
});

/** 時期未定の備忘（未完了で、締切がまだ決まっていないもの） */
export function openMemos(filter: { clientId?: number | null; caseId?: number | null }) {
  const conds = [eq(schema.tasks.status, 'memo')];
  const scope = [filter.clientId ? eq(schema.tasks.clientId, filter.clientId) : null, filter.caseId ? eq(schema.tasks.caseId, filter.caseId) : null].filter((x) => x !== null);
  if (!scope.length) return [];
  return db()
    .select()
    .from(schema.tasks)
    .where(and(...conds, or(...scope)))
    .all();
}

const memoLine = (t: Pick<TaskRow, 'id' | 'title' | 'trigger'>) => `- ID ${t.id}: ${t.title}（きっかけ: ${t.trigger}）`;

/** 受信メッセージから、時期未定の宿題と、きっかけが来た備忘を AI で見つける */
export async function detectMemos(messageId: number): Promise<{ items: MemoCandidate[]; triggered: { id: number; reason: string }[] }> {
  const d = db();
  const m = d.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
  if (!m) throw new Error('メッセージが見つかりません');
  const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, m.conversationId)).get();
  const ctx = memoContext(conv ?? null, m.caseId);
  const memos = openMemos({ clientId: ctx.clientId, caseId: ctx.caseId });
  const body = m.channel === 'gmail' ? stripQuotedReply(m.body) : m.body;
  const r = await generateStructured({
    purpose: '時期未定の備忘の検出',
    tier: 'light',
    system: [
      '法律事務所の事務補助者として、弁護士に届いたメッセージを読み、時期がまだ決まらないために忘れやすい宿題を見つけます。',
      '対象は「和解の前に和解案を教えてほしい」「方針が決まり次第ご連絡ください」「判決が出たら知らせてほしい」のように、日付がなく、何かのきっかけでやることになる依頼・約束です。',
      '日付のある依頼、その場で答えれば済む質問、資料のアップロードなどすぐ済む作業、挨拶は含めません。事実の創作はしません。',
    ].join('\n'),
    user: `今日: ${formatJaDate(new Date())}\n相手: ${ctx.who}\n${ctx.caseTitle ? `事件: ${ctx.caseTitle}\n` : ''}\nメッセージ:\n${body.slice(0, 4000)}\n\n【時期未定の備忘（未完了）】\n${memos.map(memoLine).join('\n') || '（なし）'}`,
    schema: detectSchema,
    effort: 'low',
    maxTokens: 1500,
  });
  const ids = new Set(memos.map((t) => t.id));
  return { items: r.items, triggered: r.triggered.filter((x) => ids.has(x.id)) };
}

function memoContext(conv: typeof schema.conversations.$inferSelect | null, messageCaseId: number | null) {
  const d = db();
  const contact = conv?.contactId ? d.select().from(schema.caseContacts).where(eq(schema.caseContacts.id, conv.contactId)).get() : null;
  const caseId = messageCaseId ?? contact?.caseId ?? null;
  const kase = caseId ? d.select().from(schema.cases).where(eq(schema.cases.id, caseId)).get() : null;
  const clientId = conv?.clientId ?? kase?.clientId ?? null;
  const who = contact ? `${contact.organization ? `${contact.organization} ` : ''}${contact.name}（事件の関係者）` : (conv?.counterpartName ?? '不明');
  return { clientId, caseId, caseTitle: kase?.title ?? null, who };
}

/** 自動で見つけるか（設定で止められる。AI が未設定なら見ない） */
export function memoDetectEnabled(): boolean {
  return isConfigured('anthropic') && getSetting('memo_detect') !== 'off';
}

/** 受信のたびに裏で見る。見つかったら要確認に出す */
export function detectMemosInBackground(messageId: number) {
  if (!memoDetectEnabled()) return;
  setImmediate(() => {
    runMemoDetection(messageId).catch((err) => logger.warn({ err, messageId }, '時期未定の備忘の検出に失敗'));
  });
}

/** 検出して、候補ときっかけを要確認に出す（テストからも呼ぶ） */
export async function runMemoDetection(messageId: number) {
  const d = db();
  const m = d.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
  if (!m || m.direction !== 'in') return { items: [], triggered: [] };
  const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, m.conversationId)).get();
  // 事務局の伝言や、ごく短いメッセージ（スタンプ・お礼だけ）は見ない
  if (!conv || (conv.meta as { staff?: boolean }).staff) return { items: [], triggered: [] };
  if ((m.channel === 'gmail' ? stripQuotedReply(m.body) : m.body).trim().length < 30) return { items: [], triggered: [] };
  const r = await detectMemos(messageId);
  const ctx = memoContext(conv, m.caseId);
  if (r.items.length) {
    upsertAlert({
      type: 'memo_suggested',
      dedupeKey: `memo_suggested:${messageId}`,
      title: `${ctx.who}: ${r.items.map((i) => `${i.title}（${i.trigger}）`).join('／')}`,
      body: '日付が決まっていない宿題です。備忘に登録しておくと、見直す日やきっかけが来たときにお知らせします。',
      payload: { conversationId: conv.id, messageId, clientId: ctx.clientId, caseId: ctx.caseId, items: r.items },
    });
  }
  for (const t of r.triggered) {
    const task = d.select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get();
    if (!task) continue;
    upsertAlert({
      type: 'memo_triggered',
      dedupeKey: `memo_triggered:${t.id}:message:${messageId}`,
      title: `${task.title}（きっかけ: ${task.trigger}）`,
      body: `${ctx.who}からの連絡: ${t.reason}`,
      payload: { taskId: t.id, conversationId: conv.id, messageId, caseId: task.caseId },
    });
  }
  return r;
}

/** 記録（期日・電話メモなど）の内容で、その事件の備忘のきっかけが来たかを見る */
export async function checkMemosForNote(noteId: number) {
  const d = db();
  const note = d.select().from(schema.caseNotes).where(eq(schema.caseNotes.id, noteId)).get();
  if (!note) return [];
  const memos = openMemos({ caseId: note.caseId });
  if (!memos.length) return [];
  const r = await generateStructured({
    purpose: '備忘のきっかけの判定',
    tier: 'light',
    system: '法律事務所の事務補助者として、事件の記録を読み、時期未定の備忘のきっかけが来た（または近づいた）かを判定します。はっきりしなければ含めません。',
    user: `記録:\n${[note.gist, note.rawText].filter(Boolean).join('\n').slice(0, 4000)}\n\n【時期未定の備忘（未完了）】\n${memos.map(memoLine).join('\n')}`,
    schema: detectSchema.pick({ triggered: true }),
    effort: 'low',
    maxTokens: 1000,
  });
  const ids = new Set(memos.map((t) => t.id));
  const hits = r.triggered.filter((x) => ids.has(x.id));
  for (const h of hits) {
    const task = memos.find((t) => t.id === h.id)!;
    upsertAlert({
      type: 'memo_triggered',
      dedupeKey: `memo_triggered:${h.id}:note:${noteId}`,
      title: `${task.title}（きっかけ: ${task.trigger}）`,
      body: `記録より: ${h.reason}`,
      payload: { taskId: h.id, caseId: note.caseId, noteId },
    });
  }
  return hits;
}

/** 記録を保存したあとに裏で見る */
export function checkMemosForNoteInBackground(noteId: number, caseId: number) {
  if (!memoDetectEnabled() || !openMemos({ caseId }).length) return;
  setImmediate(() => {
    checkMemosForNote(noteId).catch((err) => logger.warn({ err, noteId }, '備忘のきっかけの判定に失敗'));
  });
}

/** 見直す日を過ぎた時期未定の備忘を要確認に出す */
export function checkMemoReviews(): number {
  const now = new Date().toISOString();
  const rows = db()
    .select({ task: schema.tasks, clientName: schema.clients.name })
    .from(schema.tasks)
    .leftJoin(schema.clients, eq(schema.clients.id, schema.tasks.clientId))
    .where(and(eq(schema.tasks.status, 'memo'), isNotNull(schema.tasks.reviewAt), lt(schema.tasks.reviewAt, now)))
    .all();
  for (const r of rows) {
    const t = r.task;
    upsertAlert({
      type: 'memo_review',
      dedupeKey: `memo_review:${t.id}:${t.reviewAt}`,
      title: `${r.clientName ? `${r.clientName} / ` : ''}${t.title}（きっかけ: ${t.trigger}）`,
      body: 'まだ時期が決まっていませんか？ 時期が来ていればタスクにし（締切を入れてもタスクになります）、まだなら次に見直す日を決めてください。',
      payload: { taskId: t.id, conversationId: t.conversationId, caseId: t.caseId, clientId: t.clientId },
    });
  }
  return rows.length;
}

export const memoInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  trigger: z.string().trim().min(1).max(200),
  reviewAt: z.string().datetime({ offset: true }).optional().nullable(),
  note: z.string().max(2000).optional().nullable(),
  clientId: z.number().int().optional().nullable(),
  caseId: z.number().int().optional().nullable(),
  conversationId: z.number().int().optional().nullable(),
  sourceMessageId: z.number().int().optional().nullable(),
});

/** 時期未定の備忘を登録する（対応中のタスク・締切なし・きっかけと見直す日つき） */
export async function createMemo(input: z.infer<typeof memoInputSchema>) {
  const d = db();
  let { clientId = null, caseId = null, conversationId = null } = input;
  // 受信メッセージから作るときは、会話の依頼者・事件を引き継ぐ
  if (input.sourceMessageId) {
    const m = d.select().from(schema.messages).where(eq(schema.messages.id, input.sourceMessageId)).get();
    if (m) {
      const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, m.conversationId)).get() ?? null;
      const ctx = memoContext(conv, m.caseId);
      conversationId ??= m.conversationId;
      clientId ??= ctx.clientId;
      caseId ??= ctx.caseId;
    }
  }
  const quote = input.sourceMessageId ? d.select({ body: schema.messages.body, channel: schema.messages.channel }).from(schema.messages).where(eq(schema.messages.id, input.sourceMessageId)).get() : null;
  const note = input.note ?? (quote ? `受信より:\n${withoutGreeting(quote.channel === 'gmail' ? stripQuotedReply(quote.body) : quote.body).slice(0, 600)}` : null);
  // きっかけが来るまではタスクとして数えない（状態 memo）
  return createTask({ title: input.title, trigger: input.trigger, reviewAt: input.reviewAt ?? null, note, clientId, caseId, conversationId, sourceMessageId: input.sourceMessageId ?? null, status: 'memo', syncToChatwork: false });
}

/** 冒頭の宛名と挨拶（「瀧口様」「お世話になっております。」）を外して、用件から始める */
export function withoutGreeting(body: string): string {
  const lines = body.trim().split('\n');
  let i = 0;
  while (i < lines.length && i < 4) {
    const l = lines[i]!.trim();
    if (!l || /^(.{1,20}(様|先生|御中))[\s　]*$/.test(l) || /お世話にな(って|り)|いつもお世話|ご連絡ありがとう/.test(l) && l.length < 40) i++;
    else break;
  }
  return lines.slice(i).join('\n').trim() || body.trim();
}

/** 見直す日を先に延ばす（「まだ時期未定」） */
export function snoozeMemo(id: number, days = 14) {
  const reviewAt = defaultMemoReview(new Date(), days).toISOString();
  db().update(schema.tasks).set({ reviewAt, updatedAt: new Date().toISOString() }).where(eq(schema.tasks.id, id)).run();
  resolveAlertsByKeyPrefix(`memo_review:${id}:`);
  resolveAlertsByKeyPrefix(`memo_triggered:${id}:`);
  return db().select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
}

/** 会話に出す、未処理の備忘の候補（要確認の memo_suggested） */
export function memoSuggestionsFor(conversationId: number) {
  return db()
    .select()
    .from(schema.alerts)
    .where(and(eq(schema.alerts.type, 'memo_suggested'), eq(schema.alerts.status, 'open')))
    .all()
    .filter((a) => (a.payload as { conversationId?: number }).conversationId === conversationId)
    .map((a) => ({ alertId: a.id, ...(a.payload as { messageId: number; items: MemoCandidate[] }) }));
}
