import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-casecounts-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { createApp } = await import('../index.js');
const { setPassword } = await import('../auth/index.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

describe('ダッシュボードの事件の件数', () => {
  it('相談・進行事件・残務処理・終了事件をそれぞれ数え、無い区分は 0 にする', async () => {
    const app = createApp();
    setPassword('counts-test');
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'counts-test' }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const dash = async () => (await (await app.request('/api/dashboard', { headers: { cookie } })).json()).caseCounts;

    expect(await dash()).toEqual({ consultation: 0, active: 0, wrapup: 0, closed: 0 });

    const client = db().insert(schema.clients).values({ name: '件数 太郎' }).returning().get();
    const add = (status: string, n: number) => {
      for (let i = 0; i < n; i++) db().insert(schema.cases).values({ clientId: client.id, title: `${status}-${i}`, status }).run();
    };
    add('consultation', 2);
    add('active', 5);
    add('wrapup', 1);
    add('closed', 3);
    expect(await dash()).toEqual({ consultation: 2, active: 5, wrapup: 1, closed: 3 });
  });
});
