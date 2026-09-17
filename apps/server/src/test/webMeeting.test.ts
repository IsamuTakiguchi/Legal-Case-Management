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
