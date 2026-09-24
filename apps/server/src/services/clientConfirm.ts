import { and, desc, eq, lt } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { draftReply } from './style.js';
import { sendToConversation } from './send.js';
import { createTask, defaultFollowUp } from './tasks.js';
import { staffByChatworkAccount } from './staff.js';
import { clientOwnConversations } from './contacts.js';
import { activeCasesForClient } from './cases.js';
import { availableChannels, ensureClientConversation } from './hearingNotice.js';
import { stripChatworkMarkup } from '../channels/chatwork.js';
import { isConfigured } from '../config.js';
import { logger } from '../logger.js';
import { CHANNEL_LABEL, familyName, formatJaDateTime } from '@lcm/shared';

/**
 * 事務局から Chatwork で来た質問（「◯◯さんに△△を確認してください」など）を、
 * 弁護士本人が依頼者に確認する文に組み立て直して、Gmail か LINE で依頼者に送る。
 * 送ったら、元の質問に Chatwork で「確認しました」と返せる。
 */

/** 依頼者への確認に使えるチャネル */
export const CONFIRM_CHANNELS = ['gmail', 'line'] as const;
export type ConfirmChannel = (typeof CONFIRM_CHANNELS)[number];
/** 画面や事務局への返事に出す短い名前（「LINE公式」ではなく「LINE」） */
const SHORT_LABEL: Record<ConfirmChannel, string> = { gmail: 'Gmail', line: 'LINE' };

export interface ClientConfirmChannel {
  channel: ConfirmChannel;
  label: string;
  /** 宛先（メールアドレス、LINE） */
  to: string;
  /** 依頼者本人との既存の会話（無ければ送ったときに作る） */
  conversationId: number | null;
  /** Gmail の既存スレッドの件名（返信になる）。新しいスレッドなら null */
  subject: string | null;
  lastMessageAt: string | null;
}

/** 元の質問に付ける「依頼者に確認済み」の控え */
export interface ClientConfirmRecord {
  channel: ConfirmChannel;
  conversationId: number;
  messageId: number;
  clientId: number;
  at: string;
}

export interface ClientConfirmContext {
  messageId: number;
  /** 質問が来た Chatwork の会話 */
  conversationId: number;
  question: { senderName: string | null; sentAt: string; body: string };
  /** 直前のやり取り（質問の前提になっていることがある） */
  earlier: { senderName: string | null; direction: string; sentAt: string; body: string }[];
  /** 事務局メンバーからの質問か */
  fromStaff: boolean;
  staffName: string | null;
  clientId: number | null;
  clientName: string | null;
  caseId: number | null;
  caseTitle: string | null;
  cases: { id: number; title: string }[];
  channels: ClientConfirmChannel[];
  defaultChannel: ConfirmChannel | null;
  defaultFollowUpAt: string;
  /** Chatwork で事務局に返す一言の既定 */
  staffReplyText: string;
  /** これまでにこの質問から依頼者に確認した記録 */
  sent: ClientConfirmRecord[];
  /** 送れない理由（依頼者未選択、連絡先なし など） */
  blocked: string | null;
}

type MessageRow = typeof schema.messages.$inferSelect;

function loadQuestion(messageId: number) {
  const d = db();
  const msg = d.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
  if (!msg) throw new Error('メッセージが見つかりません');
  const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, msg.conversationId)).get();
  if (!conv) throw new Error('会話が見つかりません');
  if (conv.channel !== 'chatwork') throw new Error('依頼者への確認は、Chatwork で届いた質問から作れます');
  if (msg.direction !== 'in') throw new Error('自分が送ったメッセージからは作れません');
  return { msg, conv };
}

function recordsOf(msg: MessageRow): ClientConfirmRecord[] {
  const raw = (msg.raw ?? {}) as { clientConfirms?: ClientConfirmRecord[] };
  return Array.isArray(raw.clientConfirms) ? raw.clientConfirms : [];
}

function staffReply(clientName: string | null, channel: ConfirmChannel | null): string {
  const who = clientName ? `${familyName(clientName)}さん` : '依頼者';
  return `${who}に${channel ? `${SHORT_LABEL[channel]}で` : ''}確認しました。回答が来たら共有します。`;
}

