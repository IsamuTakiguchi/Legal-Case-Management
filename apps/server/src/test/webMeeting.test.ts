import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-webmeet-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.ZOOM_ACCOUNT_ID = 'acc';
process.env.ZOOM_CLIENT_ID = 'cid';
process.env.ZOOM_CLIENT_SECRET = 'sec';

// Zoom の API は呼ばず、作った内容だけ見る
const created: { topic: string; startAt: Date; durationMinutes: number }[] = [];
vi.mock('../integrations/zoom.js', () => ({
  createZoomMeeting: vi.fn(async (o: { topic: string; startAt: Date; durationMinutes: number }) => {
    created.push(o);
    return { id: '999', joinUrl: 'https://zoom.us/j/999', password: 'pw123', topic: o.topic };
  }),
  deleteZoomMeeting: vi.fn(async () => undefined),
}));

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { webMeetingProvider, webMeetingText, webLocation, issueZoomIfNeeded } = await import('../services/webMeeting.js');
const { registerScheduleFromConversation } = await import('../services/scheduleExtract.js');
const { confirmHold } = await import('../services/court.js');
const { setSetting, clearSettingsCache } = await import('../services/settings.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

function seedConversation(name: string, thread: string) {
  const client = db().insert(schema.clients).values({ name }).returning().get();
  const conv = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: thread, clientId: client.id, counterpartName: name }).returning().get();
  return { client, conv };
}

const slot = (iso: string, minutes = 60) => ({ startAt: new Date(iso).toISOString(), endAt: new Date(new Date(iso).getTime() + minutes * 60_000).toISOString() });

describe('WEB 会議（Zoom）の発行', () => {
  it('Zoom が設定されていれば提供元は zoom', () => {
    clearSettingsCache();
    expect(webMeetingProvider()).toBe('zoom');
    setSetting('web_meeting_provider', 'meet');
    expect(webMeetingProvider()).toBe('none'); // Google 未接続
    setSetting('web_meeting_provider', 'auto');
    expect(webMeetingProvider()).toBe('zoom');
  });

  it('案内文と場所の既定値', () => {
    expect(webMeetingText({ provider: 'zoom', url: 'https://zoom.us/j/1', password: 'pw', id: '1' })).toBe('Zoom: https://zoom.us/j/1\nパスコード: pw');
    expect(webMeetingText({ provider: 'meet', url: 'https://meet.google.com/abc', password: '', id: null })).toBe('Google Meet: https://meet.google.com/abc');
    expect(webMeetingText(null)).toBe('');
    expect(webLocation('zoom', null)).toBe('Zoom');
    expect(webLocation('meet', '')).toBe('Google Meet');
    expect(webLocation('none', null)).toBe('WEB会議');
    // 入力した場所があればそれを優先する
    expect(webLocation('zoom', '本社会議室')).toBe('本社会議室');
  });

  it('提供元が meet のときは Zoom を作らない（予定の作成時に Google が発行する）', async () => {
    expect(await issueZoomIfNeeded('meet', { topic: 'x', startAt: new Date(), durationMinutes: 30 })).toBeNull();
    expect(await issueZoomIfNeeded('none', { topic: 'x', startAt: new Date(), durationMinutes: 30 })).toBeNull();
  });

  it('確定として登録すると、その場で Zoom を作り予定の説明欄と場所に入れる', async () => {
    created.length = 0;
    const { conv } = seedConversation('山田 花子', 'w-1');
    const r = await registerScheduleFromConversation(conv.id, {
      mode: 'confirmed',
      title: '山田 打合せ',
      kind: 'meeting',
      slots: [slot('2027-10-05T01:00:00.000Z', 90)],
      web: true,
    });
    expect(created.length).toBe(1);
    expect(created[0]!.durationMinutes).toBe(90);
    expect(created[0]!.topic).toBe('山田 打合せ');
    expect(r.webText).toBe('Zoom: https://zoom.us/j/999\nパスコード: pw123');
    const ev = r.events[0]!;
    expect(ev.location).toBe('Zoom');
    expect(ev.description).toContain('Zoom: https://zoom.us/j/999');
    expect(ev.description).toContain('パスコード: pw123');
  });

  it('WEB でなければ Zoom は作らない', async () => {
    created.length = 0;
    const { conv } = seedConversation('佐藤 太郎', 'w-2');
    const r = await registerScheduleFromConversation(conv.id, { mode: 'confirmed', title: '佐藤 打合せ', kind: 'meeting', slots: [slot('2027-10-06T01:00:00.000Z')], location: '事務所' });
    expect(created.length).toBe(0);
    expect(r.webText).toBe('');
    expect(r.events[0]!.location).toBe('事務所');
  });

  it('仮押さえでは Zoom を作らず、確定した 1 件だけで作る', async () => {
    created.length = 0;
    const { conv } = seedConversation('鈴木 一郎', 'w-3');
    const r = await registerScheduleFromConversation(conv.id, {
      mode: 'holds',
      title: '鈴木 打合せ',
      kind: 'meeting',
      slots: [slot('2027-10-07T01:00:00.000Z'), slot('2027-10-08T01:00:00.000Z')],
      web: true,
    });
    expect(r.mode).toBe('holds');
    expect(r.events.length).toBe(2);
    // 候補の段階では作らない
    expect(created.length).toBe(0);
    expect(r.events[0]!.location).toBe('Zoom');
    expect(r.events[0]!.description).toContain('確定したときに会議 URL を発行します');

    const confirmed = await confirmHold(r.sessionId!, r.events[0]!.id);
    expect(created.length).toBe(1);
    expect(confirmed.webText).toBe('Zoom: https://zoom.us/j/999\nパスコード: pw123');
    expect(confirmed.description).toContain('Zoom: https://zoom.us/j/999');
    // 案内用の文言は確定後の説明欄に残さない
    expect(confirmed.description).not.toContain('確定したときに会議 URL を発行します');
    expect(confirmed.description).not.toContain('日程調整中');
    // 取り消せるよう、作ったミーティングをセッションに控える
    const session = db().select().from(schema.schedulingSessions).where(eq(schema.schedulingSessions.id, r.sessionId!)).get();
    expect(session?.zoom?.id).toBe('999');
  });

  it('WEB でない仮押さえを確定しても Zoom は作らない', async () => {
    created.length = 0;
    const { conv } = seedConversation('高橋 二郎', 'w-4');
    const r = await registerScheduleFromConversation(conv.id, { mode: 'holds', title: '高橋 打合せ', kind: 'meeting', slots: [slot('2027-10-09T01:00:00.000Z')] });
    const confirmed = await confirmHold(r.sessionId!, r.events[0]!.id);
    expect(created.length).toBe(0);
    expect(confirmed.webText).toBe('');
  });
});

