import { and, eq, desc, inArray, lt, isNotNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { addBusinessDays, formatJaDateTime, TASK_STATUS_LABEL, type TaskInput, type TaskStatus } from '@lcm/shared';
import { getSettingInt, holidaySet } from './settings.js';
import { upsertAlert, resolveAlertsByKeyPrefix } from './alerts.js';
import { isConfigured } from '../config.js';
import * as cw from '../channels/chatwork.js';
import { logger } from '../logger.js';
import { generateStructured } from '../integrations/anthropic.js';
import { z } from 'zod';

export type TaskRow = typeof schema.tasks.$inferSelect;

export function defaultFollowUp(from = new Date()): Date {
  return addBusinessDays(from, getSettingInt('waiting_followup_business_days', 3), holidaySet());
}

export async function createTask(input: TaskInput): Promise<TaskRow> {
  const now = new Date().toISOString();
  const waiting = input.status === 'waiting_client' || input.status === 'waiting_other';
  const row = db()
    .insert(schema.tasks)
    .values({
      title: input.title,
      note: input.note ?? null,
      clientId: input.clientId ?? null,
      caseId: input.caseId ?? null,
      conversationId: input.conversationId ?? null,
      status: input.status,
      waitingSince: waiting ? now : null,
      followUpAt: waiting ? (input.followUpAt ?? defaultFollowUp().toISOString()) : (input.followUpAt ?? null),
    })
    .returning()
    .get();
  if (input.syncToChatwork && isConfigured('chatwork')) {
    await syncTaskToChatwork(row.id).catch((err) => logger.warn({ err }, 'Chatwork タスク作成に失敗'));
  }
  return db().select().from(schema.tasks).where(eq(schema.tasks.id, row.id)).get()!;
}

export function updateTask(id: number, patch: Partial<TaskInput> & { status?: TaskStatus }): TaskRow {
  const cur = db().select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
  if (!cur) throw new Error('タスクが見つかりません');
  const now = new Date().toISOString();
  const set: Partial<typeof schema.tasks.$inferInsert> = { updatedAt: now };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.note !== undefined) set.note = patch.note ?? null;
  if (patch.clientId !== undefined) set.clientId = patch.clientId ?? null;
  if (patch.caseId !== undefined) set.caseId = patch.caseId ?? null;
  if (patch.conversationId !== undefined) set.conversationId = patch.conversationId ?? null;
  if (patch.followUpAt !== undefined) set.followUpAt = patch.followUpAt ?? null;
  if (patch.status && patch.status !== cur.status) {
    set.status = patch.status;
    const waiting = patch.status === 'waiting_client' || patch.status === 'waiting_other';
    if (waiting) {
      set.waitingSince = now;
      set.followUpAt = patch.followUpAt ?? defaultFollowUp().toISOString();
    }
    if (patch.status === 'done') {
      set.completedAt = now;
      resolveAlertsByKeyPrefix(`waiting_overdue:${id}:`);
      resolveAlertsByKeyPrefix(`reply_received:${id}:`);
      if (cur.chatworkTaskId && cur.chatworkRoomId && isConfigured('chatwork')) {
        cw.setTaskStatus(cur.chatworkRoomId, cur.chatworkTaskId, 'done').catch((err) => logger.warn({ err }, 'Chatwork タスク完了に失敗'));
      }
    }
    if (patch.status === 'open') {
      resolveAlertsByKeyPrefix(`waiting_overdue:${id}:`);
      if (cur.status === 'done' && cur.chatworkTaskId && cur.chatworkRoomId && isConfigured('chatwork')) {
        cw.setTaskStatus(cur.chatworkRoomId, cur.chatworkTaskId, 'open').catch((err) => logger.warn({ err }, 'Chatwork タスク再開に失敗'));
      }
    }
  }
  db().update(schema.tasks).set(set).where(eq(schema.tasks.id, id)).run();
  return db().select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!;
}

/** 催促した（フォローアップ期限を再設定） */
export function nudgeTask(id: number): TaskRow {
  const now = new Date();
  db()
    .update(schema.tasks)
    .set({ lastNudgedAt: now.toISOString(), followUpAt: defaultFollowUp(now).toISOString(), updatedAt: now.toISOString() })
    .where(eq(schema.tasks.id, id))
    .run();
  resolveAlertsByKeyPrefix(`waiting_overdue:${id}:`);
  return db().select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!;
}

export function listTasks(filter: { status?: TaskStatus | 'active'; clientId?: number; caseId?: number; conversationId?: number }) {
  const conds = [];
  if (filter.status === 'active') conds.push(inArray(schema.tasks.status, ['open', 'waiting_client', 'waiting_other']));
  else if (filter.status) conds.push(eq(schema.tasks.status, filter.status));
  if (filter.clientId) conds.push(eq(schema.tasks.clientId, filter.clientId));
  if (filter.caseId) conds.push(eq(schema.tasks.caseId, filter.caseId));
  if (filter.conversationId) conds.push(eq(schema.tasks.conversationId, filter.conversationId));
  const rows = db()
    .select({ task: schema.tasks, clientName: schema.clients.name })
    .from(schema.tasks)
    .leftJoin(schema.clients, eq(schema.clients.id, schema.tasks.clientId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.tasks.updatedAt))
    .all();
  return rows.map((r) => ({ ...r.task, clientName: r.clientName ?? null }));
}