/** 依頼者本人に送れる Gmail / LINE と、それぞれの既存の会話 */
function confirmChannels(client: typeof schema.clients.$inferSelect): ClientConfirmChannel[] {
  const own = clientOwnConversations(client.id).filter((c) => !c.archived);
  return availableChannels(client)
    .filter((x): x is { channel: ConfirmChannel; to: string } => (CONFIRM_CHANNELS as readonly string[]).includes(x.channel))
    .map((x) => {
      // ensureClientConversation と同じく、そのチャネルでいちばん新しい会話に送る
      const conv = own.filter((c) => c.channel === x.channel).sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''))[0] ?? null;
      const isNewGmail = !conv || conv.externalThreadId.startsWith('new:');
      return {
        channel: x.channel,
        label: SHORT_LABEL[x.channel],
        to: x.to,
        conversationId: conv?.id ?? null,
        subject: x.channel === 'gmail' && !isNewGmail ? (conv?.subject ?? null) : null,
        lastMessageAt: conv?.lastMessageAt ?? null,
      };
    });
}

export function clientConfirmContext(messageId: number, opts: { clientId?: number | null; caseId?: number | null } = {}): ClientConfirmContext {
  const d = db();
  const { msg, conv } = loadQuestion(messageId);
  // Chatwork の送信者はアカウント ID（senderAddress）で分かる
  const staff = staffByChatworkAccount(Number(msg.senderAddress ?? 0) || null);
  const fromStaff = !!staff || !!(conv.meta as { staff?: boolean }).staff;

  // 依頼者: 画面で選んだもの → 伝言に紐付けたもの → 会話の依頼者
  const clientId = opts.clientId ?? msg.clientId ?? conv.clientId ?? null;
  const client = clientId ? (d.select().from(schema.clients).where(eq(schema.clients.id, clientId)).get() ?? null) : null;
  const cases = client ? activeCasesForClient(client.id).map((k) => ({ id: k.id, title: k.title })) : [];
  // 事件: 画面で選んだもの → 伝言の事件（依頼者を選び直していなければ） → 進行中の事件の先頭。その依頼者の事件に限る
  const sameClient = !opts.clientId || opts.clientId === (msg.clientId ?? conv.clientId);
  const wanted = opts.caseId ?? (sameClient ? (msg.caseId ?? conv.caseId ?? null) : null);
  const wantedCase = wanted ? (d.select().from(schema.cases).where(eq(schema.cases.id, wanted)).get() ?? null) : null;
  const kase = client && wantedCase?.clientId === client.id ? wantedCase : client && cases[0] ? (d.select().from(schema.cases).where(eq(schema.cases.id, cases[0].id)).get() ?? null) : null;

  // 伝言に付いていた事件が終了済みでも、選択肢には出す
  const caseList = kase && !cases.some((k) => k.id === kase.id) ? [{ id: kase.id, title: kase.title }, ...cases] : cases;
  const channels = client ? confirmChannels(client) : [];
  const preferred = client?.preferredChannel as ConfirmChannel | null | undefined;
  const byRecent = [...channels].sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
  const defaultChannel = channels.find((c) => c.channel === preferred)?.channel ?? byRecent[0]?.channel ?? null;

  const earlier = d
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conv.id), lt(schema.messages.sentAt, msg.sentAt)))
    .orderBy(desc(schema.messages.sentAt))
    .limit(3)
    .all()
    .reverse()
    .map((m) => ({ senderName: m.senderName, direction: m.direction, sentAt: m.sentAt, body: stripChatworkMarkup(m.body).slice(0, 800) }));

  const blocked = !client
    ? 'どの依頼者への確認かを選んでください'
    : channels.length === 0
      ? `${client.name}さんのメールアドレスか LINE が登録されていないか、Gmail・LINE が未設定です`
      : null;

  return {
    messageId: msg.id,
    conversationId: conv.id,
    question: { senderName: msg.senderName, sentAt: msg.sentAt, body: stripChatworkMarkup(msg.body) },
    earlier,
    fromStaff,
    staffName: staff?.name ?? (fromStaff ? msg.senderName : null),
    clientId: client?.id ?? null,
    clientName: client?.name ?? null,
    caseId: kase?.id ?? null,
    caseTitle: kase?.title ?? null,
    cases: caseList,
    channels,
    defaultChannel,
    defaultFollowUpAt: defaultFollowUp().toISOString(),
    staffReplyText: staffReply(client?.name ?? null, defaultChannel),
    sent: recordsOf(msg),
    blocked,
  };
}

