import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-holdloc-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

/** 会話から始める日程調整は Google カレンダーに直接入れるので、送った中身を控える */
const created: { title: string; location?: string | null }[] = [];
vi.mock('../integrations/calendar.js', async (orig) => {
  const actual = await orig<typeof import('../integrations/calendar.js')>();
  return {
    ...actual,
    createEvent: vi.fn(async (opts: { title: string; startAt: Date; endAt: Date; location?: string | null }) => {
      created.push({ title: opts.title, location: opts.location });
      return { id: `g-${created.length}`, title: opts.title, startAt: opts.startAt.toISOString(), endAt: opts.endAt.toISOString(), location: opts.location ?? null, meetUrl: null };
    }),
    deleteEvent: vi.fn(async () => undefined),
  };
});

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { createHoldSet, setHoldSetLocation, confirmHold, listCaseHolds } = await import('../services/court.js');
const { holdProposalContext, buildProposalText } = await import('../services/holdProposal.js');
const { confirmSlot } = await import('../services/scheduling.js');
const { setSetting } = await import('../services/settings.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

let clientId = 0;
let caseId = 0;

beforeEach(() => {
  created.length = 0;
  db().delete(schema.schedulingSessions).run();
  db().delete(schema.calendarEvents).run();
  db().delete(schema.conversations).run();
  db().delete(schema.cases).run();
  db().delete(schema.clients).run();
  clientId = db().insert(schema.clients).values({ name: '山田 花子' }).returning().get().id;
  caseId = db().insert(schema.cases).values({ clientId, title: '離婚調停申立事件', caseType: 'divorce', status: 'active' }).returning().get().id;
  setSetting('hold_proposal_template', '');
});

const future = (days: number, hour = 1) => {
  const d = new Date(Date.now() + days * 86400_000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const slots = () => [
  { startAt: future(7), endAt: future(7, 2) },
  { startAt: future(8), endAt: future(8, 2) },
];
const events = () => db().select().from(schema.calendarEvents).all();

describe('仮押さえの場所', () => {
  it('仮押さえに入れた場所は、候補すべてと日程調整に残る', async () => {
    const r = await createHoldSet({ title: '打合せ', kind: 'meeting', clientId, caseId, location: '奈良地裁 3 階', slots: slots() });
    expect(events().map((e) => e.location)).toEqual(['奈良地裁 3 階', '奈良地裁 3 階']);
    const session = db().select().from(schema.schedulingSessions).where(eq(schema.schedulingSessions.id, r.sessionId)).get()!;
    expect(session.location).toBe('奈良地裁 3 階');
    expect(listCaseHolds(caseId)[0]!.location).toBe('奈良地裁 3 階');
  });

  it('あとから場所をまとめて入れ直せて、確定した予定にもそのまま残る', async () => {
    const r = await createHoldSet({ title: '打合せ', kind: 'meeting', clientId, caseId, slots: slots() });
    expect(listCaseHolds(caseId)[0]!.location).toBeNull();

    const changed = await setHoldSetLocation(r.sessionId, '  依頼者の会社  ');
    expect(changed).toMatchObject({ location: '依頼者の会社', updated: 2 });
    expect(events().every((e) => e.location === '依頼者の会社')).toBe(true);
    expect(listCaseHolds(caseId)[0]!.location).toBe('依頼者の会社');

    await confirmHold(r.sessionId, r.events[1]!.id);
    const left = events();
    expect(left.length).toBe(1);
    expect(left[0]!.location).toBe('依頼者の会社');
    expect(left[0]!.status).not.toBe('tentative');
    // 確定したあとは変えられない（予定の編集から直す）
    await expect(setHoldSetLocation(r.sessionId, '事務所')).rejects.toThrow('確定または取消');
  });

  it('空にすると場所を外す', async () => {
    const r = await createHoldSet({ title: '打合せ', kind: 'meeting', clientId, caseId, location: '事務所', slots: slots() });
    await setHoldSetLocation(r.sessionId, '');
    expect(events().every((e) => e.location === null)).toBe(true);
    expect(listCaseHolds(caseId)[0]!.location).toBeNull();
  });

  it('WEB 会議の仮押さえで場所を外すと、会議の種類を残す', async () => {
    const r = await createHoldSet({ title: 'WEB相談', kind: 'consult', clientId, caseId, web: true, location: '第 2 会議室', slots: slots() });
    await setHoldSetLocation(r.sessionId, null);
    expect(events().every((e) => e.location === 'WEB会議')).toBe(true);
  });

  it('候補日の打診文に場所を添える', async () => {
    const r = await createHoldSet({ title: '打合せ', kind: 'meeting', clientId, caseId, location: '事務所', slots: slots() });
    const ctx = holdProposalContext(r.sessionId);
    expect(ctx.location).toBe('事務所');
    expect(ctx.text.split('\n').at(-1)).toBe('場所: 事務所');

    // テンプレートに {location} があれば、そこに入れて最後には足さない
    setSetting('hold_proposal_template', '{kind}の候補日（場所: {location}）\n{slots}');
    const t = holdProposalContext(r.sessionId).text;
    expect(t.startsWith('打合せの候補日（場所: 事務所）')).toBe(true);
    expect(t.match(/事務所/g)!.length).toBe(1);
  });

  it('場所を決めていなければ、打診文はこれまでどおり', () => {
    const c = [{ startAt: '2026-10-05T01:00:00.000Z', endAt: '2026-10-05T02:00:00.000Z' }];
    expect(buildProposalText({ kind: '打合せ', clientName: null, candidates: c })).toBe('打合せの候補日ですが、\n10/5 10:00-\nでいかがでしょうか？');
    expect(buildProposalText({ kind: '打合せ', clientName: null, candidates: c, location: ' ' })).not.toContain('場所');
  });

  it('会話から始めた日程調整でも、決めた場所で確定する（無ければ事務所）', async () => {
    const conv = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'U1', clientId }).returning().get();
    const mk = (location: string | null) =>
      db()
        .insert(schema.schedulingSessions)
        .values({ clientId, conversationId: conv.id, kind: '打合せ', state: 'proposing', candidates: [{ startAt: future(7), endAt: future(7, 2), eventId: 'g-hold' }], location, proposedAt: new Date().toISOString() })
        .returning()
        .get();
    await confirmSlot({ sessionId: mk('奈良地裁').id, startAt: future(7), durationMinutes: 60, createZoom: false });
    expect(created.at(-1)!.location).toBe('奈良地裁');
    await confirmSlot({ sessionId: mk(null).id, startAt: future(7), durationMinutes: 60, createZoom: false });
    expect(created.at(-1)!.location).toContain('登大路総合法律事務所');
  });
});
