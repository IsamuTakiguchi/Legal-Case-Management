import { Hono } from 'hono';
import { z } from 'zod';
import { taskInputSchema, caseNoteInputSchema, TASK_STATUSES, WAITING_TASK_STATUSES, staffAskDraftSchema, staffAskSendSchema } from '@lcm/shared';
import { staffAskContext, draftStaffAsk, sendStaffAsk, type StaffAskSource } from '../services/staffAsk.js';
import { createTask, updateTask, nudgeTask, listTasks, importChatworkTasks, syncTaskToChatwork, bulkUpdateTasks, deleteTask } from '../services/tasks.js';
import { openAlerts, resolveAlert } from '../services/alerts.js';
import { replyToChatworkTask } from '../services/taskReply.js';
import { callbackContext, saveCallbackNote } from '../services/taskCallback.js';
import { createMemo, detectMemos, memoInputSchema, snoozeMemo } from '../services/memos.js';
import { isConfigured } from '../config.js';
import { isLineGroupThread } from '../channels/line.js';
import { db, schema } from '../db/index.js';
import { eq, desc } from 'drizzle-orm';

export const taskRoutes = new Hono();

taskRoutes.get('/tasks', (c) => {
  const q = c.req.query();
  return c.json(
    listTasks({
      status: (q.status as (typeof TASK_STATUSES)[number] | 'active' | 'waiting') || 'active',
      clientId: q.clientId ? Number(q.clientId) : undefined,
      caseId: q.caseId ? Number(q.caseId) : undefined,
      conversationId: q.conversationId ? Number(q.conversationId) : undefined,
    }),
  );
});

taskRoutes.post('/tasks', async (c) => c.json(await createTask(taskInputSchema.parse(await c.req.json()))));

/** 部分更新。schema の既定値（status: open など）が送っていない項目に入らないよう、送られた項目だけを適用する */
taskRoutes.put('/tasks/:id', async (c) => {
  const raw = (await c.req.json()) as Record<string, unknown>;
  const parsed = taskInputSchema.partial().parse(raw);
  const patch = Object.fromEntries(Object.entries(parsed).filter(([k]) => k in raw)) as Partial<typeof parsed>;
  return c.json(updateTask(Number(c.req.param('id')), patch));
});

/** チェックしたタスクをまとめて処理 */
taskRoutes.post('/tasks/bulk', async (c) => {
  const body = z.object({ ids: z.array(z.number().int()).min(1).max(500), action: z.enum(['done', 'open', 'drafted', ...WAITING_TASK_STATUSES, 'nudge', 'delete']) }).parse(await c.req.json());
  return c.json(bulkUpdateTasks(body.ids, body.action));
});

taskRoutes.delete('/tasks/:id', (c) => {
  deleteTask(Number(c.req.param('id')));
  return c.json({ ok: true });
});

taskRoutes.post('/tasks/:id/nudge', (c) => c.json(nudgeTask(Number(c.req.param('id')))));

taskRoutes.post('/tasks/:id/sync-chatwork', async (c) => {
  await syncTaskToChatwork(Number(c.req.param('id')));
  return c.json({ ok: true });
});

/** Chatwork で振られたタスクのメッセージに、Chatwork の「返信」として送る */
taskRoutes.post('/tasks/:id/chatwork-reply', async (c) => {
  const body = z.object({ text: z.string().trim().min(1).max(10000), after: z.enum(['keep', 'done', 'waiting_staff']).default('keep') }).parse(await c.req.json());
  return c.json(await replyToChatworkTask(Number(c.req.param('id')), body));
});

taskRoutes.post('/tasks/import-chatwork', async (c) => c.json(await importChatworkTasks()));

// ---- 担当事務局への報告・確認（Chatwork） ----

const taskSource = (c: { req: { param: (k: string) => string } }): StaffAskSource => ({ kind: 'task', taskId: Number(c.req.param('id')) });

taskRoutes.get('/tasks/:id/staff-ask', async (c) => c.json(await staffAskContext(taskSource(c))));

