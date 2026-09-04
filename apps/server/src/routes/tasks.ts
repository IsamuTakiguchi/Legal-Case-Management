import { Hono } from 'hono';
import { z } from 'zod';
import { taskInputSchema, TASK_STATUSES } from '@lcm/shared';
import { createTask, updateTask, nudgeTask, listTasks, importChatworkTasks, syncTaskToChatwork } from '../services/tasks.js';
import { openAlerts, resolveAlert } from '../services/alerts.js';
import { db, schema } from '../db/index.js';
import { eq, desc } from 'drizzle-orm';

export const taskRoutes = new Hono();

taskRoutes.get('/tasks', (c) => {
  const q = c.req.query();
  return c.json(
    listTasks({
      status: (q.status as (typeof TASK_STATUSES)[number] | 'active') || 'active',
      clientId: q.clientId ? Number(q.clientId) : undefined,
      caseId: q.caseId ? Number(q.caseId) : undefined,
      conversationId: q.conversationId ? Number(q.conversationId) : undefined,
    }),
  );
});

taskRoutes.post('/tasks', async (c) => c.json(await createTask(taskInputSchema.parse(await c.req.json()))));

taskRoutes.put('/tasks/:id', async (c) => c.json(updateTask(Number(c.req.param('id')), taskInputSchema.partial().parse(await c.req.json()))));

taskRoutes.post('/tasks/:id/nudge', (c) => c.json(nudgeTask(Number(c.req.param('id')))));

taskRoutes.post('/tasks/:id/sync-chatwork', async (c) => {
  await syncTaskToChatwork(Number(c.req.param('id')));
  return c.json({ ok: true });
});

taskRoutes.post('/tasks/import-chatwork', async (c) => c.json(await importChatworkTasks()));

// ---- アラート ----
taskRoutes.get('/alerts', (c) => {
  const status = c.req.query('status') ?? 'open';
  if (status === 'open') return c.json(openAlerts(c.req.query('type') || undefined));
  return c.json(db().select().from(schema.alerts).where(eq(schema.alerts.status, status)).orderBy(desc(schema.alerts.createdAt)).limit(100).all());
});

taskRoutes.post('/alerts/:id/resolve', async (c) => {
  const body = z.object({ status: z.enum(['resolved', 'dismissed']).default('resolved') }).parse(await c.req.json().catch(() => ({})));
  resolveAlert(Number(c.req.param('id')), body.status);
  return c.json({ ok: true });
});
