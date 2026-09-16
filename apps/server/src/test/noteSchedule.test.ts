import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-noteschedule-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

/** AI が記録から読み取った内容（テストごとに差し替える） */
let extracted: Record<string, unknown> = {};
/** AI に渡した本文（記録の中身が渡っているかを確かめる） */
let lastPrompt = '';
vi.mock('../integrations/anthropic.js', () => ({
  generateStructured: async (req: { user: string }) => {
    lastPrompt = req.user;
    return extracted;
  },
}));
/** カレンダーは空（予定なし）にして、空き枠の選び方だけを見る */
vi.mock('../integrations/calendar.js', () => ({ listEvents: async () => [] }));

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { proposeScheduleFromNote } = await import('../services/noteSchedule.js');
const { setSetting } = await import('../services/settings.js');

beforeAll(() => {
  openTestDatabase();
  setSetting('business_hours_start', '10:00');
  setSetting('business_hours_end', '18:00');
  setSetting('default_meeting_minutes', '60');
});
afterAll(() => closeDatabase());

/** 読み取り結果の既定形（テストで一部だけ上書きする） */
function extraction(patch: Record<string, unknown> = {}) {
  return {
    found: true,
    content: '打合せ',
    kind: 'meeting',
    web: null,
    durationMinutes: null,
    earliest: null,
    latest: null,
    weekdays: [],
    timeRanges: [],
    avoid: [],
    requested: [],
    quote: '',
    note: '',
    ...patch,
  };
}

function seedNote(patch: Record<string, unknown> = {}) {
  const client = db().insert(schema.clients).values({ name: '山田 花子' }).returning().get();
  const kase = db().insert(schema.cases).values({ clientId: client.id, title: '山田 離婚' }).returning().get();
  const note = db()
    .insert(schema.caseNotes)
    .values({
      caseId: kase.id,
      clientId: client.id,
      kind: 'phone',
      counterpart: '山田 花子',
      occurredAt: '2027-09-01T01:00:00.000Z',
      gist: '次回の打合せ日程を相談した',
      theirSaid: ['来週の午後がよい'],
      ourSaid: ['候補を 3 つ出します'],
      decisions: '次回打合せは来週の午後で調整',
      nextActions: [{ title: '候補日を送る', due: null }],
      rawText: '来週の午後で、と本人の希望。',
      ...patch,
    })
    .returning()
    .get();
  return { client, kase, note };
}

describe('記録から日程調整', () => {
  it('記録の中身を読み取りに渡し、希望の曜日・時間帯に合う候補を出す', async () => {
    const { note, kase, client } = seedNote();
    // 来週の月・水の午後を希望、という読み取り結果にする
    extracted = extraction({
      content: '進捗報告の打合せ',
      earliest: '2027-09-06',
      latest: '2027-09-10',
      weekdays: [1, 3],
      timeRanges: [{ from: '13:00', to: '17:00' }],
      quote: '次回打合せは来週の午後で調整',
      note: '来週の月・水の午後を希望',
    });
    const r = await proposeScheduleFromNote(note.id);

    // 記録の各項目が読み取りに渡っている
    expect(lastPrompt).toContain('次回の打合せ日程を相談した');
    expect(lastPrompt).toContain('来週の午後がよい');
    expect(lastPrompt).toContain('次回打合せは来週の午後で調整');
    expect(lastPrompt).toContain('候補日を送る');
    expect(lastPrompt).toContain('山田 離婚');

    expect(r).toMatchObject({ found: true, content: '進捗報告の打合せ', kind: 'meeting', caseId: kase.id, clientId: client.id, clientName: '山田 花子', blocked: null });
    expect(r.summary).toBe('09/06〜09/10、月・水曜、13:00〜17:00');
    expect(r.durationMinutes).toBe(60);
    expect(r.slots.length).toBeGreaterThan(0);
    // 候補はすべて希望の曜日と時間帯に収まっている
    for (const s of r.slots) {
      const jst = new Date(new Date(s.startAt).getTime() + 9 * 3600_000);
      expect([1, 3]).toContain(jst.getUTCDay());
      expect(jst.getUTCHours()).toBeGreaterThanOrEqual(13);
      expect(new Date(new Date(s.endAt).getTime() + 9 * 3600_000).getUTCHours()).toBeLessThanOrEqual(17);
      expect(new Date(s.endAt).getTime() - new Date(s.startAt).getTime()).toBe(60 * 60_000);
    }
  });

  it('日時が決まっている記録では候補を出さない', async () => {
    const { note } = seedNote({ decisions: '次回期日は 10 月 11 日 13 時 30 分に決まった' });
    extracted = extraction({ found: false, content: '', quote: '', note: '日時は確定済み' });
    const r = await proposeScheduleFromNote(note.id);
    expect(r.found).toBe(false);
    expect(r.slots).toEqual([]);
    expect(r.blocked).toBeNull();
    // 件名は空でも既定を入れて、手で仮押さえできるようにする
    expect(r.content).toBe('打合せ');
  });

  it('所要時間は 記録の言及 → 画面の指定 の順で使い、過ぎた希望日時は捨てる', async () => {
    const { note } = seedNote();
    extracted = extraction({
      durationMinutes: 90,
      requested: [
        { startAt: '2020-01-01T10:00:00+09:00', quote: '去年の話' },
        { startAt: '2099-05-07T14:00:00+09:00', quote: '5/7 の午後' },
      ],
    });
    const r1 = await proposeScheduleFromNote(note.id);
    expect(r1.durationMinutes).toBe(90);
    expect(r1.preferences.requested).toEqual([{ startAt: new Date('2099-05-07T14:00:00+09:00').toISOString(), quote: '5/7 の午後' }]);
    // 画面で長さを指定したらそちらが勝つ
    const r2 = await proposeScheduleFromNote(note.id, { durationMinutes: 30 });
    expect(r2.durationMinutes).toBe(30);
  });

  it('壊れた日付・時間帯は捨てる', async () => {
    const { note } = seedNote();
    extracted = extraction({
      earliest: '来週',
      latest: '2027-09-10',
      weekdays: [2, 2, 4],
      timeRanges: [{ from: '13:00', to: '12:00' }, { from: 'ひる', to: '15:00' }, { from: '9:30', to: '11:30' }],
    });
    const r = await proposeScheduleFromNote(note.id);
    expect(r.preferences.earliest).toBeNull();
    expect(r.preferences.latest).toBe('2027-09-10');
    expect(r.preferences.weekdays).toEqual([2, 4]);
    expect(r.preferences.timeRanges).toEqual([{ from: '09:30', to: '11:30' }]);
  });

  it('カレンダーの空きが読めなくても、読み取った条件は返す', async () => {
    const cal = await import('../integrations/calendar.js');
    const spy = vi.spyOn(cal, 'listEvents').mockRejectedValueOnce(new Error('Google に接続されていません'));
    const { note } = seedNote();
    extracted = extraction({ note: '来週の午後を希望' });
    const r = await proposeScheduleFromNote(note.id);
    expect(r.found).toBe(true);
    expect(r.note).toBe('来週の午後を希望');
    expect(r.slots).toEqual([]);
    expect(r.blocked).toContain('Google に接続されていません');
    spy.mockRestore();
  });
});