/** 受信があった会話に紐付く返信待ちタスクを検知 */
export function onInboundForTasks(conversationId: number, message: typeof schema.messages.$inferSelect) {
  const waiting = db()
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.conversationId, conversationId), inArray(schema.tasks.status, ['waiting_client', 'waiting_other'])))
    .all();
  for (const t of waiting) {
    db().update(schema.tasks).set({ status: 'open', updatedAt: new Date().toISOString() }).where(eq(schema.tasks.id, t.id)).run();
    resolveAlertsByKeyPrefix(`waiting_overdue:${t.id}:`);
    upsertAlert({
      type: 'reply_received',
      dedupeKey: `reply_received:${t.id}:${message.id}`,
      title: `返信が届きました: ${t.title}`,
      body: message.body.slice(0, 100),
      payload: { taskId: t.id, conversationId, messageId: message.id },
    });
  }
}

/** フォローアップ期限を過ぎた返信待ちタスクをアラート化 */
export function checkOverdueWaitingTasks(): number {
  const now = new Date().toISOString();
  const rows = db()
    .select({ task: schema.tasks, clientName: schema.clients.name })
    .from(schema.tasks)
    .leftJoin(schema.clients, eq(schema.clients.id, schema.tasks.clientId))
    .where(and(inArray(schema.tasks.status, ['waiting_client', 'waiting_other']), isNotNull(schema.tasks.followUpAt), lt(schema.tasks.followUpAt, now)))
    .all();
  for (const r of rows) {
    const t = r.task;
    const since = t.waitingSince ? formatJaDateTime(new Date(t.waitingSince)) : '';
    upsertAlert({
      type: 'waiting_overdue',
      dedupeKey: `waiting_overdue:${t.id}:${t.followUpAt}`,
      title: `${TASK_STATUS_LABEL[t.status as TaskStatus]}が期限超過: ${r.clientName ? `${r.clientName} / ` : ''}${t.title}`,
      body: since ? `${since} から返信待ち。催促文を作成できます。` : '催促文を作成できます。',
      payload: { taskId: t.id, conversationId: t.conversationId, clientId: t.clientId },
    });
  }
  return rows.length;
}

export async function syncTaskToChatwork(taskId: number): Promise<void> {
  const t = db().select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (!t || t.chatworkTaskId) return;
  const roomId = await cw.myChatRoomId();
  if (!roomId) return;
  const me = await cw.chatworkMe();
  const limit = t.followUpAt ? Math.floor(new Date(t.followUpAt).getTime() / 1000) : undefined;
  const res = await cw.createTask(roomId, `${t.title}${t.note ? `\n${t.note}` : ''}`, [me.account_id], limit);
  const cwId = res.task_ids[0];
  if (cwId) db().update(schema.tasks).set({ chatworkRoomId: roomId, chatworkTaskId: cwId }).where(eq(schema.tasks.id, taskId)).run();
}

/** Chatwork の自分のタスクを取り込む（既存運用を壊さない） */
export async function importChatworkTasks(): Promise<{ imported: number; completed: number }> {
  if (!isConfigured('chatwork')) return { imported: 0, completed: 0 };
  const open = await cw.myTasks('open');
  let imported = 0;
  const openIds = new Set(open.map((t) => t.task_id));
  for (const t of open) {
    const existing = db().select().from(schema.tasks).where(eq(schema.tasks.chatworkTaskId, t.task_id)).get();
    if (existing) continue;
    const client = db().select().from(schema.clients).where(eq(schema.clients.chatworkRoomId, t.room.room_id)).get();
    db()
      .insert(schema.tasks)
      .values({
        title: cw.stripChatworkMarkup(t.body).split('\n')[0].slice(0, 120),
        note: cw.stripChatworkMarkup(t.body),
        clientId: client?.id ?? null,
        status: 'open',
        chatworkRoomId: t.room.room_id,
        chatworkTaskId: t.task_id,
        dueAt: t.limit_time ? new Date(t.limit_time * 1000).toISOString() : null,
      })
      .run();
    imported++;
  }
  // Chatwork 側で完了したものを反映
  let completed = 0;
  const mine = db().select().from(schema.tasks).where(and(isNotNull(schema.tasks.chatworkTaskId), inArray(schema.tasks.status, ['open', 'waiting_client', 'waiting_other']))).all();
  for (const t of mine) {
    if (t.chatworkTaskId && !openIds.has(t.chatworkTaskId)) {
      db().update(schema.tasks).set({ status: 'done', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).where(eq(schema.tasks.id, t.id)).run();
      completed++;
    }
  }
  return { imported, completed };
}

const waitingJudgeSchema = z.object({
  expectsReply: z.boolean().describe('相手からの返答・資料・連絡を待つ内容か'),
  waitingFor: z.enum(['client', 'other', 'none']).describe('待つ相手: 依頼者=client、相手方・裁判所・第三者=other'),
  suggestedTitle: z.string().describe('返信待ちタスクの短い題名（例: 山田様 委任状の返送待ち）'),
  suggestedFollowUpBusinessDays: z.number().int().min(1).max(30),
});

/** 送信文が「相手の返答待ち」になるかを判定して提案を返す */
export async function judgeWaiting(text: string, clientName?: string | null) {
  return generateStructured({
    system: '法律事務所の事務補助者として、弁護士が送ったメッセージを読み、相手からの返答・資料・連絡を待つ状態になるかを判定します。日本語で簡潔に。',
    user: `相手: ${clientName ?? '不明'}\n\n送信文:\n${text}`,
    schema: waitingJudgeSchema,
    effort: 'low',
    maxTokens: 1000,
  });
}
