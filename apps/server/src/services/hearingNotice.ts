import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { draftReply } from './style.js';
import { listCourtDocs } from './court.js';
import { clientOwnConversations } from './contacts.js';
import { listTemplates, fillTemplate } from './templates.js';
import { adapterFor } from '../channels/registry.js';
import { isConfigured } from '../config.js';
import { logger } from '../logger.js';
import { CHANNEL_LABEL, familyName, formatJaDateTime, clientPersonLabel, type Channel } from '@lcm/shared';
import { listClientPersons, getClientPerson, type ClientPersonRow } from './clientPersons.js';

type ClientRow = typeof schema.clients.$inferSelect;
type ConversationRow = typeof schema.conversations.$inferSelect;

/** 依頼者に送る宛先 1 つ（依頼者本人、または法人の担当者のチャネル） */
export interface ClientRecipient {
  channel: Channel;
  /** 宛先（メールアドレス、LINE、ルーム） */
  to: string;
  /** 法人の担当者宛なら、その担当者。依頼者本人（会社・代表）宛は null */
  personId: number | null;
  /** 宛名（依頼者名、または「佐藤花子（総務部）」） */
  recipient: string;
}

function recipientsOf(target: { emails: string[]; lineUserId: string | null; chatworkRoomId: number | null }, personId: number | null, recipient: string): ClientRecipient[] {
  const out: ClientRecipient[] = [];
  if (target.emails[0]) out.push({ channel: 'gmail', to: target.emails[0], personId, recipient });
  if (target.lineUserId) out.push({ channel: 'line', to: 'LINE', personId, recipient });
  if (target.chatworkRoomId) out.push({ channel: 'chatwork', to: `ルーム ${target.chatworkRoomId}`, personId, recipient });
  return out;
}

/**
 * 依頼者に送れるチャネルと宛先（連絡先が登録されていて、そのチャネルが設定済みのもの）。
 * 法人で担当者がいれば担当者の連絡先も並べる。主担当がいれば主担当を先頭にする（既定の宛先になる）
 */
export function availableChannels(client: ClientRow): ClientRecipient[] {
  const persons = listClientPersons(client.id);
  const primary = persons.filter((p) => p.primary);
  const others = persons.filter((p) => !p.primary);
  const ofPerson = (p: ClientPersonRow) => recipientsOf(p, p.id, clientPersonLabel(p));
  const out: ClientRecipient[] = [...primary.flatMap(ofPerson), ...recipientsOf(client, null, client.name), ...others.flatMap(ofPerson)];
  return out.filter((x) => {
    try {
      return adapterFor(x.channel).isConfigured();
    } catch {
      return false;
    }
  });
}

/** 依頼者に連絡する手段が無いとき（画面はその場で連絡先を登録する欄を出す） */
export class ClientUnreachableError extends Error {
  readonly code = 'client_unreachable';
  constructor(readonly clientId: number, message: string) {
    super(message);
  }
}

/** チャネルが使えるか（アプリに接続済みか） */
function channelConfigured(channel: Channel): boolean {
  try {
    return adapterFor(channel).isConfigured();
  } catch {
    return false;
  }
}

/**
 * 依頼者の連絡先の登録状況と、各チャネルがアプリに接続済みか。
 * 「送れない」ときに、何が足りないか（連絡先の登録か、チャネルの接続か）を画面で示すために使う
 */
export function clientReachability(client: ClientRow) {
  return {
    clientId: client.id,
    clientName: client.name,
    emails: client.emails,
    lineUserId: client.lineUserId,
    lineInvitedAt: client.lineInvitedAt ?? null,
    chatworkRoomId: client.chatworkRoomId,
    configured: { gmail: channelConfigured('gmail'), line: channelConfigured('line'), chatwork: channelConfigured('chatwork') },
    channels: availableChannels(client),
  };
}

/**
 * 依頼者本人との会話（そのチャネル）を返す。無ければ作る。
 * Gmail はスレッドがまだ無いので仮の ID（new:…）で作り、初回送信時に実際のスレッド ID に置き換わる
 */
