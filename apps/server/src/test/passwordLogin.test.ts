import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-pwlogin-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

// Google とは通信しない（ログインした人のアドレスだけ返す）
vi.mock('../integrations/google.js', async (orig) => ({
  ...(await orig<typeof import('../integrations/google.js')>()),
  googleLoginUrl: (state: string) => `https://accounts.google.com/o/oauth2/auth?state=${state}`,
  verifyGoogleLogin: vi.fn(async () => 'isamu.lawyer@gmail.com'),
}));

const { openTestDatabase, closeDatabase } = await import('../db/index.js');
const { createApp } = await import('../index.js');
const { setPassword, syncPasswordFromEnv, verifyPassword } = await import('../auth/index.js');
const { getSetting, setSetting } = await import('../services/settings.js');
const { resetEnvCache } = await import('../config.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

const json = { 'content-type': 'application/json' };

describe('ログインは Google アカウントだけ', () => {
  it('Google ログインの準備ができたらパスワードでは入れない。非常口の環境変数のときだけ入れる', async () => {
    const app = createApp();
    setPassword('pw-login-test');
    const login = () => app.request('/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ password: 'pw-login-test' }) });
    const me = async () => (await (await app.request('/api/auth/me')).json()) as { googleLogin: boolean; passwordLogin: boolean };

    // 初めて立ち上げたとき（Google 未設定）は、初期設定のためにパスワードで入れる
    expect(await me()).toMatchObject({ googleLogin: false, passwordLogin: true });
    const first = await login();
    expect(first.status).toBe(200);
    const cookie = first.headers.get('set-cookie')?.split(';')[0] ?? '';

    // クライアント ID だけでは、まだ誰も Google で入れないのでパスワードのまま
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    resetEnvCache();
    expect(await me()).toMatchObject({ googleLogin: false, passwordLogin: true });

    // 許可するアドレスがあれば Google だけ。パスワードは断る
    setSetting('login_google_emails', 'isamu.lawyer@gmail.com');
    expect(await me()).toMatchObject({ googleLogin: true, passwordLogin: false });
    const refused = await login();
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toContain('Google アカウントだけ');
    // 設定画面の状態表示（ログイン済みのセッションはそのまま使える）
    expect(await (await app.request('/api/auth/login-status', { headers: { cookie } })).json()).toMatchObject({ googleLogin: true, passwordLogin: false, emergencyOverride: false, allowedEmails: ['isamu.lawyer@gmail.com'] });
    // パスワードの変更・切り替えの API は無い
    expect((await app.request('/api/auth/password', { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ current: 'pw-login-test', next: 'new-password' }) })).status).toBe(404);
    expect((await app.request('/api/auth/password-login', { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ disabled: false }) })).status).toBe(404);

    // 非常口（Google で入れなくなったとき）
    process.env.ALLOW_PASSWORD_LOGIN = 'true';
    resetEnvCache();
    expect((await login()).status).toBe(200);
    expect((await me()).passwordLogin).toBe(true);
    delete process.env.ALLOW_PASSWORD_LOGIN;
    resetEnvCache();
    expect((await login()).status).toBe(403);
  });

  it('Google でログインすると、そのアドレスを許可するアドレスとして書き留める（Gmail の接続を外してもパスワードに戻らない）', async () => {
    const app = createApp();
    setSetting('login_google_emails', '');
    // 許可するアドレスが無いと、ログインを始められない
    expect((await app.request('/api/auth/google/login/start')).headers.get('location')).toBe('/login?error=no_allowed_email');
    setSetting('login_google_emails', 'Isamu.Lawyer@gmail.com');
    const start = await app.request('/api/auth/google/login/start');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const stateCookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const cb = await app.request(`/api/auth/google/callback?code=abc&state=${state}`, { headers: { cookie: stateCookie } });
    expect(cb.headers.get('location')).toBe('/');
    expect(cb.headers.get('set-cookie')).toContain('lcm_session=');

    // 許可するアドレスが空のとき（Gmail に接続したアカウントで入った）は、そのアドレスを書き留める
    setSetting('login_google_emails', '');
    const { db, schema } = await import('../db/index.js');
    db().insert(schema.oauthTokens).values({ provider: 'google', account: 'isamu.lawyer@gmail.com', data: 'x' }).run();
    const s2 = await app.request('/api/auth/google/login/start');
    const st2 = new URL(s2.headers.get('location')!).searchParams.get('state')!;
    await app.request(`/api/auth/google/callback?code=abc&state=${st2}`, { headers: { cookie: s2.headers.get('set-cookie')!.split(';')[0]! } });
    expect(getSetting('login_google_emails')).toBe('isamu.lawyer@gmail.com');
  });

  it('パスワードは起動時に APP_PASSWORD に合わせる。消してあれば保存しているパスワードも消す', async () => {
    setPassword('old-password');
    process.env.APP_PASSWORD = 'from-env-password';
    resetEnvCache();
    syncPasswordFromEnv();
    expect(await verifyPassword('from-env-password')).toBe(true);
    expect(await verifyPassword('old-password')).toBe(false);
    delete process.env.APP_PASSWORD;
    resetEnvCache();
    syncPasswordFromEnv();
    expect(await verifyPassword('from-env-password')).toBe(false);
    expect(getSetting('password_hash')).toBe('');
  });
});