taskRoutes.post('/tasks/:id/staff-ask/draft', async (c) => {
  const body = staffAskDraftSchema.parse(await c.req.json().catch(() => ({})));
  return c.json(await draftStaffAsk(taskSource(c), { instruction: body.instruction, mode: body.mode }));
});

taskRoutes.post('/tasks/:id/staff-ask', async (c) => c.json(await sendStaffAsk(taskSource(c), staffAskSendSchema.parse(await c.req.json()))));

// ---- 電話の伝言から折り返し電話をして記録に残す ----

taskRoutes.get('/tasks/:id/callback', (c) => c.json(callbackContext(Number(c.req.param('id')))));

taskRoutes.post('/tasks/:id/callback', async (c) => {
  const raw = await c.req.json();
  // 誰の事件か未確定なら事件の代わりに provisional（仮の呼び名）を受け取り、「氏名未確認」の相談を作って記録する
  const provisional = z.object({ label: z.string().trim().max(100).nullable().optional() }).nullable().optional().parse(raw.provisional);
  const input = caseNoteInputSchema.omit({ kind: true }).extend({ caseId: z.number().int().nullable().optional() }).parse(raw);
  const mode = raw.createTasks === 'single' ? 'single' : raw.createTasks === 'each' || raw.createTasks === true ? 'each' : false;
  const taskIndexes = Array.isArray(raw.taskIndexes) ? (raw.taskIndexes as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n >= 0) : undefined;
  return c.json(
    await saveCallbackNote(Number(c.req.param('id')), input, {
      completeTask: raw.completeTask === true,
      createTasks: mode,
      taskIndexes,
      provisional: provisional ? { label: provisional.label || null } : null,
    }),
  );
});

// ---- 時期未定の備忘 ----

/** 時期未定の備忘を登録（受信メッセージから作るときは sourceMessageId を渡す） */
taskRoutes.post('/memos', async (c) => {
  // 要確認の候補（memo_suggested）は、画面で候補をすべて片付けたときに閉じる
  return c.json(await createMemo(memoInputSchema.parse(await c.req.json())));
});

/** 受信メッセージから、時期未定の宿題の候補を AI で探す（手動） */
taskRoutes.post('/messages/:id/memos/detect', async (c) => {
  if (!isConfigured('anthropic')) return c.json({ error: 'AI（Anthropic API キー）が未設定です。題名ときっかけを直接入力してください' }, 400);
  const r = await detectMemos(Number(c.req.param('id')));
  return c.json({ items: r.items });
});

/** まだ時期未定: 見直す日を先に延ばす */
taskRoutes.post('/tasks/:id/memo-snooze', async (c) => {
  const body = z.object({ days: z.number().int().min(1).max(365).default(14) }).parse(await c.req.json().catch(() => ({})));
  return c.json(snoozeMemo(Number(c.req.param('id')), body.days));
});

// ---- アラート ----
taskRoutes.get('/alerts', (c) => {
  const status = c.req.query('status') ?? 'open';
  if (status === 'open') return c.json(withLineGroup(openAlerts(c.req.query('type') || undefined)));
  return c.json(db().select().from(schema.alerts).where(eq(schema.alerts.status, status)).orderBy(desc(schema.alerts.createdAt)).limit(100).all());
});

/** 未紐付けの LINE がグループか（紐付けの選択肢を「〜とのグループ」にする） */
function withLineGroup<T extends { type: string; payload: unknown }>(alerts: T[]): T[] {
  return alerts.map((a) => {
    const p = a.payload as { channel?: string; conversationId?: number };
    if (a.type !== 'unlinked_contact' || p.channel !== 'line' || !p.conversationId) return a;
    const conv = db().select({ externalThreadId: schema.conversations.externalThreadId }).from(schema.conversations).where(eq(schema.conversations.id, p.conversationId)).get();
    return { ...a, payload: { ...p, lineGroup: !!conv && isLineGroupThread(conv.externalThreadId) } };
  });
}

taskRoutes.post('/alerts/:id/resolve', async (c) => {
  const body = z.object({ status: z.enum(['resolved', 'dismissed']).default('resolved') }).parse(await c.req.json().catch(() => ({})));
  resolveAlert(Number(c.req.param('id')), body.status);
  return c.json({ ok: true });
});
