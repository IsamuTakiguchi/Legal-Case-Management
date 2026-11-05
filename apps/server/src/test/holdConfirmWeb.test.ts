import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-holdweb-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.STORAGE_BACKEND = 'local';
process.env.LOCAL_CLIENT_ROOT = path.join(tmp, 'clients');
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { createHoldSet, confirmHold, pendingHoldsFor } = await import('../services/court.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

const slot = { startAt: '2026-11-20T05:00:00.000Z', endAt: '2026-11-20T06:00:00.000Z' };
const event = (id: number) => db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id)).get()!;

describe('仮押さえを確定するときの来所・WEB', () => {
  it('来所で仮押さえしたものは、何も選ばなければ来所のまま確定する（会議 URL を扱わない）', async () => {
    const client = db().insert(schema.clients).values({ name: '山田 太郎' }).returning().get();
    const { sessionId, events } = await createHoldSet({ title: '打合せ', kind: 'meeting', clientId: client.id, location: '事務所', slots: [slot] });
    expect(pendingHoldsFor({ conversationId: -1, clientId: client.id }).find((h) => h.sessionId === sessionId)?.web).toBe(false);
    const r = await confirmHold(sessionId, events[0]!.id);
    expect(r.web).toBeNull();
    expect(event(events[0]!.id)).toMatchObject({ location: '事務所', status: 'confirmed' });
    expect(event(events[0]!.id).description ?? '').not.toContain('WEB');
  });

  it('WEB で仮押さえしたものでも、来所で確定すると会議 URL を作らず、場所から会議の種類を外す', async () => {
    const client = db().insert(schema.clients).values({ name: '佐藤 花子' }).returning().get();
    const { sessionId, events } = await createHoldSet({ title: '打合せ', kind: 'meeting', clientId: client.id, web: true, slots: [slot] });
    expect(pendingHoldsFor({ conversationId: -1, clientId: client.id }).find((h) => h.sessionId === sessionId)?.web).toBe(true);
    expect(event(events[0]!.id).location).toBe('WEB会議');
    const r = await confirmHold(sessionId, events[0]!.id, { web: false });
    expect(r.web).toBeNull();
    const e = event(events[0]!.id);
    expect(e.location).toBeNull();
    expect(e.description ?? '').not.toContain('WEB 会議');
    expect(e.status).toBe('confirmed');
  });

  it('来所で仮押さえしたものを WEB で確定すると、場所に会議の種類を入れる', async () => {
    const client = db().insert(schema.clients).values({ name: '高橋 健' }).returning().get();
    const { sessionId, events } = await createHoldSet({ title: '打合せ', kind: 'meeting', clientId: client.id, slots: [slot] });
    await confirmHold(sessionId, events[0]!.id, { web: true });
    expect(event(events[0]!.id).location).toBe('WEB会議');
  });
});
