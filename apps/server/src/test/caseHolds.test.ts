import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-holds-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.STORAGE_BACKEND = 'local';
process.env.LOCAL_CLIENT_ROOT = path.join(tmp, 'clients');
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { listCaseHolds, attachHoldSetToCase } = await import('../services/court.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

/** 候補ごとの仮予定と、それを指す日程調整セッションを作る */
function makeHold(opts: { clientId: number | null; caseId: number | null; slots: string[]; title?: string }) {
  const candidates: { startAt: string; endAt: string; eventId?: string }[] = [];
  for (const [i, startAt] of opts.slots.entries()) {
    const endAt = new Date(new Date(startAt).getTime() + 3600_000).toISOString();
    const googleEventId = `local-hold-${Math.random().toString(36).slice(2)}-${i}`;
    db()
      .insert(schema.calendarEvents)
      .values({ googleEventId, clientId: opts.clientId, caseId: opts.caseId, kind: 'hold', title: opts.title ?? '山田 打合せ 仮', startAt, endAt, status: 'tentative' })
      .run();
    candidates.push({ startAt, endAt, eventId: googleEventId });
  }
  return db()
    .insert(schema.schedulingSessions)
    .values({ clientId: opts.clientId, conversationId: null, kind: '打合せ', state: 'proposing', candidates, proposedAt: new Date().toISOString() })
    .returning()
    .get();
}

describe('事件ページから見た仮押さえ', () => {
  it('この事件の仮押さえと、同じ依頼者で事件未定の仮押さえだけを出す', () => {
    const client = db().insert(schema.clients).values({ name: '山田 花子' }).returning().get();
    const other = db().insert(schema.clients).values({ name: '佐藤 太郎' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '山田 離婚' }).returning().get();
    const kase2 = db().insert(schema.cases).values({ clientId: client.id, title: '山田 相続' }).returning().get();

    const mine = makeHold({ clientId: client.id, caseId: kase.id, slots: ['2026-10-05T01:00:00.000Z', '2026-10-06T05:00:00.000Z'] });
    const unlinked = makeHold({ clientId: client.id, caseId: null, slots: ['2026-10-07T01:00:00.000Z'] });
    // ほかの事件のもの・ほかの依頼者のものは出さない
    makeHold({ clientId: client.id, caseId: kase2.id, slots: ['2026-10-08T01:00:00.000Z'] });
    makeHold({ clientId: other.id, caseId: null, slots: ['2026-10-09T01:00:00.000Z'] });
    // 確定済みは調整中ではないので出さない
    const done = makeHold({ clientId: client.id, caseId: kase.id, slots: ['2026-10-04T01:00:00.000Z'] });
    db().update(schema.schedulingSessions).set({ state: 'confirmed' }).where(eq(schema.schedulingSessions.id, done.id)).run();

    const sets = listCaseHolds(kase.id);
    expect(sets.map((s) => s.sessionId)).toEqual([mine.id, unlinked.id]);
    expect(sets[0]).toMatchObject({ linkedToCase: true, clientName: '山田 花子', kind: '打合せ' });
    expect(sets[0]!.candidates).toHaveLength(2);
    // 候補は開始の早い順で、確定に使う予定 ID が付く
    expect(sets[0]!.candidates[0]!.startAt < sets[0]!.candidates[1]!.startAt).toBe(true);
    expect(sets[0]!.candidates[0]!.eventId).toBeTypeOf('number');
    expect(sets[1]).toMatchObject({ linkedToCase: false });
  });

  it('事件が決まっていない仮押さえをこの事件に紐付けられる', () => {
    const client = db().insert(schema.clients).values({ name: '田中 一郎' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '田中 交通事故' }).returning().get();
    const s = makeHold({ clientId: client.id, caseId: null, slots: ['2026-11-02T01:00:00.000Z', '2026-11-04T01:00:00.000Z'] });

    expect(attachHoldSetToCase(s.id, kase.id)).toEqual({ updated: 2 });
    expect(listCaseHolds(kase.id)[0]).toMatchObject({ sessionId: s.id, linkedToCase: true });
    for (const c of s.candidates) {
      expect(db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.googleEventId, c.eventId!)).get()?.caseId).toBe(kase.id);
    }
    // もう一度押しても変わらない
    expect(attachHoldSetToCase(s.id, kase.id)).toEqual({ updated: 0 });
  });

  it('すでに別の事件の仮押さえは紐付けない', () => {
    const client = db().insert(schema.clients).values({ name: '鈴木 二郎' }).returning().get();
    const a = db().insert(schema.cases).values({ clientId: client.id, title: '鈴木 労働' }).returning().get();
    const b = db().insert(schema.cases).values({ clientId: client.id, title: '鈴木 破産' }).returning().get();
    const s = makeHold({ clientId: client.id, caseId: a.id, slots: ['2026-12-01T01:00:00.000Z'] });
    expect(() => attachHoldSetToCase(s.id, b.id)).toThrow(/別の事件/);
  });
});

