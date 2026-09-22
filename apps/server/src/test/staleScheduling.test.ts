import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-stalesched-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { checkStaleSessions, sessionCaseId } = await import('../services/scheduling.js');
const { openAlerts } = await import('../services/alerts.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

let clientId = 0;
let caseId = 0;

beforeEach(() => {
  db().delete(schema.alerts).run();
  db().delete(schema.schedulingSessions).run();
  db().delete(schema.calendarEvents).run();
  db().delete(schema.conversations).run();
  db().delete(schema.cases).run();
  db().delete(schema.clients).run();
  clientId = db().insert(schema.clients).values({ name: '山田 花子' }).returning().get().id;
  caseId = db().insert(schema.cases).values({ clientId, title: '離婚調停申立事件', caseType: 'divorce', status: 'active' }).returning().get().id;
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

/** 候補ごとの仮予定と、それを指す日程調整を作る */
function makeSession(opts: { caseId: number | null; conversationId?: number | null; proposedAt?: string | null; withEvents?: boolean }) {
  const startAt = '2026-10-03T05:00:00.000Z';
  const endAt = '2026-10-03T06:00:00.000Z';
  const candidates: { startAt: string; endAt: string; eventId?: string }[] = [];
  if (opts.withEvents !== false) {
    const googleEventId = `local-hold-${Math.random().toString(36).slice(2)}`;
    db()
      .insert(schema.calendarEvents)
      .values({ googleEventId, clientId, caseId: opts.caseId, kind: 'hold', title: '山田　打合せ 仮', startAt, endAt, status: 'tentative' })
      .run();
    candidates.push({ startAt, endAt, eventId: googleEventId });
  } else {
    candidates.push({ startAt, endAt });
  }
  return db()
    .insert(schema.schedulingSessions)
    .values({
      clientId,
      conversationId: opts.conversationId ?? null,
      kind: '打合せ',
      state: 'proposing',
      candidates,
      proposedAt: opts.proposedAt === undefined ? daysAgo(30) : opts.proposedAt,
    })
    .returning()
    .get();
}

const staleAlert = () => openAlerts().find((a) => a.type === 'scheduling_stale');

describe('日程調整が停滞したときのお知らせ', () => {
  it('仮押さえた予定から、どの事件の調整かを割り出す', () => {
    const s = makeSession({ caseId });
    expect(sessionCaseId(s)).toBe(caseId);
    // 事件がまだ決まっていない仮押さえは null（会話から始めたもの）
    expect(sessionCaseId(makeSession({ caseId: null }))).toBeNull();
    // 予定そのものが無いときも落ちない
    expect(sessionCaseId(makeSession({ caseId: null, withEvents: false }))).toBeNull();
  });

  it('日程変更のときは、元の予定の事件を使う', () => {
    const original = db()
      .insert(schema.calendarEvents)
      .values({ googleEventId: 'g-original', clientId, caseId, kind: 'meeting', title: '山田　打合せ', startAt: '2026-09-01T05:00:00.000Z', endAt: '2026-09-01T06:00:00.000Z', status: 'confirmed' })
      .returning()
      .get();
    const s = db()
      .insert(schema.schedulingSessions)
      .values({ clientId, kind: '打合せ', state: 'proposing', candidates: [{ startAt: '2026-10-03T05:00:00.000Z', endAt: '2026-10-03T06:00:00.000Z' }], rescheduleEventId: original.id, proposedAt: daysAgo(30) })
      .returning()
      .get();
    expect(sessionCaseId(s)).toBe(caseId);
  });

  it('お知らせに、飛び先（日程調整・事件・会話）を入れる', () => {
    const s = makeSession({ caseId });
    expect(checkStaleSessions()).toBe(1);
    const a = staleAlert()!;
    expect(a.payload.sessionId).toBe(s.id);
    expect(a.payload.caseId).toBe(caseId);
    expect(a.payload.conversationId).toBeNull();
    expect(a.payload.candidates).toBe(1);
  });

  it('会話から始めた調整は、会話の行き先も入る', () => {
    const conv = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: 't-1', clientId }).returning().get();
    makeSession({ caseId: null, conversationId: conv.id });
    checkStaleSessions();
    const a = staleAlert()!;
    expect(a.payload.conversationId).toBe(conv.id);
    expect(a.payload.caseId).toBeNull();
  });

  it('すでに出ているお知らせにも、あとから決まった事件を入れ直す', () => {
    const s = makeSession({ caseId: null });
    checkStaleSessions();
    expect(staleAlert()!.payload.caseId).toBeNull();

    // 会話から始めた仮押さえを、あとで事件に紐付けた場合
    db().update(schema.calendarEvents).set({ caseId }).where(eq(schema.calendarEvents.googleEventId, s.candidates[0]!.eventId!)).run();
    checkStaleSessions();
    expect(openAlerts().filter((a) => a.type === 'scheduling_stale').length).toBe(1);
    expect(staleAlert()!.payload.caseId).toBe(caseId);
  });

  it('提案からまだ日が浅いものは知らせない', () => {
    makeSession({ caseId, proposedAt: new Date().toISOString() });
    expect(checkStaleSessions()).toBe(0);
    expect(staleAlert()).toBeUndefined();
  });
});
