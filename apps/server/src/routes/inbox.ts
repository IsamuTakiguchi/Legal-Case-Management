import { Hono } from 'hono';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { listConversations, getConversation, markRead, setNeedsReply, archiveConversation, bulkUpdateConversations, linkMessage, setMessageDirection } from '../services/inbox.js';
import { createTask } from '../services/tasks.js';
import { linkConversationToClient, suggestClients } from '../services/identity.js';
import { linkConversationToContact, unlinkConversation, createContact, getContact } from '../services/contacts.js';
import { assignConversationAttachments } from '../services/attachments.js';
import { sendToConversation } from '../services/send.js';
import { staffAskContext, draftStaffAsk, sendStaffAsk, type StaffAskSource } from '../services/staffAsk.js';
import { scheduleMessage, listScheduled, updateScheduled, cancelScheduled, dispatchScheduled } from '../services/scheduledSend.js';
import { draftReply } from '../services/style.js';
import { judgeWaiting } from '../services/tasks.js';
import { listTemplates } from '../services/templates.js';
import { getSetting } from '../services/settings.js';
import { activeCasesForClient } from '../services/cases.js';
import { sendMessageSchema, draftRequestSchema, caseContactInputSchema, parseChatworkReactions, staffAskDraftSchema, staffAskSendSchema, type Channel } from '@lcm/shared';

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
      // show が指定されていればそれに従う（受信箱の表示切替）
      show: (['unanswered', 'mine-last', 'all', 'own'] as const).find((x) => x === q.show),
      // 既定では相手からの受信がある会話だけ（自分の送信だけの会話は outbound=1 のときだけ表示）
      inboundOnly: !q.show && q.outbound !== '1',
    }),
  );
});

/** 一括操作（対応済み・アーカイブ・アーカイブ解除・既読） */
/** メッセージ単位の紐付け（事務局の伝言など） */
/** メッセージの向き（受信／送信）を直す。自分が別の手段で送ったものが受信で入ったときの手直し */
inboxRoutes.put('/messages/:id/direction', async (c) => {
  const body = z.object({ direction: z.enum(['in', 'out']) }).parse(await c.req.json());
  const r = setMessageDirection(Number(c.req.param('id')), body.direction);
  return r.ok ? c.json(r) : c.json({ error: 'not found' }, 404);
});

/** メッセージの本文（タイムラインの「全文を表示」用。一覧では長文を切って返しているため） */
inboxRoutes.get('/messages/:id/body', (c) => {
  const m = db().select().from(schema.messages).where(eq(schema.messages.id, Number(c.req.param('id')))).get();
  if (!m) return c.json({ error: 'not found' }, 404);
  return c.json({ id: m.id, body: m.body, conversationId: m.conversationId });
});

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
  const scheduled = listScheduled({ conversationId: conv.id });
  // Chatwork はリアクション（ワンタップ返信）のボタンを一緒に返す
  const reactions = conv.channel === 'chatwork' ? parseChatworkReactions(getSetting('chatwork_reactions')) : [];
  return c.json({ ...conv, drafts, suggestions, scheduled, reactions });
});

inboxRoutes.post('/conversations/:id/link', async (c) => {
  const id = Number(c.req.param('id'));
  const body = z.object({ clientId: z.number().int() }).parse(await c.req.json());
  linkConversationToClient(id, body.clientId);
  const moved = await assignConversationAttachments(id, body.clientId);
  return c.json({ ok: true, movedAttachments: moved });
});

/**
 * 関係者（相手方・相手方代理人など）として紐付ける。
 * contactId を指定すれば既存の関係者に、caseId + contact を指定すればその事件に関係者を新規登録して紐付ける
 */
inboxRoutes.post('/conversations/:id/link-contact', async (c) => {
  const id = Number(c.req.param('id'));
  const body = z
    .object({ contactId: z.number().int().optional(), caseId: z.number().int().optional(), contact: caseContactInputSchema.partial({ emails: true }).optional() })
    .parse(await c.req.json());
  let contactId = body.contactId ?? null;
  if (!contactId) {
    if (!body.caseId || !body.contact?.name) return c.json({ error: '事件と関係者の名前を指定してください' }, 400);
    contactId = createContact(body.caseId, { ...body.contact, role: body.contact.role ?? 'other', emails: body.contact.emails ?? [] }).id;
  } else if (!getContact(contactId)) {
    return c.json({ error: '関係者が見つかりません' }, 404);
  }
  const r = linkConversationToContact(id, contactId);
  const moved = await assignConversationAttachments(id, r.kase.clientId);
  return c.json({ ok: true, contactId, caseId: r.kase.id, clientId: r.kase.clientId, movedAttachments: moved });
});

