import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-provisional-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { createApp } = await import('../index.js');
const { setPassword } = await import('../auth/index.js');
const { provisionalClientName } = await import('@lcm/shared');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

async function login() {
  const app = createApp();
  setPassword('prov-test');
  const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'prov-test' }) });
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  return (method: string, url: string, body?: unknown) => app.request(`/api${url}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe('当事者の氏名が分からない相談', () => {
  it('仮の呼び名は、入力が無ければ紹介者から作る', () => {
    expect(provisionalClientName('', '田中税理士')).toBe('（氏名未確認）田中税理士さん紹介の相談者');
    expect(provisionalClientName(null, '佐藤様')).toBe('（氏名未確認）佐藤さん紹介の相談者');
    expect(provisionalClientName('  鈴木社長の従業員  ', '鈴木')).toBe('鈴木社長の従業員');
    expect(provisionalClientName(null, null)).toBe('（氏名未確認）相談者');
  });

  it('氏名未確認の依頼者で事件を記録し、氏名が分かったら確定できる', async () => {
    const call = await login();
    const r = await call('POST', '/cases', { title: '相続の相談', status: 'consultation', caseType: 'general_civil', referrer: '田中税理士', provisionalClient: { label: null } });
    expect(r.status).toBe(200);
    const kase = await r.json();
    expect(kase).toMatchObject({ status: 'consultation', referrer: '田中税理士' });
    const client = db().select().from(schema.clients).where(eq(schema.clients.id, kase.clientId)).get()!;
    expect(client).toMatchObject({ name: '（氏名未確認）田中税理士さん紹介の相談者', provisional: true, notes: '紹介者: 田中税理士' });
    // 一覧にも「氏名未確認」が分かる
    const list = await (await call('GET', '/cases')).json();
    expect(list.find((x: { id: number }) => x.id === kase.id).clientProvisional).toBe(true);

    // 名前以外を直しても氏名未確認のまま
    await call('PUT', `/clients/${client.id}`, { phones: ['090-0000-0000'] });
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, client.id)).get()!.provisional).toBe(true);
    // 氏名を入れると確定
    await call('PUT', `/clients/${client.id}`, { name: '山田 花子' });
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, client.id)).get()).toMatchObject({ name: '山田 花子', provisional: false });
    // 事件の紹介者も後から直せる
    expect((await (await call('PUT', `/cases/${kase.id}`, { referrer: '田中税理士（〇〇会計）' })).json()).referrer).toBe('田中税理士（〇〇会計）');
  });

  it('登録済みの依頼者だったら、その依頼者にまとめると事件が引き継がれる', async () => {
    const call = await login();
    const existing = db().insert(schema.clients).values({ name: '既存 一郎' }).returning().get();
    const kase = await (await call('POST', '/cases', { title: '債務整理の相談', status: 'consultation', caseType: 'general_civil', referrer: '佐藤', provisionalClient: { label: '佐藤さんの知人' } })).json();
    const tmpClient = kase.clientId;
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, tmpClient)).get()!.name).toBe('佐藤さんの知人');
    const m = await call('POST', '/clients/merge', { keepId: existing.id, mergeIds: [tmpClient] });
    expect(m.status).toBe(200);
    expect(db().select().from(schema.cases).where(eq(schema.cases.id, kase.id)).get()!.clientId).toBe(existing.id);
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, tmpClient)).get()).toBeUndefined();
  });

  it('依頼者も氏名未確認の指定も無ければ断る', async () => {
    const call = await login();
    expect((await call('POST', '/cases', { title: 'x', status: 'consultation' })).status).toBe(400);
  });
});