const { eq } = await import('drizzle-orm');

const { findMeetingInText, externalMeetingText, externalLocation, EXTERNAL_PENDING_LINE } = await import('../services/webMeeting.js');
const { setEventMeetingFromConversation, confirmHoldFromConversation, meetingFromMessages } = await import('../services/scheduleExtract.js');

const ZOOM_INVITE = `岡田です。下記の Zoom でお願いいたします。

Zoomミーティングに参加する
https://us02web.zoom.us/j/81234567890?pwd=AbCdEf123。

ミーティングID: 812 3456 7890
パスコード: 654321`;

describe('相手が発行した WEB 会議の URL', () => {
  it('本文から Zoom・Meet・Teams の URL と、ミーティング ID・パスコードを取り出す', () => {
    expect(findMeetingInText(ZOOM_INVITE)).toEqual({ url: 'https://us02web.zoom.us/j/81234567890?pwd=AbCdEf123', meetingId: '812 3456 7890', passcode: '654321' });
    expect(findMeetingInText('当日は https://meet.google.com/abc-defg-hij からお入りください')?.url).toBe('https://meet.google.com/abc-defg-hij');
    expect(findMeetingInText('Teams: https://teams.microsoft.com/l/meetup-join/19%3ameeting_x')?.url).toContain('teams.microsoft.com');
    // 会議以外の URL（資料のアップロード先など）は拾わない
    expect(findMeetingInText('資料は https://example.com/upload からお願いします')).toBeNull();
    expect(externalMeetingText({ url: 'https://zoom.us/j/1', meetingId: '1', passcode: 'p' })).toBe('Zoom（相手方発行）: https://zoom.us/j/1\nミーティング ID: 1\nパスコード: p');
    expect(externalLocation({ url: 'https://meet.google.com/x' })).toBe('Google Meet（相手方発行）');
    expect(externalLocation(null)).toBe('WEB会議（相手方発行）');
    // 相手から届いたものだけ、新しいものを優先して拾う（自分が送った URL は相手の発行ではない）
    const found = meetingFromMessages([
      { direction: 'in', body: '旧: https://zoom.us/j/111', sentAt: '2026-10-01T00:00:00Z', senderName: '岡田' },
      { direction: 'in', body: ZOOM_INVITE, sentAt: '2026-10-02T00:00:00Z', senderName: '岡田' },
      { direction: 'out', body: 'こちらの https://zoom.us/j/999 で', sentAt: '2026-10-03T00:00:00Z', senderName: null },
    ]);
    expect(found).toMatchObject({ url: 'https://us02web.zoom.us/j/81234567890?pwd=AbCdEf123', label: 'Zoom', senderName: '岡田' });
  });

  it('確定で「相手が発行」なら、こちらの Zoom は作らず相手の URL を予定に入れる', async () => {
    created.length = 0;
    const { conv } = seedConversation('岡田 彬弘', 'x-1');
    const meeting = findMeetingInText(ZOOM_INVITE)!;
    const r = await registerScheduleFromConversation(conv.id, { mode: 'confirmed', title: '岡田 打合せ', kind: 'meeting', slots: [slot('2027-11-05T01:00:00.000Z')], web: true, meetingBy: 'them', meeting });
    expect(created.length).toBe(0);
    const ev = r.events[0]!;
    expect(ev.location).toBe('Zoom（相手方発行）');
    expect(ev.description).toContain('Zoom（相手方発行）: https://us02web.zoom.us/j/81234567890?pwd=AbCdEf123');
    expect(ev.description).toContain('パスコード: 654321');
    expect(r.webText).toContain('ミーティング ID: 812 3456 7890');
  });

  it('URL がまだ届いていなければ「届いたら追加」と残し、後から届いた URL を入れられる（入れ直しても重ならない）', async () => {
    created.length = 0;
    const { conv, client } = seedConversation('東京 保険', 'x-2');
    const r = await registerScheduleFromConversation(conv.id, { mode: 'confirmed', title: '東京 打合せ', kind: 'meeting', slots: [slot('2027-11-06T01:00:00.000Z')], web: true, meetingBy: 'them', meeting: null });
    expect(created.length).toBe(0);
    const ev = r.events[0]!;
    expect(ev.location).toBe('WEB会議（相手方発行）');
    expect(ev.description).toContain(EXTERNAL_PENDING_LINE);

    const first = await setEventMeetingFromConversation(conv.id, ev.id, { url: 'https://zoom.us/j/111', passcode: 'aaa' });
    expect(first.event!.description).not.toContain(EXTERNAL_PENDING_LINE);
    expect(first.event!.description).toContain('Zoom（相手方発行）: https://zoom.us/j/111');
    expect(first.event!.location).toBe('Zoom（相手方発行）');
    const second = await setEventMeetingFromConversation(conv.id, ev.id, { url: 'https://meet.google.com/new-url' });
    expect(second.event!.description).not.toContain('zoom.us/j/111');
    expect(second.event!.description).not.toContain('パスコード: aaa');
    expect(second.event!.description).toContain('Google Meet（相手方発行）: https://meet.google.com/new-url');
    expect(second.event!.description).toContain('会話から登録');
    expect(second.event!.location).toBe('Google Meet（相手方発行）');

    // 事務所など、入力した場所はそのまま
    db().update(schema.calendarEvents).set({ location: '相手方事務所' }).where(eq(schema.calendarEvents.id, ev.id)).run();
    expect((await setEventMeetingFromConversation(conv.id, ev.id, { url: 'https://zoom.us/j/222' })).event!.location).toBe('相手方事務所');
    // 別の依頼者の予定には入れない
    const other = seedConversation('別 依頼者', 'x-3');
    await expect(setEventMeetingFromConversation(other.conv.id, ev.id, { url: 'https://zoom.us/j/333' })).rejects.toThrow('この会話の相手の予定ではありません');
    expect(client.id).toBeGreaterThan(0);
  });

  it('仮押さえで「相手が発行」なら、確定してもこちらでは作らない。WEB の仮押さえも、確定のときに相手の URL を選べる', async () => {
    created.length = 0;
    const { conv } = seedConversation('大阪 損保', 'x-4');
    const r = await registerScheduleFromConversation(conv.id, { mode: 'holds', title: '大阪 打合せ', kind: 'meeting', slots: [slot('2027-11-07T01:00:00.000Z'), slot('2027-11-08T01:00:00.000Z')], web: true, meetingBy: 'them', meeting: null });
    expect(r.events[0]!.location).toBe('WEB会議（相手方発行）');
    const confirmed = await confirmHold(r.sessionId!, r.events[0]!.id);
    expect(created.length).toBe(0);
    expect(confirmed.description).toContain(EXTERNAL_PENDING_LINE);

    // こちらで発行する予定だった WEB の仮押さえを、相手の URL で確定する
    const r2 = await registerScheduleFromConversation(conv.id, { mode: 'holds', title: '大阪 打合せ2', kind: 'meeting', slots: [slot('2027-11-09T01:00:00.000Z'), slot('2027-11-10T01:00:00.000Z')], web: true });
    const c2 = await confirmHoldFromConversation(conv.id, r2.sessionId!, r2.events[1]!.id, { meetingBy: 'them', meeting: { url: 'https://zoom.us/j/444', meetingId: '444' } });
    expect(created.length).toBe(0);
    expect(c2.webText).toBe('Zoom（相手方発行）: https://zoom.us/j/444\nミーティング ID: 444');
    expect(c2.event.description).toContain('Zoom（相手方発行）: https://zoom.us/j/444');
    expect(c2.event.description).not.toContain('確定したときに会議 URL を発行します');
    expect(c2.event.location).toBe('Zoom（相手方発行）');
  });
});
