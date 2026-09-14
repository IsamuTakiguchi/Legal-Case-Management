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
