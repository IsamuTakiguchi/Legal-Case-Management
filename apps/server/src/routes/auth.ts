import { Hono } from 'hono';
import { z } from 'zod';
import { createSession, destroySession, isAuthenticated, verifyPassword, setPassword, requireAuth } from '../auth/index.js';
import { googleAuthUrl, handleGoogleCallback, disconnectGoogle } from '../integrations/google.js';
import { msAuthUrl, handleMsCallback, disconnectMs, startDeviceCodeFlow, deviceCodeStatus } from '../integrations/onedrive.js';
import { saveCredentials } from '../services/credentials.js';
import { resetIntegrationCaches } from '../integrations/reset.js';
import { randomToken } from '../crypto.js';
import { getCookie, setCookie } from 'hono/cookie';
import { logger } from '../logger.js';
import { runOnboardingAfterGoogle, runOnboardingAfterMicrosoft } from '../services/onboarding.js';

export const authRoutes = new Hono();

authRoutes.get('/me', (c) => c.json({ authenticated: isAuthenticated(c) }));

authRoutes.post('/login', async (c) => {
  const body = z.object({ password: z.string() }).parse(await c.req.json());
  if (!verifyPassword(body.password)) return c.json({ error: 'パスワードが違います' }, 401);
  createSession(c);
  return c.json({ ok: true });
});

authRoutes.post('/logout', (c) => {
  destroySession(c);
  return c.json({ ok: true });
});

authRoutes.post('/password', requireAuth, async (c) => {
  const body = z.object({ current: z.string(), next: z.string().min(8) }).parse(await c.req.json());
  if (!verifyPassword(body.current)) return c.json({ error: '現在のパスワードが違います' }, 400);
  setPassword(body.next);
  return c.json({ ok: true });
});

// ---- OAuth (Google / Microsoft) ----
function stateCookie(c: Parameters<typeof getCookie>[0], name: string): string {
  const s = randomToken(16);
  setCookie(c, name, s, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 600 });
  return s;
}

authRoutes.get('/google/start', requireAuth, (c) => {
  const state = stateCookie(c, 'oauth_state_google');
  return c.redirect(googleAuthUrl(state));
});

authRoutes.get('/google/callback', async (c) => {
  const state = c.req.query('state');
  const code = c.req.query('code');
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
