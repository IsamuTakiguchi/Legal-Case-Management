import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { ACTIVE_TASK_STATUSES, CHANNEL_LABEL, OPEN_CASE_STATUSES, fixDueYear, formatJaDate, formatJaDateTime, isWaitingStatus, TASK_STATUS_LABEL, type Channel, type TaskStatus } from '@lcm/shared';
import { generateStructured } from '../integrations/anthropic.js';
import { noteTaskSuggestionSchema, taskDeadlinesOf, type NoteTaskSuggestion } from './cases.js';
import { createTask } from './tasks.js';
import { getSetting } from './settings.js';

/**
 * 受信箱の会話（依頼者・相手方・事務局とのやり取り）から、追いかけるタスクを登録する。
 * AI がやり取りを読んでタスクの案（題名・状態・締切・返信期限・メモ）を作り、画面で直してから登録する
 */

export interface ConversationTaskSuggestion extends NoteTaskSuggestion {
  /** タスクを付ける事件の候補（既定は会話の事件、無ければ依頼者の進行中の事件） */
  cases: { id: number; title: string }[];
  defaultCaseId: number | null;
}

function conversationOf(conversationId: number) {
  const d = db();
  const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get();
  if (!conv) throw new Error('会話が見つかりません');
  const client = conv.clientId ? (d.select().from(schema.clients).where(eq(schema.clients.id, conv.clientId)).get() ?? null) : null;
  const rank: Record<string, number> = { active: 0, wrapup: 1, consultation: 2 };
  const cases = client
    ? d
        .select()
        .from(schema.cases)
        .where(and(eq(schema.cases.clientId, client.id), inArray(schema.cases.status, OPEN_CASE_STATUSES)))
        .all()
        .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.id - a.id)
    : [];
  // 会話に事件が付いていればそれを先頭に（終了事件でも候補に入れる）
  const own = conv.caseId ? d.select().from(schema.cases).where(eq(schema.cases.id, conv.caseId)).get() : null;
  const list = [...(own ? [own] : []), ...cases.filter((c) => c.id !== own?.id)];
  return { conv, client, cases: list };
}

