import { Hono } from 'hono';
import { z } from 'zod';
import { createSession, destroySession, isAuthenticated, verifyPassword, setPassword, requireAuth, cookieSecure, currentSessionId, clientIp, loginLockedFor, recordLoginFailure, clearLoginFailures } from '../auth/index.js';
import { googleAuthUrl, handleGoogleCallback, disconnectGoogle, googleLoginUrl, verifyGoogleLogin, googleAccount } from '../integrations/google.js';
import { isConfigured } from '../config.js';
import { getSetting } from '../services/settings.js';
import { msAuthUrl, handleMsCallback, disconnectMs, startDeviceCodeFlow, deviceCodeStatus } from '../integrations/onedrive.js';
import { saveCredentials } from '../services/credentials.js';
import { resetIntegrationCaches } from '../integrations/reset.js';
import { randomToken } from '../crypto.js';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { logger } from '../logger.js';
import { runOnboardingAfterGoogle, runOnboardingAfterMicrosoft } from '../services/onboarding.js';

export const authRoutes = new Hono();

authRoutes.get('/me', (c) => c.json({ authenticated: isAuthenticated(c), googleLogin: isConfigured('google') }));

/** Google でログインできるメールアドレス一覧（設定が空なら「Google に接続」したアカウント） */
export function loginAllowedEmails(): string[] {
  const configured = getSetting('login_google_emails')
    .split(/[\s,、]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (configured.length) return configured;
  const connected = googleAccount();
  return connected ? [connected.toLowerCase()] : [];
}

authRoutes.get('/google/login/start', (c) => {
  if (!isConfigured('google')) return c.redirect('/login?error=google_not_configured');
  if (loginAllowedEmails().length === 0) return c.redirect('/login?error=no_allowed_email');
  const state = stateCookie(c, 'oauth_login_google');
  return c.redirect(googleLoginUrl(state));
});

authRoutes.post('/login', async (c) => {
  const ip = clientIp(c);
  const locked = loginLockedFor(ip);
  if (locked > 0) return c.json({ error: `試行回数が多すぎます。${Math.ceil(locked / 60)} 分後に再度お試しください` }, 429);
  const body = z.object({ password: z.string().max(256) }).parse(await c.req.json());
  if (!(await verifyPassword(body.password))) {
    recordLoginFailure(ip);
    logger.warn({ ip }, 'ログイン失敗');
    return c.json({ error: 'パスワードが違います' }, 401);
  }
  clearLoginFailures(ip);
  createSession(c);
  return c.json({ ok: true });
});

authRoutes.post('/logout', (c) => {
  destroySession(c);
  return c.json({ ok: true });
});

authRoutes.post('/password', requireAuth, async (c) => {
  const body = z.object({ current: z.string().max(256), next: z.string().min(8).max(256) }).parse(await c.req.json());
  if (!(await verifyPassword(body.current))) return c.json({ error: '現在のパスワードが違います' }, 400);
  setPassword(body.next, currentSessionId(c));
  return c.json({ ok: true });
});

// ---- OAuth (Google / Microsoft) ----
function stateCookie(c: Parameters<typeof getCookie>[0], name: string): string {
  const s = randomToken(16);
  setCookie(c, name, s, { httpOnly: true, sameSite: 'Lax', secure: cookieSecure(), path: '/', maxAge: 600 });
  return s;
}

authRoutes.get('/google/start', requireAuth, (c) => {
  const state = stateCookie(c, 'oauth_state_google');
  return c.redirect(googleAuthUrl(state));
});

authRoutes.get('/google/callback', async (c) => {
  const state = c.req.query('state');
  const code = c.req.query('code');
  // ---- ログイン用（同じリダイレクト URI を共有し、state の Cookie で区別） ----
  const loginState = getCookie(c, 'oauth_login_google');
  if (code && state && loginState && state === loginState) {
    deleteCookie(c, 'oauth_login_google', { path: '/' });
    const ip = clientIp(c);
    if (loginLockedFor(ip) > 0) return c.redirect('/login?error=locked');
    try {
      const email = await verifyGoogleLogin(code);
      if (!email || !loginAllowedEmails().includes(email)) {
        recordLoginFailure(ip);
        logger.warn({ ip, email }, 'Google ログイン拒否（許可されていないアカウント）');
        return c.redirect(`/login?error=not_allowed&email=${encodeURIComponent(email ?? '')}`);
      }
      clearLoginFailures(ip);
      createSession(c);
      logger.info({ email }, 'Google ログイン');
      return c.redirect('/');
    } catch (err) {
      logger.error({ err }, 'Google ログイン失敗');
      return c.redirect('/login?error=google_failed');
    }
  }
  // ---- Gmail・カレンダー接続用 ----
  if (!code || !state || state !== getCookie(c, 'oauth_state_google')) return c.text('不正なリクエストです', 400);
  if (!isAuthenticated(c)) return c.text('ログインしてから再度お試しください', 401);
  try {
    const email = await handleGoogleCallback(code);
    logger.info({ email }, 'Google 接続完了');
    setImmediate(() => runOnboardingAfterGoogle());
    return c.redirect('/setup?connected=google');
  } catch (err) {
    logger.error({ err }, 'Google 接続失敗');
    return c.text(`Google 接続に失敗しました: ${String(err)}`, 500);
  }
});

authRoutes.post('/google/disconnect', requireAuth, (c) => {
  disconnectGoogle();
  return c.json({ ok: true });
});

authRoutes.get('/microsoft/start', requireAuth, async (c) => {
  const state = stateCookie(c, 'oauth_state_ms');
  return c.redirect(await msAuthUrl(state));
});

authRoutes.get('/microsoft/callback', async (c) => {
  const state = c.req.query('state');
  const code = c.req.query('code');
  if (!code || !state || state !== getCookie(c, 'oauth_state_ms')) return c.text('不正なリクエストです', 400);
  if (!isAuthenticated(c)) return c.text('ログインしてから再度お試しください', 401);
  try {
    const user = await handleMsCallback(code);
    logger.info({ user }, 'Microsoft 接続完了');
    setImmediate(() => runOnboardingAfterMicrosoft());
    return c.redirect('/setup?connected=microsoft');
  } catch (err) {
    logger.error({ err }, 'Microsoft 接続失敗');
    return c.text(`OneDrive 接続に失敗しました: ${String(err)}`, 500);
  }
});

/** 簡易接続（アプリ登録なし・デバイスコード）: モードを device にして開始 */
authRoutes.post('/microsoft/device/start', requireAuth, async (c) => {
  saveCredentials({ MS_AUTH_MODE: 'device' });
  resetIntegrationCaches();
  const flow = await startDeviceCodeFlow();
  return c.json({ userCode: flow.userCode, verificationUri: flow.verificationUri, message: flow.message, status: flow.status });
});

let onboardedDevice = false;
authRoutes.get('/microsoft/device/status', requireAuth, (c) => {
  const f = deviceCodeStatus();
  if (f?.status === 'done' && !onboardedDevice) {
    onboardedDevice = true;
    setImmediate(() => runOnboardingAfterMicrosoft());
  }
  return c.json(f ? { status: f.status, error: f.error, account: f.account, userCode: f.userCode, verificationUri: f.verificationUri } : { status: 'none' });
});

/** 簡易接続をやめて自前のアプリ登録に戻す */
authRoutes.post('/microsoft/device/reset', requireAuth, (c) => {
  saveCredentials({ MS_AUTH_MODE: '' });
  disconnectMs();
  resetIntegrationCaches();
  return c.json({ ok: true });
});

authRoutes.post('/microsoft/disconnect', requireAuth, (c) => {
  disconnectMs();
  return c.json({ ok: true });
});
