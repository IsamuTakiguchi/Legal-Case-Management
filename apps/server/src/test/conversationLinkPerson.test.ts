import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-linkperson-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { createApp } = await import('../index.js');
const { setPassword } = await import('../auth/index.js');
const { upsertAlert } = await import('../services/alerts.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

async function client() {
  const app = createApp();
  setPassword('link-test');
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'link-test' }) });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  return {
    post: (url: string, body: unknown) => app.request(`/api${url}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    get: (url: string) => app.request(`/api${url}`, { headers: { cookie } }),
  };
}

describe('会話を依頼者のご家族・窓口として紐付ける', () => {
  it('LINE の個人トークをご家族として紐付けると、依頼者に紐付き、その LINE はご家族の連絡先として覚える', async () => {
    const api = await client();
    const c = db().insert(schema.clients).values({ name: '山田 太郎' }).returning().get();
    const conv = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'U-family-1', counterpartName: '山田 一郎' }).returning().get();
    const res = await api.post(`/conversations/${conv.id}/link`, { clientId: c.id, newPerson: { name: '山田 一郎', title: '長男' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { person: { id: number; name: string; title: string } };
    expect(body.person).toMatchObject({ name: '山田 一郎', title: '長男' });
    const after = db().select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)).get()!;
    expect(after).toMatchObject({ clientId: c.id, clientPersonId: body.person.id });
    // 本人の LINE としては覚えない（ご家族の LINE として覚える）
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, c.id)).get()!.lineUserId).toBeNull();
    expect(db().select().from(schema.clientPersons).where(eq(schema.clientPersons.id, body.person.id)).get()!.lineUserId).toBe('U-family-1');
  });

  it('LINE のグループを、登録済みの窓口とのグループとして紐付けられる（グループの ID は誰の連絡先にもしない）', async () => {
    const api = await client();
    const c = db().insert(schema.clients).values({ name: '佐藤 花子' }).returning().get();
    const p = db().insert(schema.clientPersons).values({ clientId: c.id, name: '佐藤 次郎', title: '次男' }).returning().get();
    const conv = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'C-group-1', counterpartName: '佐藤家' }).returning().get();
    const res = await api.post(`/conversations/${conv.id}/link`, { clientId: c.id, personId: p.id });
    expect(res.status).toBe(200);
    expect(db().select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)).get()).toMatchObject({ clientId: c.id, clientPersonId: p.id });
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, c.id)).get()!.lineUserId).toBeNull();
    expect(db().select().from(schema.clientPersons).where(eq(schema.clientPersons.id, p.id)).get()!.lineUserId).toBeNull();
  });

  it('ほかの依頼者の窓口を指定したら、紐付けずに断る', async () => {
    const api = await client();
    const a = db().insert(schema.clients).values({ name: '高橋 健' }).returning().get();
    const b = db().insert(schema.clients).values({ name: '伊藤 誠' }).returning().get();
    const p = db().insert(schema.clientPersons).values({ clientId: b.id, name: '伊藤 恵' }).returning().get();
    const conv = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'U-other-1' }).returning().get();
    const res = await api.post(`/conversations/${conv.id}/link`, { clientId: a.id, personId: p.id });
    expect(res.status).toBe(400);
    expect(db().select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)).get()!.clientId).toBeNull();
  });

  it('未紐付けの警告には、LINE のグループかどうかを付けて返す', async () => {
    const api = await client();
    const group = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'C-group-2', counterpartName: '中村家' }).returning().get();
    const solo = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'U-solo-2', counterpartName: '中村 修' }).returning().get();
    for (const conv of [group, solo]) upsertAlert({ type: 'unlinked_contact', dedupeKey: `unlinked:line:${conv.externalThreadId}`, title: 'LINE', body: '', payload: { conversationId: conv.id, channel: 'line' } });
    const alerts = (await (await api.get('/alerts?type=unlinked_contact')).json()) as { payload: { conversationId: number; lineGroup?: boolean } }[];
    expect(alerts.find((a) => a.payload.conversationId === group.id)?.payload.lineGroup).toBe(true);
    expect(alerts.find((a) => a.payload.conversationId === solo.id)?.payload.lineGroup).toBe(false);
  });
});