describe('予定の日程変更（リスケ）', () => {
  it('候補を確定すると、元の予定は消えて新しい日時に置き換わる', async () => {
    const { startReschedule, confirmHold } = await import('../services/court.js');
    const client = db().insert(schema.clients).values({ name: '高橋 三郎' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '高橋 貸金返還' }).returning().get();
    const original = db()
      .insert(schema.calendarEvents)
      .values({ googleEventId: 'local-orig-1', clientId: client.id, caseId: kase.id, kind: 'meeting', title: '高橋 打合せ', startAt: '2027-01-12T01:00:00.000Z', endAt: '2027-01-12T02:00:00.000Z', location: '事務所', status: 'confirmed' })
      .returning()
      .get();

    const r = await startReschedule(original.id, { slots: [{ startAt: '2027-01-19T01:00:00.000Z', endAt: '2027-01-19T02:00:00.000Z' }, { startAt: '2027-01-20T05:00:00.000Z', endAt: '2027-01-20T06:00:00.000Z' }], note: '依頼者の都合' });
    // 元の予定は確定するまで残る
    expect(db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, original.id)).get()).toBeTruthy();
    // 件名は元の予定のまま「〜 仮」。姓が二重にならない
    const holds = db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.kind, 'hold')).all().filter((e) => e.caseId === kase.id);
    expect(holds).toHaveLength(2);
    expect(holds[0]!.title).toBe('高橋 打合せ 仮');
    expect(holds[0]!.location).toBe('事務所');

    // 事件ページには「日程変更」として出る
    const sets = listCaseHolds(kase.id);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.rescheduleOf).toMatchObject({ eventId: original.id, title: '高橋 打合せ', startAt: '2027-01-12T01:00:00.000Z' });

    // 2 つ目の候補で確定すると、元の予定ともう一方の候補が消える
    const chosen = sets[0]!.candidates[1]!.eventId!;
    const updated = await confirmHold(r.sessionId, chosen);
    expect(updated).toMatchObject({ title: '高橋 打合せ', kind: 'meeting', status: 'confirmed', startAt: '2027-01-20T05:00:00.000Z' });
    expect(db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, original.id)).get()).toBeUndefined();
    expect(db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.caseId, kase.id)).all().map((e) => e.kind)).toEqual(['meeting']);
    expect(listCaseHolds(kase.id)).toHaveLength(0);
  });

  it('同じ予定の日程変更は二重に始められない。仮押さえ自体はリスケできない', async () => {
    const { startReschedule } = await import('../services/court.js');
    const kase = db().insert(schema.cases).values({ clientId: db().insert(schema.clients).values({ name: '伊藤 四郎' }).returning().get().id, title: '伊藤 遺産分割' }).returning().get();
    const ev = db()
      .insert(schema.calendarEvents)
      .values({ googleEventId: 'local-orig-2', caseId: kase.id, kind: 'hearing', title: '伊藤 第1回期日', startAt: '2027-02-10T01:00:00.000Z', endAt: '2027-02-10T02:00:00.000Z', status: 'confirmed' })
      .returning()
      .get();
    await startReschedule(ev.id, { slots: [{ startAt: '2027-02-17T01:00:00.000Z', endAt: '2027-02-17T02:00:00.000Z' }] });
    await expect(startReschedule(ev.id, { slots: [{ startAt: '2027-02-18T01:00:00.000Z', endAt: '2027-02-18T02:00:00.000Z' }] })).rejects.toThrow(/すでに日程変更/);

    const hold = db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.googleEventId, listCaseHolds(kase.id)[0]!.candidates[0]!.googleEventId)).get()!;
    await expect(startReschedule(hold.id, { slots: [{ startAt: '2027-02-19T01:00:00.000Z', endAt: '2027-02-19T02:00:00.000Z' }] })).rejects.toThrow(/仮押さえ自体/);
  });
});

describe('日程変更の件名', () => {
  it('依頼者名と予定の件名がそろっていなくても、姓を二重に付けない', async () => {
    const { startReschedule } = await import('../services/court.js');
    const client = db().insert(schema.clients).values({ name: '【デモ】佐藤 太郎' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '佐藤 交通事故' }).returning().get();
    const ev = db()
      .insert(schema.calendarEvents)
      .values({ googleEventId: 'local-orig-3', clientId: client.id, caseId: kase.id, kind: 'meeting', title: '佐藤 打合せ', startAt: '2027-03-02T06:00:00.000Z', endAt: '2027-03-02T07:00:00.000Z', status: 'confirmed' })
      .returning()
      .get();
    await startReschedule(ev.id, { slots: [{ startAt: '2027-03-09T06:00:00.000Z', endAt: '2027-03-09T07:00:00.000Z' }] });
    expect(listCaseHolds(kase.id)[0]!.candidates[0]!.title).toBe('佐藤 打合せ 仮');
  });
});
