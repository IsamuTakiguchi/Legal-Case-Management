import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { draftReply, pastDraftExamples } from './style.js';
import { isConfigured } from '../config.js';
import { CHANNEL_LABEL, EVENT_KIND_LABEL, isAllDayRange, formatJaDateTime, formatJaEventTime, yyyymmdd, type Channel, type EventKind } from '@lcm/shared';
import { resolveClientRecipient, recentThread, type ClientRecipient } from './hearingNotice.js';
import { meetingInfoOf, type NextMeeting } from './meetingNotice.js';

/** 決まった予定を依頼者に報告する下書き */
export interface EventNotice {
  eventId: number;
  clientId: number;
  clientName: string;
  caseId: number | null;
  caseTitle: string | null;
  channel: Channel;
  channelLabel: string;
  to: string;
  personId: number | null;
  recipient: string;
  conversationId: number;
  draftId: number | null;
  text: string;
  /** 予定の案内（日時・場所・WEB 会議の URL・パスコード）。本文にこのまま入れる */
  info: NextMeeting;
  channels: ClientRecipient[];
}

/** 予定の案内文。日時は終わりの時刻まで入れる（終日なら日付だけ） */
function infoText(ev: typeof schema.calendarEvents.$inferSelect, info: NextMeeting): string {
  const when = isAllDayRange(ev.startAt, ev.endAt)
    ? formatJaEventTime(ev.startAt, ev.endAt)
    : `${formatJaDateTime(new Date(ev.startAt))}〜${yyyymmdd(new Date(ev.startAt)) === yyyymmdd(new Date(ev.endAt)) ? formatJaDateTime(new Date(ev.endAt)).replace(/^.*日(\(.\))?/, '') : formatJaDateTime(new Date(ev.endAt))}`;
  return info.text.replace(/^日時: .*$/m, `日時: ${when}`);
}

/**
 * 決まった予定（期日・打合せ・相談など）を、依頼者に報告する下書きを用意する。
 * 日時・場所・WEB 会議の URL とパスコードは、予定から一字一句そのまま本文に入れる。送信は /conversations/:id/send で行う
 */
export async function prepareEventNotice(eventId: number, opts: { channel?: Channel; personId?: number | null } = {}): Promise<EventNotice> {
  const d = db();
  const ev = d.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId)).get();
  if (!ev) throw new Error('予定が見つかりません');
  if (ev.kind === 'hold' || ev.status === 'tentative') throw new Error('仮押さえの予定は、確定してから報告してください');
  const kase = ev.caseId ? (d.select().from(schema.cases).where(eq(schema.cases.id, ev.caseId)).get() ?? null) : null;
  const clientId = ev.clientId ?? kase?.clientId ?? null;
  const client = clientId ? d.select().from(schema.clients).where(eq(schema.clients.id, clientId)).get() : null;
  if (!client) throw new Error('この予定は依頼者に紐付いていません。予定の「紐付けを直す」で依頼者を決めてから報告してください');
  const { channels, chosen, conv, addressee, surname } = resolveClientRecipient(client, opts);
  const { channel, to } = chosen;

  const info = meetingInfoOf(ev);
  const guide = infoText(ev, info);
  const kindLabel = EVENT_KIND_LABEL[ev.kind as EventKind] ?? '予定';
  const what = ev.title.replace(/\s*仮$/, '');
  const instruction = [
    `${kase ? `「${kase.title}」の` : ''}${kindLabel}（${what}）の日程が決まったことを、依頼者に報告する。`,
    `予定の案内（日時・場所・URL・パスコードは一字一句変えずにそのまま本文に入れる）:\n${guide}`,
    ev.kind === 'hearing'
      ? '裁判所の期日の報告。依頼者の出席が必要かどうかは書かれていないので、決めつけて書かない。'
      : '打合せ・相談の報告。当日の来所・WEB 会議への参加のお願いを添える。',
    '依頼者が読んで分かる言葉で、短く丁寧に。事実の創作はしない。',
  ].join('\n');
  let text: string;
  let draftId: number | null = null;
  if (isConfigured('anthropic')) {
    text = await draftReply(
      { conversationId: conv.id, instruction, templateKey: null, extra: {} },
      {
        channel,
        clientName: client.name,
        counterpartName: chosen.personId ? addressee : conv.counterpartName,
        personName: chosen.personId ? addressee : null,
        thread: recentThread(conv.id),
        caseSummary: kase?.summary ?? null,
        // 過去に送った予定の報告を手本にする（本人が直して送ったものほど優先）
        examples: { label: '予定の報告', texts: pastDraftExamples('event_notice', { channel, clientId: client.id }) },
      },
      client.id,
    );
    // AI が URL を書き換えていたら、案内をそのまま足しておく（URL の打ち間違いは致命的なので）
    if (info.url && !text.includes(info.url)) text = `${text.trimEnd()}\n\n${guide}`;
    draftId = d.insert(schema.drafts).values({ conversationId: conv.id, instruction, generatedText: text, kind: 'event_notice' }).returning().get().id;
  } else {
    text = [
      `${surname}様`,
      '',
      'お世話になっております。',
      `${kase ? `${kase.title}の件で、` : ''}${kindLabel}の日程が決まりましたので、ご連絡いたします。`,
      '',
      guide,
      '',
      ev.kind === 'hearing' ? 'どうぞよろしくお願いいたします。' : 'ご予定のほど、どうぞよろしくお願いいたします。',
    ].join('\n');
  }
  return {
    eventId: ev.id,
    clientId: client.id,
    clientName: client.name,
    caseId: kase?.id ?? null,
    caseTitle: kase?.title ?? null,
    channel,
    channelLabel: CHANNEL_LABEL[channel],
    to,
    personId: chosen.personId,
    recipient: chosen.recipient,
    conversationId: conv.id,
    draftId,
    text,
    info: { ...info, text: guide },
    channels,
  };
}
