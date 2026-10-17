import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-digest-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.CHATWORK_API_TOKEN = 'cw-token';

const { openTestDatabase, closeDatabase } = await import('../db/index.js');
const { setSetting, getSetting } = await import('../services/settings.js');
const { morningDigestEnabled } = await import('../jobs/digest.js');
const { JOBS } = await import('../jobs/index.js');
const { createApp } = await import('../index.js');
const { setPassword } = await import('../auth/index.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

describe('朝のダイジェストのオン・オフ', () => {
  it('既定はオン。設定でオフにすると自動では送らない（ジョブも止まって見える）', () => {
    const job = JOBS.find((j) => j.name === 'morningDigest')!;
    expect(getSetting('morning_digest_enabled')).toBe('1');
    expect(morningDigestEnabled()).toBe(true);
    expect(job.enabled()).toBe(true);
    setSetting('morning_digest_enabled', '0');
    expect(morningDigestEnabled()).toBe(false);
    expect(job.enabled()).toBe(false);
    setSetting('morning_digest_enabled', '1');
    expect(job.enabled()).toBe(true);
  });

  it('設定画面から切り替えられる', async () => {
    await setPassword('pw-digest-1');
    const app = createApp();
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw-digest-1' }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const put = await app.request('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ morning_digest_enabled: '0' }) });
    expect(put.status).toBe(200);
    expect(morningDigestEnabled()).toBe(false);
    const got = (await (await app.request('/api/settings', { headers: { Cookie: cookie } })).json()) as Record<string, string>;
    expect(got.morning_digest_enabled).toBe('0');
  });
});
