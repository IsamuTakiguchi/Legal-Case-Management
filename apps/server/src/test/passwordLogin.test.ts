import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-pwlogin-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase } = await import('../db/index.js');
const { createApp } = await import('../index.js');
const { setPassword } = await import('../auth/index.js');
const { setSetting } = await import('../services/settings.js');
const { resetEnvCache } = await import('../config.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

const json = { 'content-type': 'application/json' };

describe('パスワードでのログインを止める', () => {
  it('Google ログインの準備が無ければ止められず、止めるとパスワードでは入れない。非常口の環境変数で戻せる', async () => {
    const app = createApp();
    setPassword('pw-login-test');
    const login = () => app.request('/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ password: 'pw-login-test' }) });
    const first = await login();
    expect(first.status).toBe(200);
    const cookie = first.headers.get('set-cookie')?.split(';')[0] ?? '';
    const toggle = (disabled: boolean) => app.request('/api/auth/password-login', { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ disabled }) });
    const me = async () => (await (await app.request('/api/auth/me')).json()) as { passwordLogin: boolean };

    // ログインしていなければ切り替えられない
    expect((await app.request('/api/auth/password-login', { method: 'POST', headers: json, body: JSON.stringify({ disabled: true }) })).status).toBe(401);
    // Google 未設定では止められない（締め出し防止）
    expect((await toggle(true)).status).toBe(400);
    expect((await login()).status).toBe(200);

    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    resetEnvCache();
    // 許可するアドレスが無ければ止められない
    expect((await toggle(true)).status).toBe(400);
    setSetting('login_google_emails', 'me@example.com');
    expect((await toggle(true)).status).toBe(200);

    expect((await login()).status).toBe(403);
    expect((await me()).passwordLogin).toBe(false);
    // 止める前のログインはそのまま使える
    expect((await app.request('/api/auth/password-login', { headers: { cookie } })).status).toBe(200);

    // 非常口
    process.env.ALLOW_PASSWORD_LOGIN = 'true';
    resetEnvCache();
    expect((await login()).status).toBe(200);
    expect((await me()).passwordLogin).toBe(true);
    delete process.env.ALLOW_PASSWORD_LOGIN;
    resetEnvCache();
    expect((await login()).status).toBe(403);

    // 再開
    expect((await toggle(false)).status).toBe(200);
    expect((await login()).status).toBe(200);
  });
});
