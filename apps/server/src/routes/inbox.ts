import { Hono } from 'hono';
import { logger } from '../logger.js';
import { suggestRequestedFiles, canSuggestFiles } from '../services/attachmentSuggest.js';
import { z } from 'zod';
import { recordSentElsewhere } from '../services/manualRecord.js';
import { eq, desc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { listConversations, getConversation, markRead, setNeedsReply, archiveConversation, bulkUpdateConversations, linkMessage, setMessageDirection, staleUnanswered, clearStaleUnanswered } from '../services/inbox.js';
import { createTask } from '../services/tasks.js';
import { linkConversationToClient, suggestClients } from '../services/identity.js';
import { linkConversationToContact, unlinkConversation, createContact, getContact } from '../services/contacts.js';
import { assignConversationAttachments } from '../services/attachments.js';
import { sendToConversation } from '../services/send.js';
import { ccSuggestions } from '../services/ccSuggest.js';
import { relayContext, draftRelay, sendRelay } from '../services/relay.js';
import { saveOutboundUpload, removeOutboundUploads } from '../services/outboundUploads.js';
import { staffAskContext, draftStaffAsk, sendStaffAsk, type StaffAskSource } from '../services/staffAsk.js';
import { clientConfirmContext, draftClientConfirm, sendClientConfirm, CONFIRM_CHANNELS } from '../services/clientConfirm.js';
import { pendingHoldsFor } from '../services/court.js';
import { setConversationPerson, listClientPersons, getClientPerson } from '../services/clientPersons.js';
import { scheduleMessage, listScheduled, updateScheduled, cancelScheduled, dispatchScheduled } from '../services/scheduledSend.js';
import { draftReply } from '../services/style.js';
import { judgeWaiting } from '../services/tasks.js';
import { listTemplates } from '../services/templates.js';
import { getSetting } from '../services/settings.js';
import { activeCasesForClient, taskDeadlinesOf } from '../services/cases.js';
import { memoSuggestionsFor, openMemos } from '../services/memos.js';
import { suggestConversationTasks, createConversationTasks } from '../services/conversationTasks.js';
import { clientSendTargets, startClientConversation, staffSendTargets, startRoomConversation, contactSendTargets, startContactConversation } from '../services/newMessage.js';
import { sendMessageSchema, draftRequestSchema, caseContactInputSchema, parseChatworkReactions, staffAskDraftSchema, staffAskSendSchema, TASK_STATUSES, NEW_TASK_STATUSES, type Channel } from '@lcm/shared';

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

/**
 * メッセージをそのままタスクにする（伝言・メール・LINE のタスク化）。
 * 事件は、指定があればそれ → メッセージの事件 → 会話の事件（関係者との会話ならその事件）
 */
inboxRoutes.post('/messages/:id/task', async (c) => {
  const body = z
    .object({
      title: z.string().max(200).optional(),
      /** 締切（日付だけ YYYY-MM-DD でも可） */
      due: z.string().nullable().optional(),
      /** 返信期限（連絡待ちのとき。空なら設定の営業日数後） */
      replyBy: z.string().nullable().optional(),
      /** 旧形式（締切、または連絡待ちなら返信期限） */
      followUpAt: z.string().nullable().optional(),
      note: z.string().max(4000).nullable().optional(),
      syncToChatwork: z.boolean().default(false),
      caseId: z.number().int().nullable().optional(),
      status: z.enum(NEW_TASK_STATUSES).optional(),
    })
    .parse(await c.req.json().catch(() => ({})));
  const m = db().select().from(schema.messages).where(eq(schema.messages.id, Number(c.req.param('id')))).get();
  if (!m) return c.json({ error: 'not found' }, 404);
  const conv = db().select().from(schema.conversations).where(eq(schema.conversations.id, m.conversationId)).get();
  // 題名の既定: メールなら件名、無ければ本文の最初の行
  const firstLine = m.body.split('\n').map((l) => l.trim()).find(Boolean);
  const title = (body.title?.trim() || (conv?.channel === 'gmail' ? conv.subject?.trim() : '') || firstLine || '伝言').slice(0, 120);
  // 事件: 指定があればそれ（null は「事件に付けない」）、無ければメッセージ・会話の事件
  const caseId = body.caseId !== undefined ? body.caseId : (m.caseId ?? conv?.caseId ?? null);
  const clientId = m.clientId ?? conv?.clientId ?? null;
  if (caseId) {
    const k = db().select({ clientId: schema.cases.clientId }).from(schema.cases).where(eq(schema.cases.id, caseId)).get();
    if (!k) return c.json({ error: '事件が見つかりません' }, 400);
    if (clientId && k.clientId !== clientId) return c.json({ error: 'このメッセージの依頼者の事件ではありません' }, 400);
  }
  const status = body.status ?? 'open';
  const deadlines =
    body.due !== undefined || body.replyBy !== undefined
      ? taskDeadlinesOf({ due: body.due ?? null, replyBy: body.replyBy ?? null }, status)
      : { followUpAt: body.followUpAt ?? null };
  const task = await createTask({
    title,
    note: body.note?.trim() || m.body,
    clientId: caseId ? null : clientId,
    caseId,
    conversationId: m.conversationId,
    status,
    ...deadlines,
    sourceMessageId: m.id,
    syncToChatwork: body.syncToChatwork,
  });
  return c.json(task);
});

/** 未返信の内訳（アイコンやメニューの数が大きいときに、何が効いているかを見る） */
inboxRoutes.get('/conversations/stale', (c) => {
  const days = Math.min(3650, Math.max(1, Number(c.req.query('days') ?? 30) || 30));
  const { ids, ...rest } = staleUnanswered(days);
  return c.json({ days, ...rest, sample: ids.slice(0, 5) });
});

/** しばらく動きのない未返信をまとめて片付ける */
inboxRoutes.post('/conversations/stale/clear', async (c) => {
  const body = z.object({ days: z.number().int().min(1).max(3650), action: z.enum(['resolve', 'archive']).default('resolve') }).parse(await c.req.json());
  return c.json({ updated: clearStaleUnanswered(body.days, body.action) });
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
  // この相手と調整中の仮押さえの数（会話の画面から確定できることを知らせる）
  const pendingHolds = pendingHoldsFor({ conversationId: conv.id, clientId: conv.clientId ?? null }).length;
  // 法人の担当者（会話の相手の担当者と、選び直す候補）
  const clientPerson = conv.clientPersonId ? getClientPerson(conv.clientPersonId) : null;
  const clientPersons = conv.clientId ? listClientPersons(conv.clientId).map((p) => ({ id: p.id, name: p.name, title: p.title })) : [];
  // 時期未定の宿題の候補（まだ備忘に登録していないもの）と、この相手の時期未定の備忘
  const memoSuggestions = memoSuggestionsFor(conv.id);
  const memos = openMemos({ clientId: conv.clientId ?? null, caseId: conv.contact?.caseId ?? null }).map((t) => ({ id: t.id, title: t.title, trigger: t.trigger, reviewAt: t.reviewAt }));
  return c.json({ ...conv, drafts, suggestions, scheduled, reactions, pendingHolds, memoSuggestions, memos, clientPerson: clientPerson ? { id: clientPerson.id, name: clientPerson.name, title: clientPerson.title } : null, clientPersons });
});

/**
 * 依頼者に紐付ける。personId / newPerson を付けると、相手を依頼者のご家族・窓口（法人なら担当者）として紐付ける
 * （ご本人ではなく、ご家族が連絡してくる場合など）
 */
inboxRoutes.post('/conversations/:id/link', async (c) => {
  const id = Number(c.req.param('id'));
  const body = z
    .object({
      clientId: z.number().int(),
      personId: z.number().int().nullable().optional(),
      newPerson: z.object({ name: z.string().trim().min(1).max(100), title: z.string().trim().max(100).nullable().optional() }).nullable().optional(),
    })
    .parse(await c.req.json());
  // 紐付けてから担当者で失敗しないよう、先に確かめる
  if (body.personId && getClientPerson(body.personId)?.clientId !== body.clientId) return c.json({ error: 'この依頼者の窓口・担当者ではありません' }, 400);
  linkConversationToClient(id, body.clientId);
  const person = body.personId || body.newPerson ? setConversationPerson(id, { personId: body.personId ?? null, newPerson: body.newPerson ?? null }).person : null;
  const moved = await assignConversationAttachments(id, body.clientId);
  return c.json({ ok: true, movedAttachments: moved, person: person ? { id: person.id, name: person.name, title: person.title } : null });
});

/** 会話の相手を法人の担当者に決める（既存の担当者・新しい担当者・会社/代表として） */
// ---- こちらから新しく送る（依頼者・事務局） ----

/** 依頼者に送れる宛先（チャネル・担当者や窓口）と、送れない理由 */
inboxRoutes.get('/clients/:id/send-targets', (c) => c.json(clientSendTargets(Number(c.req.param('id')))));

/** 依頼者との会話を開く（無ければ作る）。メールは件名を付けた新しいメール、または前のメールの続き */
inboxRoutes.post('/clients/:id/start-conversation', async (c) => {
  const body = z
    .object({
      channel: z.enum(['gmail', 'line', 'chatwork']),
      personId: z.number().int().nullable().optional(),
      subject: z.string().max(200).nullable().optional(),
      threadConversationId: z.number().int().nullable().optional(),
    })
    .parse(await c.req.json());
  return c.json(startClientConversation(Number(c.req.param('id')), body));
});

/** 関係者（相手方代理人・保険会社など）に送れる宛先と、送れない理由 */
inboxRoutes.get('/contacts/:id/send-targets', (c) => c.json(contactSendTargets(Number(c.req.param('id')))));

/** 関係者との会話を開く（無ければ作る）。メールは件名を付けた新しいメール、または前のメールの続き */
inboxRoutes.post('/contacts/:id/start-conversation', async (c) => {
  const body = z
    .object({ channel: z.enum(['gmail', 'line']), subject: z.string().max(200).nullable().optional(), threadConversationId: z.number().int().nullable().optional() })
    .parse(await c.req.json());
  return c.json(startContactConversation(Number(c.req.param('id')), body));
});

/** 事務局に送る宛先（Chatwork のルームと事務局メンバー） */
inboxRoutes.get('/staff/send-targets', async (c) => c.json(await staffSendTargets()));

/** Chatwork のルームとの会話を開く（無ければ作る） */
inboxRoutes.post('/chatwork/rooms/:roomId/start-conversation', async (c) => {
  const body = z.object({ name: z.string().max(200).nullable().optional() }).parse(await c.req.json().catch(() => ({})));
  return c.json(startRoomConversation(Number(c.req.param('roomId')), body.name ?? null));
});

/** 会話のやり取りからタスクの案を作る（画面で直してから登録する） */
inboxRoutes.post('/conversations/:id/task-suggestions', async (c) => c.json(await suggestConversationTasks(Number(c.req.param('id')))));

/** 会話からタスクを登録する（この会話・依頼者・事件に紐付く） */
inboxRoutes.post('/conversations/:id/tasks', async (c) => {
  const body = z
    .object({
      tasks: z
        .array(z.object({ title: z.string().max(200), due: z.string().nullable().optional(), replyBy: z.string().nullable().optional(), status: z.enum(TASK_STATUSES).optional(), note: z.string().max(2000).nullable().optional() }))
        .min(1)
        .max(10),
      caseId: z.number().int().nullable().optional(),
      syncToChatwork: z.boolean().optional(),
    })
    .parse(await c.req.json());
  return c.json(await createConversationTasks(Number(c.req.param('id')), body));
});

inboxRoutes.post('/conversations/:id/person', async (c) => {
  const body = z
    .object({ personId: z.number().int().nullable().optional(), newPerson: z.object({ name: z.string().trim().min(1).max(100), title: z.string().trim().max(100).nullable().optional() }).nullable().optional() })
    .parse(await c.req.json());
  return c.json(setConversationPerson(Number(c.req.param('id')), body));
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
  // 法人の担当者とのやり取りなら、その人に宛てる
  const person = conv.clientPersonId ? getClientPerson(conv.clientPersonId) : null;
  // 資料の提供を頼まれていたら、依頼者・事件のフォルダから添付の候補を探す（見つかれば本文でも添付に触れる）
  const attachments = canSuggestFiles(id)
    ? await suggestRequestedFiles(id).catch((err) => {
        logger.warn({ err, conversationId: id }, '添付の候補探しに失敗（下書きはそのまま作ります）');
        return null;
      })
    : null;
  const attachNote = attachments?.files.length
    ? `\n（この返信には次のファイルを添付する: ${attachments.files.map((f) => f.name).join('、')}。本文では、ご依頼の資料を添付した旨を自然に書く。ファイル名を並べる必要はない）${attachments.note ? `\n（見つからなかった資料: ${attachments.note}。その資料は追ってお送りする旨を書く）` : ''}`
    : '';
  const text = await draftReply(
    attachNote ? { ...req, instruction: `${req.instruction ?? ''}${attachNote}`.trim() } : req,
    {
      channel: conv.channel as Channel,
      clientName: conv.client?.name ?? null,
      counterpartName: conv.counterpartName,
      contactName: conv.contact?.name ?? null,
      contactRole: conv.contact?.roleLabel ?? null,
      contactCaseTitle: conv.contact?.caseTitle ?? null,
      personName: person?.name ?? null,
      personTitle: person?.title ?? null,
      thread: conv.messages.map((m) => ({ direction: m.direction as 'in' | 'out', body: m.body, sentAt: m.sentAt, senderName: m.senderName })),
      caseSummary: activeCase?.summary ?? null,
    },
    conv.clientId,
  );
  const draft = db().insert(schema.drafts).values({ conversationId: id, instruction: req.instruction, generatedText: text }).returning().get();
  return c.json({ ...draft, attachments });
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
  return c.json(await draftStaffAsk(convSource(c, body.messageId), { instruction: body.instruction, mode: body.mode }));
});

inboxRoutes.post('/conversations/:id/staff-ask', async (c) => {
  const body = staffAskSendSchema.parse(await c.req.json());
  return c.json(await sendStaffAsk(convSource(c, body.messageId), body));
});

// ---- 連絡の取次ぎ: 依頼者からの連絡を相手方代理人などに、相手方代理人などからの連絡を依頼者に伝える ----

inboxRoutes.get('/messages/:messageId/relay', (c) => c.json(relayContext(Number(c.req.param('messageId')), { caseId: c.req.query('caseId') ? Number(c.req.query('caseId')) : null })));

inboxRoutes.post('/messages/:messageId/relay/draft', async (c) => {
  const body = z.object({ caseId: z.number().int().nullable().optional(), targetKey: z.string().min(1), instruction: z.string().max(2000).nullable().optional() }).parse(await c.req.json());
  return c.json(await draftRelay(Number(c.req.param('messageId')), body));
});

inboxRoutes.post('/messages/:messageId/relay', async (c) => {
  const body = z
    .object({
      caseId: z.number().int().nullable().optional(),
      targetKey: z.string().min(1),
      text: z.string().min(1),
      subject: z.string().max(200).nullable().optional(),
      createWaitingTask: z.boolean().optional(),
      followUpAt: z.string().datetime({ offset: true }).nullable().optional(),
      manual: z.boolean().optional(),
    })
    .parse(await c.req.json());
  return c.json(await sendRelay(Number(c.req.param('messageId')), body));
});

/**
 * 事務局から Chatwork で来た質問を、弁護士本人からの確認に書き直して依頼者に Gmail / LINE で送る
 * （下ごしらえ・本人の文体で下書き・送信）
 */
const optId = (v: string | undefined) => (v ? Number(v) : null);
inboxRoutes.get('/messages/:messageId/client-confirm', (c) =>
  c.json(clientConfirmContext(Number(c.req.param('messageId')), { clientId: optId(c.req.query('clientId')), caseId: optId(c.req.query('caseId')) })),
);

inboxRoutes.post('/messages/:messageId/client-confirm/draft', async (c) => {
  const body = z
    .object({
      clientId: z.number().int().nullable().optional(),
      caseId: z.number().int().nullable().optional(),
      channel: z.enum(CONFIRM_CHANNELS),
      personId: z.number().int().nullable().optional(),
      instruction: z.string().max(2000).nullable().optional(),
    })
    .parse(await c.req.json());
  return c.json(await draftClientConfirm(Number(c.req.param('messageId')), body));
});

inboxRoutes.post('/messages/:messageId/client-confirm', async (c) => {
  const body = z
    .object({
      clientId: z.number().int(),
      caseId: z.number().int().nullable().optional(),
      channel: z.enum(CONFIRM_CHANNELS),
      personId: z.number().int().nullable().optional(),
      text: z.string().min(1),
      subject: z.string().max(200).nullable().optional(),
      createWaitingTask: z.boolean().optional(),
      followUpAt: z.string().datetime({ offset: true }).nullable().optional(),
      notifyStaff: z.boolean().optional(),
      // 送信予約（今は送らず、この時刻に送る）
      scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
      staffReplyText: z.string().max(2000).nullable().optional(),
      // CC・BCC（Gmail だけ）
      cc: z.array(z.string().trim().email()).max(20).optional(),
      bcc: z.array(z.string().trim().email()).max(20).optional(),
    })
    .parse(await c.req.json());
  return c.json(await sendClientConfirm(Number(c.req.param('messageId')), body));
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

/** 送信に添付する、パソコンから選んだファイルを一時置き場に上げる（送信のときに uploadIds で指定する） */
inboxRoutes.post('/outbound-uploads', async (c) => {
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) return c.json({ error: 'ファイルを指定してください' }, 400);
  return c.json(saveOutboundUpload(file.name, file.type || null, Buffer.from(await file.arrayBuffer())));
});

/** 選んだファイルを外したとき（送らずに消す） */
inboxRoutes.delete('/outbound-uploads/:id', (c) => {
  removeOutboundUploads([c.req.param('id')]);
  return c.json({ ok: true });
});

/** Gmail で送るときの CC の既定（前回の CC）と候補（依頼者のほかのアドレス・担当者・これまでの CC） */
inboxRoutes.get('/conversations/:id/cc-suggestions', (c) => {
  const conv = db().select().from(schema.conversations).where(eq(schema.conversations.id, Number(c.req.param('id')))).get();
  if (!conv) return c.json({ error: 'not found' }, 404);
  if (conv.channel !== 'gmail') return c.json({ defaults: [], candidates: [] });
  return c.json(ccSuggestions({ clientId: conv.clientId, toAddress: conv.counterpartAddress, conversationId: conv.id }));
});

/** 会話をまだ決めていないとき（依頼者に確認など）の CC の既定と候補。to は送るメールアドレス */
inboxRoutes.get('/clients/:id/cc-suggestions', (c) => c.json(ccSuggestions({ clientId: Number(c.req.param('id')), toAddress: c.req.query('to') ?? null })));

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

/** LINE アプリなど、アプリの外で送ったメッセージを記録する（相手には送らない） */
inboxRoutes.post('/conversations/:id/record-sent', async (c) => {
  const body = z.object({ text: z.string().max(20000), sentAt: z.string().datetime({ offset: true }).nullable().optional() }).parse(await c.req.json());
  return c.json(await recordSentElsewhere(Number(c.req.param('id')), body));
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
