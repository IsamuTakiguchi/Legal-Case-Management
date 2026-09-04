import { Hono } from 'hono';
import { z } from 'zod';
import { createSession, destroySession, isAuthenticated, verifyPassword, setPassword, requireAuth } from '../auth/index.js';
import { googleAuthUrl, handleGoogleCallback, disconnectGoogle } from '../integrations/google.js';
import { msAuthUrl, handleMsCallback, disconnectMs } from '../integrations/onedrive.js';
import { randomToken } from '../crypto.js';
import { getCookie, setCookie } from 'hono/cookie';
import { logger } from '../logger.js';

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
    return c.redirect('/settings?connected=google');
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
    return c.redirect('/settings?connected=microsoft');
  } catch (err) {
    logger.error({ err }, 'Microsoft 接続失敗');
    return c.text(`OneDrive 接続に失敗しました: ${String(err)}`, 500);
  }
});

authRoutes.post('/microsoft/disconnect', requireAuth, (c) => {
  disconnectMs();
  return c.json({ ok: true });
});
