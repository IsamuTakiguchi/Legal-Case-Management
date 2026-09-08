import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { draftReply } from './style.js';
import { listCourtDocs } from './court.js';
import { clientOwnConversations } from './contacts.js';
import { listTemplates, fillTemplate } from './templates.js';
import { adapterFor } from '../channels/registry.js';
import { isConfigured } from '../config.js';
import { logger } from '../logger.js';
import { CHANNEL_LABEL, familyName, formatJaDateTime, type Channel } from '@lcm/shared';

type ClientRow = typeof schema.clients.$inferSelect;
type ConversationRow = typeof schema.conversations.$inferSelect;

/** 依頼者に送れるチャネルと宛先（連絡先が登録されていて、そのチャネルが設定済みのもの） */
export function availableChannels(client: ClientRow): { channel: Channel; to: string }[] {
  const out: { channel: Channel; to: string }[] = [];
  if (client.emails[0]) out.push({ channel: 'gmail', to: client.emails[0] });
  if (client.lineUserId) out.push({ channel: 'line', to: 'LINE' });
  if (client.chatworkRoomId) out.push({ channel: 'chatwork', to: `ルーム ${client.chatworkRoomId}` });
  return out.filter((x) => {
    try {
      return adapterFor(x.channel).isConfigured();
    } catch {
      return false;
    }
  });
}

/**
 * 依頼者本人との会話（そのチャネル）を返す。無ければ作る。
 * Gmail はスレッドがまだ無いので仮の ID（new:…）で作り、初回送信時に実際のスレッド ID に置き換わる
 */
export function ensureClientConversation(client: ClientRow, channel: Channel): ConversationRow {
  const own = clientOwnConversations(client.id)
    .filter((c) => c.channel === channel && !c.archived)
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
  if (own[0]) return own[0];
  const externalThreadId = channel === 'gmail' ? `new:${client.id}:${Date.now()}` : channel === 'line' ? client.lineUserId! : String(client.chatworkRoomId);
  const counterpartAddress = channel === 'gmail' ? (client.emails[0] ?? null) : channel === 'line' ? client.lineUserId : String(client.chatworkRoomId);
  return db()
    .insert(schema.conversations)
    .values({ channel, externalThreadId, clientId: client.id, counterpartName: client.name, counterpartAddress, subject: null })
    .returning()
    .get();
}

export interface HearingNotice {
  noteId: number;
  caseId: number;
  clientId: number;
  clientName: string;
  channel: Channel;
  channelLabel: string;
  to: string;
  conversationId: number;
  draftId: number | null;
  text: string;
  hearingAt: string;
  nextHearingAt: string | null;
  nextHearingText: string;
  docs: { name: string; path: string; itemId?: string; modifiedAt?: string; size?: number }[];
  channels: { channel: Channel; to: string }[];
}

/**
 * 期日の記録（案件ノート）から、依頼者への期日連絡の下書きを用意する。
 * 記録の要旨・決定事項・次のアクションと、カレンダー上の次回期日、直近の提出書面をもとに本人の文体で書く。
 */