export function ensureClientConversation(client: ClientRow, channel: Channel, personId: number | null = null): ConversationRow {
  // 担当者宛なら担当者の連絡先、依頼者本人宛なら依頼者の連絡先で会話を探す・作る
  const person = personId ? getClientPerson(personId) : null;
  if (personId && (!person || person.clientId !== client.id)) throw new Error('この依頼者の担当者ではありません');
  const target = person ?? client;
  const own = clientOwnConversations(client.id)
    .filter((c) => c.channel === channel && !c.archived && (c.clientPersonId ?? null) === (person?.id ?? null))
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
  if (own[0]) return own[0];
  const externalThreadId = channel === 'gmail' ? `new:${client.id}:${Date.now()}` : channel === 'line' ? target.lineUserId! : String(target.chatworkRoomId);
  const counterpartAddress = channel === 'gmail' ? (target.emails[0] ?? null) : channel === 'line' ? target.lineUserId : String(target.chatworkRoomId);
  // LINE・Chatwork は相手ごとに会話が 1 つ。アーカイブ済みや、まだ依頼者に紐付いていない会話があればそれを使う
  //（同じ相手の会話を二重に作ろうとすると、重複の制約で失敗する）
  if (channel !== 'gmail') {
    const existing = db()
      .select()
      .from(schema.conversations)
      .where(and(eq(schema.conversations.channel, channel), eq(schema.conversations.externalThreadId, externalThreadId)))
      .get();
    if (existing) {
      const patch = { archived: false, ...(existing.clientId ? {} : { clientId: client.id }), ...(person && !existing.clientPersonId ? { clientPersonId: person.id } : {}) };
      db().update(schema.conversations).set(patch).where(eq(schema.conversations.id, existing.id)).run();
      return { ...existing, ...patch };
    }
  }
  return db()
    .insert(schema.conversations)
    .values({ channel, externalThreadId, clientId: client.id, clientPersonId: person?.id ?? null, counterpartName: person?.name ?? client.name, counterpartAddress, subject: null })
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
  /** 法人の担当者宛なら、その担当者 */
  personId: number | null;
  /** 宛名（依頼者名、または担当者） */
  recipient: string;
  conversationId: number;
  draftId: number | null;
  text: string;
  hearingAt: string;
  nextHearingAt: string | null;
  nextHearingText: string;
  /** 添付の候補（事件フォルダの更新が新しい順）。suggested は期日の前後に更新された＝その期日で出した可能性が高いもの */
  docs: { name: string; path: string; itemId?: string; modifiedAt?: string; size?: number; suggested: boolean }[];
  channels: ClientRecipient[];
}

/**
 * 期日の記録（案件ノート）から、依頼者への期日連絡の下書きを用意する。
 * 記録の要旨・決定事項・次のアクションと、カレンダー上の次回期日、直近の提出書面をもとに本人の文体で書く。
 */
export async function prepareHearingNotice(noteId: number, opts: { channel?: Channel; personId?: number | null } = {}): Promise<HearingNotice> {
  const d = db();
  const note = d.select().from(schema.caseNotes).where(eq(schema.caseNotes.id, noteId)).get();
  if (!note) throw new Error('記録が見つかりません');
  const kase = d.select().from(schema.cases).where(eq(schema.cases.id, note.caseId)).get();
  if (!kase) throw new Error('事件が見つかりません');
  const client = d.select().from(schema.clients).where(eq(schema.clients.id, kase.clientId)).get();
  if (!client) throw new Error('依頼者が見つかりません');
  const channels = availableChannels(client);
  if (channels.length === 0) throw new ClientUnreachableError(client.id, `${client.name}さんの連絡先（メールアドレス・LINE・Chatwork ルーム）が登録されていないか、そのチャネルがアプリに接続されていません`);
  const preferred = client.preferredChannel as Channel | null;
  // 宛先: 画面で選んだもの（チャネル＋担当者） → 希望チャネル → 先頭（主担当がいれば主担当）
  const chosen =
    (opts.channel ? channels.find((c) => c.channel === opts.channel && (opts.personId === undefined || c.personId === (opts.personId ?? null))) : undefined) ??
    channels.find((c) => c.channel === preferred) ??
    channels[0]!;
  const { channel, to } = chosen;
  const conv = ensureClientConversation(client, channel, chosen.personId);
  // 担当者宛なら、宛名は担当者（姓）にする
  const addressee = chosen.personId ? (getClientPerson(chosen.personId)?.name ?? client.name) : client.name;

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

  // 添付の候補は事件フォルダの更新履歴から。期日の前日以降に更新したものは「その期日で出した書面」とみて既定で選ぶ
  let docs: HearingNotice['docs'] = [];
  const suggestFrom = new Date(new Date(hearingAt).getTime() - 86400_000).toISOString();
  try {
    docs = (await listCourtDocs(client.id, { days: 60 })).slice(0, 20).map((x) => ({
      name: x.name,
      path: x.path,
      itemId: x.itemId,
      modifiedAt: x.modifiedAt,
      size: x.size,
      suggested: !!x.modifiedAt && x.modifiedAt >= suggestFrom,
    }));
  } catch (err) {
    logger.debug({ err }, '提出書面の一覧をスキップ');
  }
  const suggestedCount = docs.filter((d) => d.suggested).length;

  const surname = familyName(addressee);
  const template = listTemplates().find((t) => t.key === 'hearing_report');
  let text: string;
  let draftId: number | null = null;
  const instruction = [
    `${formatJaDateTime(new Date(hearingAt), { withWeekday: true })}の期日（${kase.title}）の結果を依頼者に報告する。`,
    `結果・決定事項:\n${resultText || '（記録の本文のとおり）'}`,
    nextActions.length ? `今後の対応:\n${nextActions.join('\n')}` : '',
    `次回期日: ${nextHearingText}`,
    suggestedCount ? '提出した書面を添付（LINE ならリンクまたは別途送付）する前提で触れる。' : '書面の添付には触れない。',
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
        counterpartName: chosen.personId ? addressee : conv.counterpartName,
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
    personId: chosen.personId,
    recipient: chosen.recipient,
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
