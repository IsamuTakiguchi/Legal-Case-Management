import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-propose-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { proposeSlots } = await import('../services/scheduling.js');
const { pendingHoldsFor, listPendingHoldSets, confirmHold } = await import('../services/court.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

/** 来週の月曜〜金曜（JST） */
function nextWeek() {
  const d = new Date(Date.now() + 9 * 3600_000);
  const day = d.getUTCDay();
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + ((8 - day) % 7 || 7)));
  const ymd = (x: Date) => x.toISOString().slice(0, 10);
  return { from: `${ymd(monday)}T00:00:00+09:00`, to: `${ymd(new Date(monday.getTime() + 4 * 86400_000))}T23:59:59+09:00` };
}

describe('空き時間から候補日を提案して仮押さえ', () => {
  it('ほかの画面と同じ仮押さえ（予定にも入る）として登録され、会話・予定ページから確定できる', async () => {
    const client = db().insert(schema.clients).values({ name: '山田 花子' }).returning().get();
    const conv = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: 't-propose', clientId: client.id, counterpartName: '山田 花子' }).returning().get();
    const r = await proposeSlots({ conversationId: conv.id, kind: 'WEB', ...nextWeek(), durationMinutes: 60, maxCandidates: 3 });
    expect(r.slots.length).toBe(3);
    expect(r.text.split('\n').filter((l) => l.startsWith('・'))).toHaveLength(3);
    // 予定（calendar_events）に仮押さえとして入っている
    const events = db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.clientId, client.id)).all();
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.kind === 'hold' && e.status === 'tentative' && e.title === '山田 WEB相談 仮')).toBe(true);
    expect(r.session).toMatchObject({ conversationId: conv.id, web: true, durationMinutes: 60, state: 'proposing' });
    // 会話の「日程・予定」と予定ページの「調整中の日程」に出る
    expect(pendingHoldsFor({ conversationId: conv.id, clientId: client.id }).map((h) => h.sessionId)).toEqual([r.session.id]);
    expect(listPendingHoldSets().find((h) => h.sessionId === r.session.id)?.candidates).toHaveLength(3);
    // 確定すると、ほかの候補は消えて相談の予定になる
    const chosen = events[1]!;
    await confirmHold(r.session.id, chosen.id, { web: false });
    const after = db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.clientId, client.id)).all();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: chosen.id, kind: 'consult', title: '山田 WEB相談', status: 'confirmed' });
  });
});
