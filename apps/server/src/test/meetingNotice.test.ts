import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-mtg-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.STORAGE_BACKEND = 'local';
process.env.LOCAL_CLIENT_ROOT = path.join(tmp, 'clients');
// Chatwork を「設定済み」にして送り先を作る。AI は使わない（下書きはテンプレートで出る）
process.env.CHATWORK_API_TOKEN = 'test-token';

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { prepareMeetingNotice } = await import('../services/meetingNotice.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

const day = 86400_000;

function seed(name: string, room: number) {
  const client = db().insert(schema.clients).values({ name, chatworkRoomId: room }).returning().get();
  const kase = db().insert(schema.cases).values({ clientId: client.id, title: `${name} 離婚` }).returning().get();
  const note = db()
    .insert(schema.caseNotes)
    .values({
      caseId: kase.id,
      clientId: client.id,
      kind: 'meeting',
      occurredAt: new Date(Date.now() - 3600_000).toISOString(),
      rawText: '財産分与の方針を確認。',
      gist: '財産分与の方針を確認した。',
      decisions: ['自宅は売却する方向'],
      nextActions: [{ title: '源泉徴収票（直近 2 年分）を送ってもらう', replyBy: '11月20日' }, { title: '当方で査定を依頼' }],
      theirSaid: [],
      ourSaid: [],
      attachments: [],
    })
    .returning()
    .get();
  return { client, kase, note };
}

function event(v: { clientId: number; caseId: number | null; startAt: Date; kind?: string; description?: string | null; location?: string | null; status?: string; googleEventId?: string; title?: string }) {
  return db()
    .insert(schema.calendarEvents)
    .values({
      googleEventId: v.googleEventId ?? `g-${Math.random()}`,
      clientId: v.clientId,
      caseId: v.caseId,
      kind: v.kind ?? 'meeting',
      title: v.title ?? '打合せ',
      startAt: v.startAt.toISOString(),
      endAt: new Date(v.startAt.getTime() + 3600_000).toISOString(),
      location: v.location ?? null,
      description: v.description ?? null,
      status: v.status ?? 'confirmed',
    })
    .returning()
    .get();
}

describe('打合せの記録から依頼者への連絡', () => {
  it('次回の打合せの日時・Zoom の URL・パスコードと、確認事項を本文に入れる', async () => {
    const { client, kase, note } = seed('山田 花子', 301);
    // 仮押さえ・取り消し・期日は次回の打合せにしない
    event({ clientId: client.id, caseId: kase.id, startAt: new Date(Date.now() + 2 * day), status: 'tentative', title: '山田 打合せ 仮' });
    event({ clientId: client.id, caseId: kase.id, startAt: new Date(Date.now() + 3 * day), status: 'cancelled' });
    event({ clientId: client.id, caseId: kase.id, startAt: new Date(Date.now() + 4 * day), kind: 'hearing' });
    const ev = event({ clientId: client.id, caseId: kase.id, startAt: new Date(Date.now() + 7 * day), location: 'Zoom', description: 'Zoom: https://zoom.us/j/123456789\nパスコード: abc123\n記録から登録' });
    const later = event({ clientId: client.id, caseId: null, startAt: new Date(Date.now() + 14 * day), kind: 'consult', location: '事務所' });

    const r = await prepareMeetingNotice(note.id);
    expect(r.channel).toBe('chatwork');
    expect(r.nextMeeting?.eventId).toBe(ev.id);
    expect(r.nextMeeting?.url).toBe('https://zoom.us/j/123456789');
    expect(r.nextMeeting?.passcode).toBe('abc123');
    expect(r.meetings.map((m) => m.eventId)).toEqual([ev.id, later.id]);
    expect(r.text).toContain('https://zoom.us/j/123456789');
    expect(r.text).toContain('パスコード: abc123');
    expect(r.text).toContain('源泉徴収票（直近 2 年分）を送ってもらう（11月20日までにご返信）');
    expect(r.text).toContain('自宅は売却する方向');
    expect(r.text).toContain('山田様');
    // 「場所: Zoom」のように URL の代わりの言葉は場所として出さない
    expect(r.nextMeeting?.text).not.toContain('場所');

    // 別の打合せ（対面）を選べる
    const other = await prepareMeetingNotice(note.id, { eventId: later.id });
    expect(other.nextMeeting?.eventId).toBe(later.id);
    expect(other.text).toContain('場所: 事務所');
    expect(other.text).not.toContain('zoom.us');

    // 「次回の案内を入れない」
    const none = await prepareMeetingNotice(note.id, { eventId: null });
    expect(none.nextMeeting).toBeNull();
    expect(none.text).toContain('追ってご連絡いたします');
  });

  it('予定の説明欄に URL が無くても、日程調整で発行した Zoom を使う', async () => {
    const { client, kase, note } = seed('佐藤 太郎', 302);
    const ev = event({ clientId: client.id, caseId: kase.id, startAt: new Date(Date.now() + 5 * day), googleEventId: 'g-session-1', location: null, description: null });
    db()
      .insert(schema.schedulingSessions)
      .values({ clientId: client.id, kind: '打合せ', state: 'confirmed', confirmedEventId: 'g-session-1', zoom: { id: '9', joinUrl: 'https://zoom.us/j/999', password: 'pw9' } })
      .run();
    const r = await prepareMeetingNotice(note.id);
    expect(r.nextMeeting?.eventId).toBe(ev.id);
    expect(r.text).toContain('https://zoom.us/j/999');
    expect(r.text).toContain('パスコード: pw9');
  });

  it('次回の打合せがカレンダーに無くても下書きは作れる', async () => {
    const { note } = seed('鈴木 一郎', 303);
    const r = await prepareMeetingNotice(note.id);
    expect(r.nextMeeting).toBeNull();
    expect(r.meetings).toEqual([]);
    expect(r.confirmItems).toHaveLength(2);
    expect(r.text).toContain('財産分与の方針を確認した。');
  });
});