/** 会話のやり取りからタスクの案を作る */
export async function suggestConversationTasks(conversationId: number): Promise<ConversationTaskSuggestion> {
  const d = db();
  const { conv, client, cases } = conversationOf(conversationId);
  const messages = d.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).orderBy(desc(schema.messages.sentAt)).limit(12).all().reverse();
  if (!messages.length) throw new Error('この会話にはまだメッセージがありません');
  // すでにある未了のタスクと同じものを出さないように渡す（この会話・この依頼者の分）
  const conds = [eq(schema.tasks.conversationId, conversationId), ...(client ? [eq(schema.tasks.clientId, client.id)] : [])];
  const open = d
    .select({ title: schema.tasks.title, status: schema.tasks.status })
    .from(schema.tasks)
    .where(and(or(...conds), inArray(schema.tasks.status, [...ACTIVE_TASK_STATUSES])))
    .all();
  const lawyer = getSetting('lawyer_name') || '弁護士';
  const thread = messages
    .map((m) => `[${m.direction === 'out' ? `自分（${lawyer}）` : (m.senderName ?? conv.counterpartName ?? '相手')} ${formatJaDateTime(new Date(m.sentAt))}]\n${m.body.slice(0, 1500)}`)
    .join('\n\n');
  const lines = [
    `今日: ${formatJaDate(new Date())}`,
    `チャネル: ${CHANNEL_LABEL[conv.channel as Channel] ?? conv.channel}`,
    `依頼者: ${client?.name ?? '（未紐付け）'}`,
    cases[0] ? `事件: ${cases[0].title}` : '',
    `会話の相手: ${conv.counterpartName ?? '不明'}`,
    `やり取り（古い順）:\n${thread}`,
    open.length ? `未了のタスク（重複させない）:\n${open.map((t) => `・${t.title}（${TASK_STATUS_LABEL[t.status as TaskStatus] ?? t.status}）`).join('\n')}` : '',
  ].filter(Boolean);
  const r = await generateStructured({
    purpose: '会話からのタスク案',
    system: [
      `法律事務所の事務補助者として、弁護士（${lawyer}。やり取りの「自分」）と相手のやり取りから、これから弁護士が追いかけるタスクの案を作ります。やり取りに無いことは作りません。`,
      '相手から頼まれたこと・こちらが約束したこと（「確認して折り返します」「来週までにお送りします」など）・相手の返事や資料を待っていることを拾います。新しいメッセージほど重視し、すでに済んだこと（こちらが送り終えたもの・解決した質問）は挙げません。',
      'タスクは「弁護士や事務局が実際に手を動かす単位」で挙げます。細かい手順に分けず、ひとまとまりの仕事は 1 件にします。多くても 4 件。挨拶やお礼だけのやり取りなら tasks は空にします。',
      '未了のタスクと同じ内容は挙げません。',
      '期限はやり取りから読み取れるときだけ入れます（「来週金曜まで」なども今日を基準に日付にします）。読み取れなければ null にします。',
      '期限は 2 つに分けます。due（締切）はタスク自体の締切、replyBy（返信期限）は返信待ちのタスクで返事をいつまで待つか。',
      '年の書かれていない期限（「11/10」など）は、今日以降で最も近いその日付にします（今日より前の月日なら来年）。',
    ].join('\n'),
    user: lines.join('\n\n'),
    schema: noteTaskSuggestionSchema,
    effort: 'low',
    maxTokens: 2000,
  });
  return {
    tasks: r.tasks.map((t) => ({ ...t, due: fixDueYear(t.due), replyBy: isWaitingStatus(t.status) ? fixDueYear(t.replyBy) : null })),
    comment: r.comment,
    cases: cases.map((c) => ({ id: c.id, title: c.title })),
    defaultCaseId: cases[0]?.id ?? null,
  };
}

export interface ConversationTaskInput {
  tasks: { title: string; due?: string | null; replyBy?: string | null; status?: TaskStatus; note?: string | null }[];
  caseId?: number | null;
  syncToChatwork?: boolean;
}

/** 画面で直したタスクの案を登録する（この会話・依頼者・事件に紐付け、きっかけは会話の最新の受信） */
export async function createConversationTasks(conversationId: number, input: ConversationTaskInput) {
  const d = db();
  const { conv, client, cases } = conversationOf(conversationId);
  const list = input.tasks.map((t) => ({ ...t, title: t.title.trim() })).filter((t) => t.title);
  if (!list.length) throw new Error('登録するタスクがありません');
  // 事件は、この依頼者の事件だけ（別の依頼者の事件に付けない）
  let caseId = input.caseId ?? null;
  if (caseId && !cases.some((c) => c.id === caseId)) {
    const k = d.select().from(schema.cases).where(eq(schema.cases.id, caseId)).get();
    if (!k) throw new Error('事件が見つかりません');
    if (client && k.clientId !== client.id) throw new Error('この会話の依頼者の事件ではありません');
  }
  if (caseId === null && input.caseId === undefined) caseId = cases[0]?.id ?? null;
  const lastIn = d
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.direction, 'in')))
    .orderBy(desc(schema.messages.sentAt))
    .get();
  const created: { id: number; title: string; status: string }[] = [];
  for (const t of list) {
    const st = t.status ?? 'open';
    const row = await createTask({
      title: t.title,
      status: st,
      ...taskDeadlinesOf({ due: t.due ?? null, replyBy: t.replyBy ?? null }, st),
      note: t.note?.trim() || null,
      clientId: client?.id ?? null,
      caseId,
      conversationId: conv.id,
      sourceMessageId: lastIn?.id ?? null,
      syncToChatwork: !!input.syncToChatwork,
    });
    created.push({ id: row.id, title: row.title, status: row.status });
  }
  return { tasks: created };
}