/** 依頼者・事件・関係者への紐付けをすべて外す */
inboxRoutes.post('/conversations/:id/unlink', (c) => c.json({ ok: true, conversation: unlinkConversation(Number(c.req.param('id'))) }));

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
      contactName: conv.contact?.name ?? null,
      contactRole: conv.contact?.roleLabel ?? null,
      contactCaseTitle: conv.contact?.caseTitle ?? null,
      thread: conv.messages.map((m) => ({ direction: m.direction as 'in' | 'out', body: m.body, sentAt: m.sentAt, senderName: m.senderName })),
      caseSummary: activeCase?.summary ?? null,
    },
    conv.clientId,
  );
  const draft = db().insert(schema.drafts).values({ conversationId: id, instruction: req.instruction, generatedText: text }).returning().get();
  return c.json(draft);
});

/** 事務局に確認するチャット（Chatwork）の下ごしらえ・下書き・送信 */
const convSource = (c: { req: { param: (k: string) => string } }, messageId?: number | null): StaffAskSource => ({
  kind: 'conversation',
  conversationId: Number(c.req.param('id')),
  messageId: messageId ?? null,
});

inboxRoutes.get('/conversations/:id/staff-ask', async (c) =>
  c.json(await staffAskContext(convSource(c, c.req.query('messageId') ? Number(c.req.query('messageId')) : null))),
);

inboxRoutes.post('/conversations/:id/staff-ask/draft', async (c) => {
  const body = staffAskDraftSchema.parse(await c.req.json().catch(() => ({})));
  return c.json(await draftStaffAsk(convSource(c, body.messageId), { instruction: body.instruction }));
});

inboxRoutes.post('/conversations/:id/staff-ask', async (c) => {
  const body = staffAskSendSchema.parse(await c.req.json());
  return c.json(await sendStaffAsk(convSource(c, body.messageId), body));
});

/**
 * リアクション（ワンタップ返信）。
 * Chatwork のリアクションは公開 API に無いので、そのメッセージへの返信として短い一言を送る。
 */
inboxRoutes.post('/conversations/:id/messages/:messageId/reaction', async (c) => {
  const id = Number(c.req.param('id'));
  const messageId = Number(c.req.param('messageId'));
  const body = z.object({ text: z.string().min(1).max(200) }).parse(await c.req.json());
  const conv = db().select().from(schema.conversations).where(eq(schema.conversations.id, id)).get();
  if (!conv) return c.json({ error: 'not found' }, 404);
  if (conv.channel !== 'chatwork') return c.json({ error: 'リアクションは Chatwork の会話だけで使えます' }, 400);
  // 設定にあるボタンの本文しか送らない（画面から任意の文面を送る口にしない）
  const reaction = parseChatworkReactions(getSetting('chatwork_reactions')).find((r) => r.text === body.text);
  if (!reaction) return c.json({ error: 'そのリアクションは設定にありません' }, 400);
  const r = await sendToConversation(id, { ...sendMessageSchema.parse({ text: reaction.text }), replyToMessageId: messageId }, { learn: false });
  return c.json({ ok: true, messageId: r.messageId, text: reaction.text });
});

/** 送信（scheduledAt があれば今は送らず予約する） */
inboxRoutes.post('/conversations/:id/send', async (c) => {
  const id = Number(c.req.param('id'));
  const input = sendMessageSchema.parse(await c.req.json());
  if (input.scheduledAt) {
    const scheduled = scheduleMessage(id, input, input.scheduledAt);
    return c.json({ scheduled });
  }
  const result = await sendToConversation(id, input);
  return c.json(result);
});

/** 送信予約の一覧（未送信のもの） */
inboxRoutes.get('/scheduled-messages', (c) => {
  const includeDone = c.req.query('all') === '1';
  return c.json(listScheduled({ includeDone }));
});

/** 送信予約の変更（時刻・本文） */
inboxRoutes.put('/scheduled-messages/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = z.object({ scheduledAt: z.string().datetime({ offset: true }).optional(), text: z.string().optional() }).parse(await c.req.json());
  return c.json(updateScheduled(id, body));
});

/** 送信予約の取消 */
inboxRoutes.delete('/scheduled-messages/:id', (c) => {
  return c.json(cancelScheduled(Number(c.req.param('id'))));
});

/** 予約を待たずに今すぐ送る */
inboxRoutes.post('/scheduled-messages/:id/send-now', async (c) => {
  const r = await dispatchScheduled(Number(c.req.param('id')), { force: true });
  if (!r.ok) return c.json({ error: r.error }, 400);
  return c.json(r.outcome);
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