/** AI への指示（事務局の質問を、弁護士本人から依頼者への確認に組み立て直す） */
export function confirmInstruction(ctx: Pick<ClientConfirmContext, 'question' | 'earlier' | 'staffName' | 'caseTitle'>, extra?: string | null): string {
  const earlier = ctx.earlier.map((m) => `[${m.direction === 'out' ? '弁護士' : (m.senderName ?? '事務局')}] ${m.body}`).join('\n');
  return [
    '事務局（事務所の職員）から、依頼者に確認してほしいことが届きました。これを、弁護士本人が依頼者に直接確認するメッセージに書き直してください。',
    '・事務局や職員の名前、「事務局から」「先生に確認」など事務所の内部のやり取りは書かない。弁護士本人が尋ねている文にする。',
    '・確認したい事項は漏らさず、依頼者が答えやすいように書く。2 つ以上あれば番号を付けて並べる。',
    '・なぜ確認が必要かが質問から分かれば一言添える。分からなければ理由は作らない。',
    '・質問に無い事実・期限・金額は足さない。期限が書かれていればそのまま入れる。',
    ctx.caseTitle ? `・事件: ${ctx.caseTitle}` : '',
    '',
    `【事務局からの質問${ctx.staffName ? `（${ctx.staffName}）` : ''}】`,
    ctx.question.body,
    earlier ? `\n【その前のやり取り（参考。ここから確認事項を増やさない）】\n${earlier}` : '',
    extra ? `\n【弁護士からの追加の指示（最優先）】\n${extra}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function pickChannel(ctx: ClientConfirmContext, channel: ConfirmChannel) {
  if (ctx.blocked) throw new Error(ctx.blocked);
  const ch = ctx.channels.find((c) => c.channel === channel);
  if (!ch) throw new Error(`${CHANNEL_LABEL[channel]}では送れません（連絡先が未登録か、未設定です）`);
  return ch;
}

/** 依頼者への確認文を、本人の文体で下書きする */
export async function draftClientConfirm(messageId: number, input: { clientId?: number | null; caseId?: number | null; channel: ConfirmChannel; instruction?: string | null }) {
  const ctx = clientConfirmContext(messageId, input);
  const ch = pickChannel(ctx, input.channel);
  if (!isConfigured('anthropic')) throw new Error('AI（Anthropic API キー）が未設定のため下書きを作れません。本文を直接入力してください');
  const d = db();
  const thread = ch.conversationId
    ? d
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, ch.conversationId))
        .orderBy(desc(schema.messages.sentAt))
        .limit(8)
        .all()
        .reverse()
        .map((m) => ({ direction: m.direction as 'in' | 'out', body: m.body.slice(0, 1500), sentAt: m.sentAt, senderName: m.senderName }))
    : [];
  const kase = ctx.caseId ? d.select().from(schema.cases).where(eq(schema.cases.id, ctx.caseId)).get() : null;
  const text = await draftReply(
    { conversationId: ch.conversationId ?? 0, instruction: confirmInstruction(ctx, input.instruction), templateKey: null, extra: {} },
    { channel: input.channel, clientName: ctx.clientName, counterpartName: ctx.clientName, thread, caseSummary: kase?.summary ?? null },
    ctx.clientId,
  );
  // 新しい Gmail スレッドになるときは件名も用意する
  const subject = input.channel === 'gmail' && !ch.subject ? `ご確認のお願い${ctx.caseTitle ? `（${ctx.caseTitle}）` : ''}` : null;
  return { text, subject };
}

export interface ClientConfirmSendInput {
  clientId: number;
  caseId?: number | null;
  channel: ConfirmChannel;
  text: string;
  /** 新しい Gmail スレッドの件名（既存スレッドへの返信では使わない） */
  subject?: string | null;
  /** 依頼者の回答待ちタスクを作る */
  createWaitingTask?: boolean;
  followUpAt?: string | null;
  /** 元の質問に Chatwork で返信して、事務局に知らせる */
  notifyStaff?: boolean;
  staffReplyText?: string | null;
}

/** 依頼者に確認を送る。続けて回答待ちタスクと、事務局への返事 */
export async function sendClientConfirm(messageId: number, input: ClientConfirmSendInput) {
  if (!input.text.trim()) throw new Error('依頼者に送る本文を入力してください');
  const ctx = clientConfirmContext(messageId, { clientId: input.clientId, caseId: input.caseId ?? null });
  pickChannel(ctx, input.channel);
  const d = db();
  const client = d.select().from(schema.clients).where(eq(schema.clients.id, input.clientId)).get()!;

  const conv = ensureClientConversation(client, input.channel);
  // 新しい Gmail スレッドなら件名を入れておく（既存スレッドは Re: で返信）
  if (input.channel === 'gmail' && conv.externalThreadId.startsWith('new:')) {
    const subject = input.subject?.trim() || `ご確認のお願い${ctx.caseTitle ? `（${ctx.caseTitle}）` : ''}`;
    d.update(schema.conversations).set({ subject }).where(eq(schema.conversations.id, conv.id)).run();
  }
  const r = await sendToConversation(conv.id, { text: input.text, attachmentIds: [], driveFiles: [], createWaitingTask: false });
  if (ctx.caseId) d.update(schema.messages).set({ caseId: ctx.caseId, clientId: client.id }).where(eq(schema.messages.id, r.messageId)).run();

  // 元の質問に「確認済み」を残す。依頼者・事件が未紐付けだったら、ここで紐付ける
  const q = d.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get()!;
  const record: ClientConfirmRecord = { channel: input.channel, conversationId: conv.id, messageId: r.messageId, clientId: client.id, at: new Date().toISOString() };
  d.update(schema.messages)
    .set({
      raw: { ...((q.raw ?? {}) as Record<string, unknown>), clientConfirms: [...recordsOf(q), record] },
      ...(q.clientId ? {} : { clientId: client.id, caseId: ctx.caseId }),
    })
    .where(eq(schema.messages.id, messageId))
    .run();

  let waitingTaskId: number | null = null;
  if (input.createWaitingTask) {
    const firstLine = input.text.split('\n').map((l) => l.trim()).find((l) => l && !l.endsWith('様') && !/^お世話になって/.test(l)) ?? '';
    const t = await createTask({
      title: `${client.name}さんの回答待ち: ${firstLine.slice(0, 40)}`,
      clientId: client.id,
      caseId: ctx.caseId,
      conversationId: conv.id,
      status: 'waiting_client',
      followUpAt: input.followUpAt ?? ctx.defaultFollowUpAt,
      note: `事務局${ctx.staffName ? `（${ctx.staffName}）` : ''}からの質問:\n${ctx.question.body}`,
      syncToChatwork: false,
    });
    waitingTaskId = t.id;
  }

  // 事務局への返事は、依頼者に送れたあとの「おまけ」。失敗しても依頼者への送信は取り消さない
  let staffNotified = false;
  let staffError: string | null = null;
  if (input.notifyStaff) {
    const text = input.staffReplyText?.trim() || staffReply(client.name, input.channel);
    try {
      await sendToConversation(ctx.conversationId, { text, attachmentIds: [], driveFiles: [], createWaitingTask: false, replyToMessageId: messageId }, { learn: false });
      staffNotified = true;
    } catch (err) {
      staffError = (err as Error).message;
      logger.warn({ err, messageId }, '事務局への返事（Chatwork）に失敗しました');
    }
  }

  logger.info({ messageId, clientId: client.id, channel: input.channel, conversationId: conv.id }, '事務局の質問を依頼者に確認しました');
  return { channel: input.channel, conversationId: conv.id, messageId: r.messageId, note: r.note ?? null, waitingTaskId, staffNotified, staffError, sentAt: formatJaDateTime(new Date()) };
}

