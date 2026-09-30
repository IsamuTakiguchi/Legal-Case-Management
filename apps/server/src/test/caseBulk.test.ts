import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-casebulk-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { createApp } = await import('../index.js');
const { setPassword } = await import('../auth/index.js');
const { eq, inArray } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

describe('事件のまとめて変更', () => {
  it('チェックした事件の区分・担当事務局・事件類型をまとめて変え、同じ内容のものは数えない', async () => {
    const app = createApp();
    setPassword('bulk-test');
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'bulk-test' }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const bulk = (body: unknown) => app.request('/api/cases/bulk', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });

    const client = db().insert(schema.clients).values({ name: '一括 太郎' }).returning().get();
    const ids = ['consultation', 'active', 'active'].map((status, i) => db().insert(schema.cases).values({ clientId: client.id, title: `事件${i}`, status }).returning().get().id);
    const other = db().insert(schema.cases).values({ clientId: client.id, title: '対象外', status: 'active' }).returning().get();
    const rows = () => db().select().from(schema.cases).where(inArray(schema.cases.id, ids)).all();

    // 区分: 3 件のうち 1 件はすでに残務処理…ではないので 3 件とも変わる。2 回目は 0 件
    expect(await (await bulk({ ids, status: 'wrapup' })).json()).toEqual({ updated: 3 });
    expect(rows().map((r) => r.status)).toEqual(['wrapup', 'wrapup', 'wrapup']);
    expect(await (await bulk({ ids, status: 'wrapup' })).json()).toEqual({ updated: 0 });
    // チェックしていない事件は変わらない
    expect(db().select().from(schema.cases).where(eq(schema.cases.id, other.id)).get()!.status).toBe('active');

    // 担当事務局を付けて外す
    const staff = db().insert(schema.staffMembers).values({ name: '中村 事務' }).returning().get();
    expect(await (await bulk({ ids, staffId: staff.id })).json()).toEqual({ updated: 3 });
    expect(rows().every((r) => r.staffId === staff.id)).toBe(true);
    expect(await (await bulk({ ids: [ids[0]], staffId: null })).json()).toEqual({ updated: 1 });
    expect(rows()[0]!.staffId).toBeNull();

    // 事件類型
    expect(await (await bulk({ ids, caseType: 'traffic' })).json()).toEqual({ updated: 3 });
    expect(rows().every((r) => r.caseType === 'traffic')).toBe(true);

    // 無い類型・無い事務局・変更の指定なしは断る
    expect((await bulk({ ids, caseType: 'nope' })).ok).toBe(false);
    expect((await bulk({ ids, staffId: 99999 })).ok).toBe(false);
    expect((await bulk({ ids })).status).toBe(400);
    expect((await bulk({ ids: [], status: 'closed' })).status).toBe(400);
  });
});
