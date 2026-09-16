import { eq, desc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getSetting, getSettingInt } from './settings.js';
import { sendToConversation } from './send.js';
import { draftReply } from './style.js';
import { createTask } from './tasks.js';
import { addBusinessDays, toJstParts, type Channel } from '@lcm/shared';
import { logger } from '../logger.js';

/**
 * 仮押さえた候補日を、そのまま依頼者に打診する。
 * 「10/5 10:00-」のように候補を並べた文を組み立て、依頼者との会話から送る。
 */

const WD = ['日', '月', '火', '水', '木', '金', '土'];

export interface HoldProposalConversation {
  id: number;
  channel: string;
  counterpartName: string | null;
  lastMessageAt: string | null;
  /** 依頼者に設定された「いつも使うチャネル」か */
  preferred: boolean;
}

export interface HoldProposalContext {
  sessionId: number;
  /** 打合せ・面談・期日 */
  kind: string;
  clientId: number | null;
  clientName: string | null;
  candidates: { startAt: string; endAt: string }[];
  /** 送り先に選べる、依頼者との会話 */
  conversations: HoldProposalConversation[];
  defaultConversationId: number | null;
  /** テンプレートから組み立てた本文 */
  text: string;
  /** 返事待ちタスクの既定の期限 */
  defaultFollowUpAt: string;
  /** 送れない理由（依頼者が未紐付け、会話が無いなど） */
  blocked: string | null;
}

/** 候補 1 件の行（設定の形に当てはめる） */
export function formatSlotLine(startAt: string, endAt: string, format: string): string {
  const s = toJstParts(new Date(startAt));
  const e = toJstParts(new Date(endAt));
  const hm = (p: { hour: number; minute: number }) => `${p.hour}:${String(p.minute).padStart(2, '0')}`;
  return format
    .replace(/\{M\}/g, String(s.month))
    .replace(/\{D\}/g, String(s.day))
    .replace(/\{wd\}/g, WD[s.weekday]!)
    .replace(/\{start\}/g, hm(s))
    .replace(/\{end\}/g, hm(e));
}

/** 打診の本文を組み立てる */
export function buildProposalText(input: { kind: string; clientName: string | null; candidates: { startAt: string; endAt: string }[] }): string {
  const lineFormat = getSetting('hold_proposal_slot_format') || '{M}/{D} {start}-';
  const template = getSetting('hold_proposal_template') || '{kind}の候補日ですが、\n{slots}\nでいかがでしょうか？';
  const slots = input.candidates.map((c) => formatSlotLine(c.startAt, c.endAt, lineFormat)).join('\n');
  return template
    .replace(/\{kind\}/g, input.kind || '打合せ')
    .replace(/\{client\}/g, input.clientName ?? '')
    .replace(/\{slots\}/g, slots)
    .trim();
}

export function holdProposalContext(sessionId: number): HoldProposalContext {
  const d = db();
  const s = d.select().from(schema.schedulingSessions).where(eq(schema.schedulingSessions.id, sessionId)).get();
  if (!s) throw new Error('日程調整が見つかりません');
  if (s.state !== 'proposing') throw new Error('この日程調整はすでに確定または取消されています');
  const client = s.clientId ? (d.select().from(schema.clients).where(eq(schema.clients.id, s.clientId)).get() ?? null) : null;

  // 候補は、いまカレンダーに残っているものだけを出す（取り消した分は打診しない）
  const candidates = s.candidates
    .filter((c) => c.eventId)
    .map((c) => {
      const ev = d.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.googleEventId, c.eventId!)).get();
      return ev ? { startAt: ev.startAt, endAt: ev.endAt } : null;
    })
    .filter((c): c is { startAt: string; endAt: string } => !!c)
    .sort((a, b) => a.startAt.localeCompare(b.startAt));

  const conversations: HoldProposalConversation[] = [];
  if (client) {
    const rows = d
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.clientId, client.id))
      .orderBy(desc(schema.conversations.lastMessageAt))
      .all()
      // 関係者（相手方など）との会話には打診しない
      .filter((c) => !c.contactId && !c.archived);
    for (const c of rows) {
      conversations.push({ id: c.id, channel: c.channel, counterpartName: c.counterpartName, lastMessageAt: c.lastMessageAt, preferred: !!client.preferredChannel && c.channel === client.preferredChannel });
    }
    // いつも使うチャネルを先に、あとは新しい順
    conversations.sort((a, b) => Number(b.preferred) - Number(a.preferred) || (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
  }
  // 日程調整を会話から始めていれば、その会話を既定にする
  const fromSession = s.conversationId && conversations.some((c) => c.id === s.conversationId) ? s.conversationId : null;

  const blocked = !client
    ? 'この仮押さえは依頼者が紐付いていません。先に依頼者を紐付けてください'
    : conversations.length === 0
      ? `${client.name}さんとの会話がありません。受信箱でやり取りを紐付けてください`
      : candidates.length === 0
        ? '候補の予定が残っていません'
        : null;

  return {
    sessionId,
    kind: s.kind,
    clientId: client?.id ?? null,
    clientName: client?.name ?? null,
    candidates,
    conversations,
    defaultConversationId: fromSession ?? conversations[0]?.id ?? null,
    text: buildProposalText({ kind: s.kind, clientName: client?.name ?? null, candidates }),
    defaultFollowUpAt: addBusinessDays(new Date(), getSettingInt('waiting_followup_business_days', 3)).toISOString(),
    blocked,
  };
}

