import { and, asc, eq, gt, inArray, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { draftReply, pastDraftExamples } from './style.js';
import { listTemplates, fillTemplate, DEFAULT_TEMPLATES } from './templates.js';
import { isConfigured } from '../config.js';
import { CHANNEL_LABEL, formatJaDateTime, type Channel } from '@lcm/shared';
import { resolveNoteRecipient, recentThread, type ClientRecipient } from './hearingNotice.js';
import { findMeetingInText, externalProviderOf, EXTERNAL_PROVIDER_LABEL } from './webMeeting.js';

type EventRow = typeof schema.calendarEvents.$inferSelect;

/** 次回の打合せ（カレンダーの予定）と、その WEB 会議の案内 */
export interface NextMeeting {
  eventId: number;
  title: string;
  startAt: string;
  endAt: string;
  location: string | null;
  /** WEB 会議の URL（予定の説明欄・場所、または日程調整で発行したもの） */
  url: string | null;
  /** Zoom・Google Meet など */
  provider: string | null;
  meetingId: string | null;
  passcode: string | null;
  /** 依頼者に送る案内（日時・場所・URL・パスコード） */
  text: string;
}

export interface MeetingNotice {
  noteId: number;
  caseId: number;
  clientId: number;
  clientName: string;
  channel: Channel;
  channelLabel: string;
  to: string;
  personId: number | null;
  recipient: string;
  conversationId: number;
  draftId: number | null;
  text: string;
  /** 打合せをした日時（記録の日時） */
  meetingAt: string;
  /** 次回の打合せ（選んだもの）。カレンダーに無ければ null */
  nextMeeting: NextMeeting | null;
  /** 次回の打合せの候補（この依頼者・事件の今後の打合せ・相談） */
  meetings: NextMeeting[];
  /** 依頼者に確認・準備をお願いすること（記録の次のアクション・決定事項から） */
  confirmItems: string[];
  /** 添付の候補（打合せの連絡では既定で選ばない。フォルダから選べる） */
  docs: { name: string; path: string; itemId?: string; modifiedAt?: string; size?: number; suggested: boolean }[];
  channels: ClientRecipient[];
}

/** 予定から WEB 会議の案内を取り出す（説明欄・場所 → 日程調整で発行した Zoom・Meet） */
export function meetingInfoOf(ev: EventRow): NextMeeting {
  const found = findMeetingInText([ev.description ?? '', ev.location ?? ''].join('\n'));
  let url = found?.url ?? null;
  let passcode = found?.passcode ?? null;
  const meetingId = found?.meetingId ?? null;
  if (!url) {
    // 日程調整で確定した予定なら、そのとき発行した Zoom・Meet を使う
    const session = db().select().from(schema.schedulingSessions).where(eq(schema.schedulingSessions.confirmedEventId, ev.googleEventId)).get();
    if (session?.zoom?.joinUrl) {
      url = session.zoom.joinUrl;
      passcode = session.zoom.password || null;
    }
  }
  const provider = url ? EXTERNAL_PROVIDER_LABEL[externalProviderOf(url)] : null;
  const when = formatJaDateTime(new Date(ev.startAt), { withWeekday: true });
  // 場所が「Zoom」「WEB会議」など URL の代わりの言葉だけなら、場所としては出さない
  const place = ev.location && !/^(zoom|google meet|web\s*会議|ｗｅｂ会議|オンライン)/i.test(ev.location.trim()) && !/https?:\/\//.test(ev.location) ? ev.location.trim() : null;
  const lines = [
    `日時: ${when}`,
    url ? `方法: ${provider ?? 'WEB会議'}` : place ? `場所: ${place}` : '',
    url ? `URL: ${url}` : '',
    url && meetingId ? `ミーティング ID: ${meetingId}` : '',
    url && passcode ? `パスコード: ${passcode}` : '',
  ].filter(Boolean);
  return {
    eventId: ev.id,
    title: ev.title,
    startAt: ev.startAt,
    endAt: ev.endAt,
    location: ev.location ?? null,
    url,
    provider,
    meetingId,
    passcode,
    text: lines.join('\n'),
  };
}

/** この依頼者・事件の今後の打合せ・相談（近い順） */
export function upcomingMeetings(clientId: number, caseId: number, limit = 5): EventRow[] {
  const now = new Date().toISOString();
  return db()
    .select()
    .from(schema.calendarEvents)
    .where(
      and(
        or(eq(schema.calendarEvents.caseId, caseId), eq(schema.calendarEvents.clientId, clientId)),
        inArray(schema.calendarEvents.kind, ['meeting', 'consult']),
        gt(schema.calendarEvents.startAt, now),
      ),
    )
    .orderBy(asc(schema.calendarEvents.startAt))
    .all()
    // 取り消された予定・仮押さえ（まだ決まっていない）は除く
    .filter((e) => e.status !== 'cancelled' && e.status !== 'tentative')
    .slice(0, limit);
}

/**
 * 打合せの記録から、依頼者への連絡（打合せの内容・確認していただきたいこと・次回の打合せの日時と Zoom の URL）の下書きを用意する。
 * 送信は期日連絡と同じく /conversations/:id/send で行う
 */
export async function prepareMeetingNotice(noteId: number, opts: { channel?: Channel; personId?: number | null; eventId?: number | null } = {}): Promise<MeetingNotice> {
  const d = db();
  const { note, kase, client, channels, chosen, conv, addressee, surname } = resolveNoteRecipient(noteId, opts);
  const { channel, to } = chosen;

  const meetings = upcomingMeetings(client.id, kase.id).map(meetingInfoOf);
  // 画面で選んだ予定 → いちばん近い打合せ。eventId に null を渡したら「次回の案内を入れない」
  const nextMeeting = opts.eventId === null ? null : ((opts.eventId ? meetings.find((m) => m.eventId === opts.eventId) : undefined) ?? meetings[0] ?? null);

  const summary = [note.gist ?? note.rawText ?? '', ...note.decisions.map((x) => `・${x}`)].filter(Boolean).join('\n');
  // 確認事項は次のアクション。依頼者待ちの記録なら、依頼者にお願いすることが入っている
  const confirmItems = note.nextActions.map((a) => `${a.title}${a.replyBy ? `（${a.replyBy}までにご返信）` : a.due ? `（${a.due}まで）` : ''}`);
  const confirmText = confirmItems.map((x) => `・${x}`).join('\n');
  const nextText = nextMeeting?.text ?? '';

  // 設定でテンプレートを編集・保存済みで打合せの連絡が入っていなければ、既定の文面を使う
  const template = listTemplates().find((t) => t.key === 'meeting_report');
  const fallback = DEFAULT_TEMPLATES.find((t) => t.key === 'meeting_report')!;
  let text: string;
  let draftId: number | null = null;
  const instruction = [
    `${formatJaDateTime(new Date(note.occurredAt), { withWeekday: true })}の打合せ（${kase.title}）のあとに、依頼者に連絡する。`,
    `打合せの内容・決まったこと:\n${summary || '（記録の本文のとおり）'}`,
    confirmItems.length
      ? `確認事項（記録の次のアクション）:\n${confirmText}\nこのうち依頼者にお願いすること（資料の準備・確認・返信など）は「ご確認・ご準備いただきたいこと」として箇条書きで、期限があれば期限も書く。当事務所で行うことは「当方で〜いたします」と分けて書く。`
      : '依頼者にお願いすることは記録に無い。無理に作らない。',
    nextMeeting
      ? `次回の打合せ（下の案内は日時・URL・パスコードを一字一句変えずにそのまま本文に入れる）:\n${nextText}`
      : '次回の打合せは決まっていない（カレンダーに無い）。日時や URL を作らない。',
    '依頼者が読んで分かる言葉で、短く丁寧に。事実の創作はしない。',
  ].join('\n');
  if (isConfigured('anthropic')) {
    text = await draftReply(
      {
        conversationId: conv.id,
        instruction,
        templateKey: template ? 'meeting_report' : null,
        extra: { 内容: summary, 確認事項: confirmText || 'なし', 次回打合せ: nextText || '未定' },
      },
      {
        channel,
        clientName: client.name,
        counterpartName: chosen.personId ? addressee : conv.counterpartName,
        personName: chosen.personId ? addressee : null,
        thread: recentThread(conv.id),
        caseSummary: kase.summary ?? null,
        // 過去に送った打合せの連絡を手本にする（本人が直して送ったものほど優先）
        examples: { label: '打合せ後の連絡', texts: pastDraftExamples('meeting_notice', { channel, clientId: client.id }) },
      },
      client.id,
    );
    // AI が URL を書き換えていたら、案内をそのまま足しておく（URL の打ち間違いは致命的なので）
    if (nextMeeting?.url && !text.includes(nextMeeting.url)) text = `${text.trimEnd()}\n\n【次回のお打合せ】\n${nextText}`;
    draftId = d.insert(schema.drafts).values({ conversationId: conv.id, instruction, generatedText: text, kind: 'meeting_notice' }).returning().get().id;
  } else {
    const vars = { 姓: surname, 内容: summary, 確認事項: confirmText || 'ございません', 次回打合せ: nextText || '追ってご連絡いたします', アクセス案内: '' };
    text = fillTemplate((template ?? fallback).body, vars);
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
    meetingAt: note.occurredAt,
    nextMeeting,
    meetings,
    confirmItems,
    docs: [],
    channels,
  };
}

