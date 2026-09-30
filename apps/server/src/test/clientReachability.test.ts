import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-reach-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
// Chatwork だけ接続済み。Gmail・LINE は未接続。AI は使わない（下書きはテンプレートで出る）
process.env.CHATWORK_API_TOKEN = 'test-token';

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { createApp } = await import('../index.js');
const { setPassword } = await import('../auth/index.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

describe('依頼者に連絡先が無いときの期日連絡', () => {
  it('送れない理由と依頼者を返し、その場で連絡先を登録すれば下書きまで進める', async () => {
    const app = createApp();
    setPassword('reach-test');
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'reach-test' }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const call = (method: string, url: string, body?: unknown) => app.request(`/api${url}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });

    const client = db().insert(schema.clients).values({ name: '連絡 なし子', emails: [] }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '連絡 事件' }).returning().get();
    const note = db()
      .insert(schema.caseNotes)
      .values({ caseId: kase.id, clientId: client.id, kind: 'court', occurredAt: new Date().toISOString(), rawText: '第1回弁論', gist: '第1回弁論', decisions: [], nextActions: [], theirSaid: [], ourSaid: [], attachments: [] })
      .returning()
      .get();

    const r1 = await call('POST', `/case-notes/${note.id}/hearing-notice`, {});
    expect(r1.status).toBe(409);
    expect(await r1.json()).toMatchObject({ code: 'client_unreachable', clientId: client.id, error: expect.stringContaining('連絡 なし子さんの連絡先') });

    // 何が足りないか: 連絡先は無し、接続済みは Chatwork だけ
    const reach = await (await call('GET', `/clients/${client.id}/reachability`)).json();
    expect(reach).toMatchObject({ clientId: client.id, emails: [], lineUserId: null, chatworkRoomId: null, configured: { gmail: false, line: false, chatwork: true }, channels: [] });

    // メールを入れても Gmail が未接続なので、まだ送れない
    await call('PUT', `/clients/${client.id}`, { emails: ['nashiko@example.com'] });
    expect((await call('POST', `/case-notes/${note.id}/hearing-notice`, {})).status).toBe(409);

    // 接続済みの Chatwork のルームを入れれば下書きができる（登録済みのメールは消えない）
    await call('PUT', `/clients/${client.id}`, { chatworkRoomId: 555 });
    const r2 = await call('POST', `/case-notes/${note.id}/hearing-notice`, {});
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ channel: 'chatwork', clientId: client.id });
    expect(db().select().from(schema.clients).all().find((c) => c.id === client.id)!.emails).toEqual(['nashiko@example.com']);
  });
});
