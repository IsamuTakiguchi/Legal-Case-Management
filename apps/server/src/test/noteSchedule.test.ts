import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { eq } from 'drizzle-orm';

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
const { proposeScheduleFromNote, registerScheduleFromNote } = await import('../services/noteSchedule.js');
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
    fixed: [],
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
      decisions: ['次回打合せは来週の午後で調整'],
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

  it('日時が決まっている記録では候補を出さず、決まっている日時を fixed で返す', async () => {
    const { note } = seedNote({ decisions: ['次回期日は 10 月 11 日 13 時 30 分に決まった'] });
    extracted = extraction({
      found: false,
      content: '',
      quote: '',
      note: '日時は確定済み',
      fixed: [{ startAt: '2099-10-11T13:30:00+09:00', timeKnown: true, content: '第3回弁論準備', kind: 'hearing', durationMinutes: 30, quote: '次回期日は 10 月 11 日 13 時 30 分' }],
    });
    const r = await proposeScheduleFromNote(note.id);
    expect(r.found).toBe(false);
    expect(r.slots).toEqual([]);
    expect(r.blocked).toBeNull();
    // 件名は空でも既定を入れて、手で仮押さえできるようにする
    expect(r.content).toBe('打合せ');
    // 決まっている日時はそのまま予定にできる形で返る
    expect(r.fixed).toEqual([
      {
        startAt: new Date('2099-10-11T13:30:00+09:00').toISOString(),
        endAt: new Date('2099-10-11T14:00:00+09:00').toISOString(),
        timeKnown: true,
        content: '第3回弁論準備',
        kind: 'hearing',
        quote: '次回期日は 10 月 11 日 13 時 30 分',
      },
    ]);
  });

  it('決まっている日時は、過ぎたものを捨てて早い順に返し、所要が無ければ既定の長さにする', async () => {
    const { note } = seedNote();
    extracted = extraction({
      found: false,
      fixed: [
        { startAt: '2099-12-01T15:00:00+09:00', timeKnown: true, content: '判決', kind: 'hearing', durationMinutes: null, quote: '12/1 15 時' },
        { startAt: '2020-03-03T10:00:00+09:00', timeKnown: true, content: '去年の期日', kind: 'hearing', durationMinutes: null, quote: '過去' },
        { startAt: '2099-10-05T10:00:00+09:00', timeKnown: false, content: '', kind: 'other', durationMinutes: null, quote: '10/5' },
        { startAt: 'あした', timeKnown: false, content: '打合せ', kind: 'meeting', durationMinutes: null, quote: '' },
      ],
    });
    const r = await proposeScheduleFromNote(note.id);
    expect(r.fixed.map((f) => f.quote)).toEqual(['10/5', '12/1 15 時']);
    // 種別 other は打合せに寄せ、内容が空なら既定を入れる
    expect(r.fixed[0]).toMatchObject({ kind: 'meeting', content: '打合せ', timeKnown: false });
    // 所要の言及が無いので既定の 60 分
    expect(new Date(r.fixed[0]!.endAt).getTime() - new Date(r.fixed[0]!.startAt).getTime()).toBe(60 * 60_000);
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

describe('記録から予定を登録', () => {
  it('決まっている日時をそのまま予定にする（依頼者・事件が付き、記録の出どころが説明に残る）', async () => {
    const { note, kase, client } = seedNote({ gist: '次回期日を 10/11 13:30 と指定された' });
    const startAt = '2099-10-11T13:30:00+09:00';
    const endAt = '2099-10-11T14:00:00+09:00';
    const r = await registerScheduleFromNote(note.id, {
      mode: 'confirmed',
      title: '山田 第3回弁論準備',
      kind: 'hearing',
      slots: [{ startAt, endAt }],
    });
    expect(r.mode).toBe('confirmed');
    expect(r.events).toHaveLength(1);
    const ev = r.events[0]!;
    expect(ev).toMatchObject({ title: '山田 第3回弁論準備', kind: 'hearing', clientId: client.id, caseId: kase.id, status: 'confirmed' });
    expect(ev.startAt).toBe(new Date(startAt).toISOString());
    expect(ev.endAt).toBe(new Date(endAt).toISOString());
    // どの記録から作ったかが説明に残る
    expect(ev.description).toContain('記録から登録');
    expect(ev.description).toContain('電話');
    expect(ev.description).toContain('次回期日を 10/11 13:30 と指定された');
    // 事件の次回期日にも反映される
    expect(db().select().from(schema.cases).where(eq(schema.cases.id, kase.id)).get()?.nextHearingAt).toBe(new Date(startAt).toISOString());
    // Zoom も Google も未接続なので会議 URL は付かない
    expect(r.web).toBeNull();
    expect(r.webText).toBe('');
  });

  it('WEB を選ぶと、会議 URL が無くても場所に WEB 会議と入る', async () => {
    const { note } = seedNote();
    const r = await registerScheduleFromNote(note.id, {
      mode: 'confirmed',
      title: '山田 打合せ',
      kind: 'meeting',
      web: true,
      slots: [{ startAt: '2099-11-04T10:00:00+09:00', endAt: '2099-11-04T11:00:00+09:00' }],
    });
    expect(r.events[0]!.location).toBe('WEB会議');
  });

  it('候補が複数あるときは仮押さえにし、件名は「姓 内容 仮」になる', async () => {
    const { note, kase, client } = seedNote();
    const r = await registerScheduleFromNote(note.id, {
      mode: 'holds',
      title: '山田 打合せ',
      kind: 'meeting',
      slots: [
        { startAt: '2099-11-05T14:00:00+09:00', endAt: '2099-11-05T15:00:00+09:00' },
        { startAt: '2099-11-04T10:00:00+09:00', endAt: '2099-11-04T11:00:00+09:00' },
      ],
    });
    expect(r.mode).toBe('holds');
    expect(r.sessionId).toBeGreaterThan(0);
    expect(r.events).toHaveLength(2);
    // 件名に姓を二重に付けない
    for (const ev of r.events) {
      expect(ev.title).toBe('山田 打合せ 仮');
      expect(ev.status).toBe('tentative');
      expect(ev).toMatchObject({ kind: 'hold', clientId: client.id, caseId: kase.id });
    }
    // 早い順に並ぶ
    expect(r.events[0]!.startAt).toBe(new Date('2099-11-04T10:00:00+09:00').toISOString());
  });

  it('日時が無ければ登録しない', async () => {
    const { note } = seedNote();
    await expect(registerScheduleFromNote(note.id, { mode: 'confirmed', title: '打合せ', kind: 'meeting', slots: [] })).rejects.toThrow('日時がありません');
  });
});