/** テンプレートの文を、自分の文体に整え直す */
export async function draftHoldProposal(sessionId: number, opts: { conversationId?: number | null; instruction?: string | null } = {}) {
  const ctx = holdProposalContext(sessionId);
  const conversationId = opts.conversationId ?? ctx.defaultConversationId;
  if (!conversationId) throw new Error('送り先の会話がありません');
  const d = db();
  const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get();
  if (!conv) throw new Error('会話が見つかりません');
  const thread = d
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(desc(schema.messages.sentAt))
    .limit(8)
    .all()
    .reverse()
    .map((m) => ({ direction: m.direction as 'in' | 'out', body: m.body.slice(0, 1500), sentAt: m.sentAt, senderName: m.senderName }));

  const text = await draftReply(
    {
      conversationId,
      instruction: [
        `次の候補日で${ctx.kind}の日程を打診する文を書いてください。候補の日時は 1 つも増やさず、減らさず、書き換えずにそのまま並べてください。`,
        ctx.text,
        opts.instruction ? `追加の指示: ${opts.instruction}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      templateKey: null,
      extra: {},
    },
    { channel: conv.channel as Channel, clientName: ctx.clientName, counterpartName: conv.counterpartName, thread },
    ctx.clientId,
  );
  return { text };
}

export interface HoldProposalInput {
  conversationId: number;
  text: string;
  /** 返事が来るまでの「返信待ち」タスクを作る */
  createWaitingTask?: boolean;
  /** 返信待ちの期限（ISO 8601） */
  followUpAt?: string | null;
}

/** 候補日の打診を依頼者に送る */
export async function sendHoldProposal(sessionId: number, input: HoldProposalInput) {
  const ctx = holdProposalContext(sessionId);
  if (!input.text.trim()) throw new Error('打診の本文を入力してください');
  const conv = ctx.conversations.find((c) => c.id === input.conversationId);
  if (!conv) throw new Error('送り先の会話が選ばれていません');

  const r = await sendToConversation(input.conversationId, { text: input.text, attachmentIds: [], driveFiles: [], createWaitingTask: false });

  // 会話から始めていない仮押さえでも、あとから「どの会話で打診したか」をたどれるようにする
  const d = db();
  const s = d.select().from(schema.schedulingSessions).where(eq(schema.schedulingSessions.id, sessionId)).get();
  if (s && !s.conversationId) {
    d.update(schema.schedulingSessions).set({ conversationId: input.conversationId, updatedAt: new Date().toISOString() }).where(eq(schema.schedulingSessions.id, sessionId)).run();
  }
  d.update(schema.schedulingSessions).set({ proposedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).where(eq(schema.schedulingSessions.id, sessionId)).run();

  let waitingTaskId: number | null = null;
  if (input.createWaitingTask) {
    const kase = d.select({ caseId: schema.calendarEvents.caseId }).from(schema.calendarEvents).where(eq(schema.calendarEvents.googleEventId, s?.candidates.find((c) => c.eventId)?.eventId ?? '')).get();
    const t = await createTask({
      title: `${ctx.clientName ?? '依頼者'}から${ctx.kind}の候補日の返事待ち`,
      clientId: ctx.clientId,
      caseId: kase?.caseId ?? null,
      conversationId: input.conversationId,
      status: 'waiting_client',
      followUpAt: input.followUpAt ?? ctx.defaultFollowUpAt,
      note: input.text.trim(),
      syncToChatwork: false,
    });
    waitingTaskId = t.id;
  }

  logger.info({ sessionId, conversationId: input.conversationId, candidates: ctx.candidates.length }, '候補日を依頼者に打診しました');
  return { messageId: r.messageId, note: r.note ?? null, waitingTaskId, channel: conv.channel };
}
