import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-recordsent-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { createApp } = await import('../index.js');
const { setPassword } = await import('../auth/index.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

describe('LINE アプリで送った分の記録', () => {
  it('自分の送信として会話に残し、未返信を消す。LINE には送らない。送った後に返事があれば未返信は残す', async () => {
    const app = createApp();
    setPassword('record-test');
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'record-test' }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const call = (method: string, url: string, body?: unknown) => app.request(`/api${url}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });

    const conv = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'Uabc', counterpartName: '山田', lastMessageAt: '2026-09-01T01:00:00.000Z', needsReply: true, unread: 1 }).returning().get();
    db().insert(schema.messages).values({ conversationId: conv.id, channel: 'line', externalId: 'in1', direction: 'in', senderName: '山田', body: '資料を送りました', sentAt: '2026-09-01T01:00:00.000Z' }).run();

    const r = await call('POST', `/conversations/${conv.id}/record-sent`, { text: '  受け取りました。確認します。 ', sentAt: '2026-09-01T02:00:00.000Z' });
    expect(r.status).toBe(200);
    const after = await (await call('GET', `/conversations/${conv.id}`)).json();
    const last = after.messages.at(-1);
    expect(last).toMatchObject({ direction: 'out', body: '受け取りました。確認します。', manual: true, sentAt: '2026-09-01T02:00:00.000Z' });
    expect(after.needsReply).toBe(false);
    expect(after.unread).toBe(0);
    // 文体の見本にもなる
    expect(db().select().from(schema.styleSamples).all().some((x) => x.text === '受け取りました。確認します。')).toBe(true);

    // 相手から新しい返事が来たあとに、それより前に送った分を記録しても未返信は消さない
    db().insert(schema.messages).values({ conversationId: conv.id, channel: 'line', externalId: 'in2', direction: 'in', senderName: '山田', body: 'よろしくお願いします', sentAt: '2026-09-01T03:00:00.000Z' }).run();
    db().update(schema.conversations).set({ needsReply: true, lastMessageAt: '2026-09-01T03:00:00.000Z' }).where(eq(schema.conversations.id, conv.id)).run();
    await call('POST', `/conversations/${conv.id}/record-sent`, { text: '前に送った分', sentAt: '2026-09-01T02:30:00.000Z' });
    expect(db().select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)).get()!.needsReply).toBe(true);

    // 空の本文・未来の日時は断る
    expect((await call('POST', `/conversations/${conv.id}/record-sent`, { text: '   ' })).ok).toBe(false);
    expect((await call('POST', `/conversations/${conv.id}/record-sent`, { text: 'x', sentAt: '2099-01-01T00:00:00.000Z' })).ok).toBe(false);
  });
});
