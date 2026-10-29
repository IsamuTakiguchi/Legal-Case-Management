import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-holdwin-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.STORAGE_BACKEND = 'local';
process.env.LOCAL_CLIENT_ROOT = path.join(tmp, 'clients');
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { createHoldSet, confirmHold, listCaseHolds, pendingHoldsFor, todaysEvents } = await import('../services/court.js');
const { formatSlotLine, buildProposalText } = await import('../services/holdProposal.js');
const { eventTimes } = await import('../integrations/calendar.js');
const { isAllDayRange, allDayRange, allDayLastYmd, formatJaEventTime, parseHoldText, jstYmd } = await import('@lcm/shared');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

describe('終日の予定', () => {
  it('JST の 0:00〜翌 0:00（何日か）を終日とみなす', () => {
    const r = allDayRange('2026-11-11');
    expect(r).toEqual({ startAt: '2026-11-10T15:00:00.000Z', endAt: '2026-11-11T15:00:00.000Z' });
    expect(isAllDayRange(r.startAt, r.endAt)).toBe(true);
    const two = allDayRange('2026-11-11', '2026-11-12');
    expect(isAllDayRange(two.startAt, two.endAt)).toBe(true);
    expect(allDayLastYmd(two.endAt)).toBe('2026-11-12');
    expect(isAllDayRange('2026-11-11T04:00:00.000Z', '2026-11-11T05:00:00.000Z')).toBe(false);
    // 0:00 始まりでも 24 時間の倍数でなければ終日ではない
    expect(isAllDayRange('2026-11-10T15:00:00.000Z', '2026-11-11T03:00:00.000Z')).toBe(false);
    expect(formatJaEventTime(r.startAt, r.endAt)).toBe('11月11日(水)終日');
    expect(formatJaEventTime(two.startAt, two.endAt)).toBe('11月11日(水)〜11月12日 終日');
  });

  it('Google には終日なら日付だけで送り、時刻のある予定に戻すときは日付を消す', () => {
    const r = allDayRange('2026-11-11');
    expect(eventTimes(new Date(r.startAt), new Date(r.endAt))).toEqual({ start: { date: '2026-11-11', dateTime: null, timeZone: null }, end: { date: '2026-11-12', dateTime: null, timeZone: null } });
    const t = eventTimes(new Date('2026-11-11T04:00:00.000Z'), new Date('2026-11-11T05:00:00.000Z'));
    expect(t.start).toEqual({ dateTime: '2026-11-11T04:00:00.000Z', timeZone: 'Asia/Tokyo', date: null });
  });

  it('「11/11 終日」と書けば終日の候補として読み取る', () => {
    const r = parseHoldText('11/11（水）終日\n11/12 10~11', { now: new Date('2026-10-29T00:00:00+09:00') });
    expect(r.errors).toEqual([]);
    expect(r.slots[0]).toMatchObject({ ...allDayRange('2026-11-11'), allDay: true, label: '11/11(水) 終日' });
    expect(r.slots[1]?.allDay).toBeFalsy();
  });

  it('終日で仮押さえ・確定でき、打診文は「終日」になる', async () => {
    const r = allDayRange('2026-11-11');
    const { sessionId, events } = await createHoldSet({ title: '打合せ', kind: 'meeting', counterpartName: '田中', slots: [r] });
    expect(events[0]).toMatchObject({ startAt: r.startAt, endAt: r.endAt });
    expect(formatSlotLine(r.startAt, r.endAt, '{M}/{D} {start}-')).toBe('11/11 終日');
    expect(formatSlotLine(r.startAt, r.endAt, '{M}月{D}日({wd}) {start}〜{end}')).toBe('11月11日(水) 終日');
    const confirmed = await confirmHold(sessionId, events[0]!.id);
    expect(confirmed).toMatchObject({ startAt: r.startAt, endAt: r.endAt, status: 'confirmed' });
  });

  it('今日の終日の予定も「今日の予定」に入る', () => {
    const r = allDayRange(jstYmd(new Date()));
    db().insert(schema.calendarEvents).values({ googleEventId: 'local-today-allday', kind: 'other', title: '終日の研修', startAt: r.startAt, endAt: r.endAt }).run();
    expect(todaysEvents().some((e) => e.title === '終日の研修')).toBe(true);
  });
});

describe('枠で仮押さえして、確定するときに時間を決める', () => {
  const win = { startAt: '2026-11-11T04:00:00.000Z', endAt: '2026-11-11T08:00:00.000Z' }; // 13:00〜17:00

  it('所要時間を覚え、打診文は「13:00〜17:00の間で60分」になる', async () => {
    const client = db().insert(schema.clients).values({ name: '山田 花子' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '山田 相続' }).returning().get();
    const { sessionId } = await createHoldSet({ title: '相談', kind: 'consult', clientId: client.id, caseId: kase.id, slots: [win], durationMinutes: 60 });
    expect(db().select().from(schema.schedulingSessions).where(eq(schema.schedulingSessions.id, sessionId)).get()!.durationMinutes).toBe(60);
    expect(listCaseHolds(kase.id).find((h) => h.sessionId === sessionId)?.durationMinutes).toBe(60);
    expect(pendingHoldsFor({ conversationId: -1, clientId: client.id }).find((h) => h.sessionId === sessionId)?.durationMinutes).toBe(60);
    expect(formatSlotLine(win.startAt, win.endAt, '{M}/{D} {start}-', 60)).toBe('11/11 13:00〜17:00の間で60分');
    // 枠でない（所要時間どおりの）候補はこれまでどおり
    expect(formatSlotLine(win.startAt, '2026-11-11T05:00:00.000Z', '{M}/{D} {start}-', 60)).toBe('11/11 13:00-');
    expect(buildProposalText({ kind: '相談', clientName: null, candidates: [win], durationMinutes: 60 })).toContain('11/11 13:00〜17:00の間で60分');
  });

  it('枠の中で決めた時間（14:00〜15:00）で確定する。枠の外は断る', async () => {
    const { sessionId, events } = await createHoldSet({ title: '相談', kind: 'consult', counterpartName: '鈴木', slots: [win], durationMinutes: 60 });
    await expect(confirmHold(sessionId, events[0]!.id, { time: { startAt: '2026-11-11T07:30:00.000Z', endAt: '2026-11-11T08:30:00.000Z' } })).rejects.toThrow('時間帯の中に');
    const r = await confirmHold(sessionId, events[0]!.id, { time: { startAt: '2026-11-11T05:00:00.000Z', endAt: '2026-11-11T06:00:00.000Z' } });
    expect(r).toMatchObject({ startAt: '2026-11-11T05:00:00.000Z', endAt: '2026-11-11T06:00:00.000Z', status: 'confirmed', title: '鈴木 相談' });
    expect(db().select().from(schema.schedulingSessions).where(eq(schema.schedulingSessions.id, sessionId)).get()).toMatchObject({ state: 'confirmed', confirmedStartAt: '2026-11-11T05:00:00.000Z' });
  });
});
