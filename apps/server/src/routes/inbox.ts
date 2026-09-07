import { Hono } from 'hono';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { listConversations, getConversation, markRead, setNeedsReply, archiveConversation, bulkUpdateConversations, linkMessage } from '../services/inbox.js';
import { createTask } from '../services/tasks.js';
import { linkConversationToClient, suggestClients } from '../services/identity.js';
import { assignConversationAttachments } from '../services/attachments.js';
import { sendToConversation } from '../services/send.js';
import { draftReply } from '../services/style.js';
import { judgeWaiting } from '../services/tasks.js';
import { listTemplates } from '../services/templates.js';
import { activeCasesForClient } from '../services/cases.js';
import { sendMessageSchema, draftRequestSchema, type Channel } from '@lcm/shared';

export const inboxRoutes = new Hono();

inboxRoutes.get('/conversations', (c) => {
  const q = c.req.query();
  return c.json(
    listConversations({
      clientId: q.clientId ? Number(q.clientId) : undefined,
      channel: q.channel || undefined,
      needsReply: q.needsReply === '1',
      unlinked: q.unlinked === '1',
      q: q.q || undefined,
      archived: q.archived === '1',
      limit: q.limit ? Number(q.limit) : undefined,
      // 既定では相手からの受信がある会話だけ（自分の送信だけの会話は outbound=1 のときだけ表示）
      inboundOnly: q.outbound !== '1',
    }),
  );
});

/** 一括操作（対応済み・アーカイブ・アーカイブ解除・既読） */
/** メッセージ単位の紐付け（事務局の伝言など） */
inboxRoutes.put('/messages/:id/link', async (c) => {
  const body = z.object({ clientId: z.number().int().nullable().optional(), caseId: z.number().int().nullable().optional() }).parse(await c.req.json());
  return c.json(linkMessage(Number(c.req.param('id')), body));
});

/** メッセージをそのままタスクにする（伝言のタスク化） */
inboxRoutes.post('/messages/:id/task', async (c) => {
  const body = z.object({ title: z.string().optional(), followUpAt: z.string().nullable().optional(), syncToChatwork: z.boolean().default(false) }).parse(await c.req.json().catch(() => ({})));
  const m = db().select().from(schema.messages).where(eq(schema.messages.id, Number(c.req.param('id')))).get();
  if (!m) return c.json({ error: 'not found' }, 404);
  const conv = db().select().from(schema.conversations).where(eq(schema.conversations.id, m.conversationId)).get();
  const title = (body.title?.trim() || m.body.split('\n').map((l) => l.trim()).find(Boolean) || '伝言').slice(0, 120);
  const task = await createTask({
    title,
    note: m.body,
    clientId: m.clientId ?? conv?.clientId ?? null,
    caseId: m.caseId ?? null,
    conversationId: m.conversationId,
    status: 'open',
    followUpAt: body.followUpAt ?? null,
    syncToChatwork: body.syncToChatwork,
  });
  return c.json(task);
});

inboxRoutes.post('/conversations/bulk', async (c) => {
  const body = z.object({ ids: z.array(z.number().int()).min(1).max(500), action: z.enum(['resolve', 'archive', 'unarchive', 'read']) }).parse(await c.req.json());
  return c.json({ updated: bulkUpdateConversations(body.ids, body.action) });
});

inboxRoutes.get('/conversations/:id', (c) => {
  const conv = getConversation(Number(c.req.param('id')));
  if (!conv) return c.json({ error: 'not found' }, 404);
  markRead(conv.id);
  const drafts = db().select().from(schema.drafts).where(eq(schema.drafts.conversationId, conv.id)).orderBy(desc(schema.drafts.createdAt)).limit(5).all();
  const suggestions = conv.clientId ? [] : suggestClients(conv.counterpartName);
  return c.json({ ...conv, drafts, suggestions });
});

inboxRoutes.post('/conversations/:id/link', async (c) => {
  const id = Number(c.req.param('id'));
  const body = z.object({ clientId: z.number().int() }).parse(await c.req.json());
  linkConversationToClient(id, body.clientId);
  const moved = await assignConversationAttachments(id, body.clientId);
  return c.json({ ok: true, movedAttachments: moved });
});

inboxRoutes.post('/conversations/:id/needs-reply', async (c) => {
  const body = z.object({ needsReply: z.boolean() }).parse(await c.req.json());
  setNeedsReply(Number(c.req.param('id')), body.needsReply);
  return c.json({ ok: true });
});

inboxRoutes.post('/conversations/:id/archive', async (c) => {
  const body = z.object({ archived: z.boolean() }).parse(await c.req.json());
  archiveConversation(Number(c.req.param('id')), body.archived);
  return c.json({ ok: true });
});

/** AI 下書き */
inboxRoutes.post('/conversations/:id/draft', async (c) => {
  const id = Number(c.req.param('id'));
  const req = draftRequestSchema.parse({ ...(await c.req.json()), conversationId: id });
  const conv = getConversation(id);
  if (!conv) return c.json({ error: 'not found' }, 404);
  const activeCase = conv.clientId ? activeCasesForClient(conv.clientId)[0] : null;
  const text = await draftReply(
    req,
    {
      channel: conv.channel as Channel,
      clientName: conv.client?.name ?? null,
      counterpartName: conv.counterpartName,
      thread: conv.messages.map((m) => ({ direction: m.direction as 'in' | 'out', body: m.body, sentAt: m.sentAt, senderName: m.senderName })),
      caseSummary: activeCase?.summary ?? null,
    },
    conv.clientId,
  );
  const draft = db().insert(schema.drafts).values({ conversationId: id, instruction: req.instruction, generatedText: text }).returning().get();
  return c.json(draft);
});

/** 送信 */
inboxRoutes.post('/conversations/:id/send', async (c) => {
  const id = Number(c.req.param('id'));
  const input = sendMessageSchema.parse(await c.req.json());
  const result = await sendToConversation(id, input);
  return c.json(result);
});

/** 送信文が返信待ちになるかの判定 */
inboxRoutes.post('/conversations/:id/judge-waiting', async (c) => {
  const id = Number(c.req.param('id'));
  const body = z.object({ text: z.string() }).parse(await c.req.json());
  const conv = getConversation(id);
  const r = await judgeWaiting(body.text, conv?.client?.name ?? conv?.counterpartName ?? null);
  return c.json(r);
});

inboxRoutes.get('/templates', (c) => c.json(listTemplates()));
