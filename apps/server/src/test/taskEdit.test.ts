import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-taskedit-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { createApp } = await import('../index.js');
const { setPassword } = await import('../auth/index.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

async function session() {
  const app = createApp();
  setPassword('task-edit-test');
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'task-edit-test' }) });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  const put = (id: number, body: unknown) => app.request(`/api/tasks/${id}`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { put };
}

describe('タスクの中身を直す', () => {
  it('タスク名とメモだけを書き換え、状態・期限・待ち開始はそのまま', async () => {
    const due = '2026-10-10T09:00:00.000Z';
    const t = db()
      .insert(schema.tasks)
      .values({ title: '資料の依頼', note: '古いメモ', status: 'waiting_client', followUpAt: due, waitingSince: '2026-09-20T00:00:00.000Z' })
      .returning()
      .get();
    const { put } = await session();
    const res = await put(t.id, { title: '  源泉徴収票と給与明細の依頼  ', note: '令和6年分と直近2か月分\n届いたら破産申立書に反映' });
    expect(res.status).toBe(200);
    const after = db().select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()!;
    expect(after.title).toBe('源泉徴収票と給与明細の依頼');
    expect(after.note).toBe('令和6年分と直近2か月分\n届いたら破産申立書に反映');
    expect(after.status).toBe('waiting_client');
    expect(after.followUpAt).toBe(due);
    expect(after.waitingSince).toBe('2026-09-20T00:00:00.000Z');
  });

  it('メモは空にできる', async () => {
    const t = db().insert(schema.tasks).values({ title: '電話する', note: '消すメモ', status: 'open' }).returning().get();
    const { put } = await session();
    expect((await put(t.id, { note: null })).status).toBe(200);
    expect(db().select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()!.note).toBeNull();
  });

  it('タスク名を空（空白だけ）にはできない', async () => {
    const t = db().insert(schema.tasks).values({ title: '残すタスク', status: 'open' }).returning().get();
    const { put } = await session();
    expect((await put(t.id, { title: '   ' })).status).toBe(400);
    expect(db().select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()!.title).toBe('残すタスク');
  });
});