export async function prepareHearingNotice(noteId: number, opts: { channel?: Channel } = {}): Promise<HearingNotice> {
  const d = db();
  const note = d.select().from(schema.caseNotes).where(eq(schema.caseNotes.id, noteId)).get();
  if (!note) throw new Error('記録が見つかりません');
  const kase = d.select().from(schema.cases).where(eq(schema.cases.id, note.caseId)).get();
  if (!kase) throw new Error('事件が見つかりません');
  const client = d.select().from(schema.clients).where(eq(schema.clients.id, kase.clientId)).get();
  if (!client) throw new Error('依頼者が見つかりません');
  const channels = availableChannels(client);
  if (channels.length === 0) throw new Error('依頼者の連絡先（メールアドレス・LINE・Chatwork ルーム）が登録されていないか、そのチャネルが未設定です');
  const preferred = client.preferredChannel as Channel | null;
  const channel = opts.channel && channels.some((c) => c.channel === opts.channel) ? opts.channel : (channels.find((c) => c.channel === preferred)?.channel ?? channels[0].channel);
  const to = channels.find((c) => c.channel === channel)!.to;
  const conv = ensureClientConversation(client, channel);

  // 次回期日: カレンダーの今後の期日 → 事件の次回期日
  const now = new Date().toISOString();
  const nextEv = d
    .select()
    .from(schema.calendarEvents)
    .where(and(eq(schema.calendarEvents.caseId, kase.id), eq(schema.calendarEvents.kind, 'hearing'), gt(schema.calendarEvents.startAt, now)))
    .orderBy(asc(schema.calendarEvents.startAt))
    .limit(1)
    .get();
  const nextHearingAt = nextEv?.startAt ?? (kase.nextHearingAt && kase.nextHearingAt > now ? kase.nextHearingAt : null);
  const nextHearingText = nextHearingAt ? `${formatJaDateTime(new Date(nextHearingAt), { withWeekday: true })}${nextEv?.location ? `（${nextEv.location}）` : ''}` : '未定（裁判所から追って指定されます）';
  const hearingAt = note.occurredAt;

  const resultLines = [note.gist ?? note.rawText ?? '', ...note.decisions.map((x) => `・${x}`)].filter(Boolean);
  const nextActions = note.nextActions.map((a) => `・${a.title}${a.due ? `（${a.due}まで）` : ''}`);
  const resultText = resultLines.join('\n');

  let docs: HearingNotice['docs'] = [];
  try {
    docs = (await listCourtDocs(client.id, { days: 14 })).slice(0, 10).map((x) => ({ name: x.name, path: x.path, itemId: x.itemId, modifiedAt: x.modifiedAt, size: x.size }));
  } catch (err) {
    logger.debug({ err }, '提出書面の一覧をスキップ');
  }

  const surname = familyName(client.name);
  const template = listTemplates().find((t) => t.key === 'hearing_report');
  let text: string;
  let draftId: number | null = null;
  const instruction = [
    `${formatJaDateTime(new Date(hearingAt), { withWeekday: true })}の期日（${kase.title}）の結果を依頼者に報告する。`,
    `結果・決定事項:\n${resultText || '（記録の本文のとおり）'}`,
    nextActions.length ? `今後の対応:\n${nextActions.join('\n')}` : '',
    `次回期日: ${nextHearingText}`,
    docs.length ? '提出した書面を添付（LINE ならリンクまたは別途送付）する前提で触れる。' : '書面の添付には触れない。',
    '依頼者が読んで分かる言葉で、今後の流れを一言添える。事実の創作はしない。',
  ]
    .filter(Boolean)
    .join('\n');
  if (isConfigured('anthropic')) {
    const thread = d.select().from(schema.messages).where(eq(schema.messages.conversationId, conv.id)).orderBy(desc(schema.messages.sentAt)).limit(8).all().reverse();
    text = await draftReply(
      { conversationId: conv.id, instruction, templateKey: template ? 'hearing_report' : null, extra: { 結果: resultText, 次回期日: nextHearingText } },
      {
        channel,
        clientName: client.name,
        counterpartName: conv.counterpartName,
        thread: thread.map((m) => ({ direction: m.direction as 'in' | 'out', body: m.body, sentAt: m.sentAt, senderName: m.senderName })),
        caseSummary: kase.summary ?? null,
      },
      client.id,
    );
    draftId = d.insert(schema.drafts).values({ conversationId: conv.id, instruction, generatedText: text }).returning().get().id;
  } else {
    text = template ? fillTemplate(template.body, { 姓: surname, 結果: resultText, 次回期日: nextHearingText, アクセス案内: '' }) : `${surname}様\n\n本日の期日の結果をご報告いたします。\n\n${resultText}\n\n次回期日は${nextHearingText}です。`;
  }
  return {
    noteId,
    caseId: kase.id,
    clientId: client.id,
    clientName: client.name,
    channel,
    channelLabel: CHANNEL_LABEL[channel],
    to,
    conversationId: conv.id,
    draftId,
    text,
    hearingAt,
    nextHearingAt,
    nextHearingText,
    docs,
    channels,
  };
}
