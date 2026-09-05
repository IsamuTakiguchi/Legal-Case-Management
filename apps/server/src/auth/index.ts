import bcrypt from 'bcryptjs';
import { eq, lt, ne } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { db, schema } from '../db/index.js';
import { env } from '../config.js';
import { randomToken } from '../crypto.js';
import { getSetting, setSetting } from '../services/settings.js';

const COOKIE = 'lcm_session';
const SESSION_DAYS = 30;

/** 初回起動時に APP_PASSWORD をハッシュ化して保存。以降は設定画面で変更可 */
export function ensurePasswordHash() {
  const existing = getSetting('password_hash');
  if (existing) return;
  const pw = env().APP_PASSWORD;
  if (!pw) return;
  setSetting('password_hash', bcrypt.hashSync(pw, 10));
}

export async function verifyPassword(pw: string): Promise<boolean> {
  const hash = getSetting('password_hash');
  if (!hash) return false;
  return bcrypt.compare(pw, hash);
}

/** パスワード変更。変更したセッション以外はすべて失効させる */
export function setPassword(pw: string, keepSessionId?: string | null) {
  setSetting('password_hash', bcrypt.hashSync(pw, 10));
  if (keepSessionId) db().delete(schema.sessions).where(ne(schema.sessions.id, keepSessionId)).run();
  else db().delete(schema.sessions).run();
}

/** Cookie の Secure 属性。本番は常に付ける（公開 URL の設定値に依存させない） */
export function cookieSecure(): boolean {
  return process.env.NODE_ENV === 'production' || env().PUBLIC_BASE_URL.startsWith('https://');
}

export function currentSessionId(c: Context): string | null {
  return getCookie(c, COOKIE) ?? null;
}

export function createSession(c: Context) {
  const id = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  db().insert(schema.sessions).values({ id, expiresAt: expires.toISOString() }).run();
  db().delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date().toISOString())).run();
  setCookie(c, COOKIE, id, { httpOnly: true, sameSite: 'Lax', secure: cookieSecure(), path: '/', maxAge: SESSION_DAYS * 86400 });
}

// ---- ログインの試行制限（IP ごと） ----
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const failures = new Map<string, { count: number; until: number }>();

export function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return c.req.header('x-real-ip') ?? 'unknown';
}

/** ロック中なら残り秒数を返す */
export function loginLockedFor(ip: string): number {
  const f = failures.get(ip);
  if (!f) return 0;
  if (f.count < MAX_FAILURES) return 0;
  const left = f.until - Date.now();
  if (left <= 0) {
    failures.delete(ip);
    return 0;
  }
  return Math.ceil(left / 1000);
}

export function recordLoginFailure(ip: string) {
  const f = failures.get(ip) ?? { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILURES) f.until = Date.now() + LOCK_MS;
  failures.set(ip, f);
  if (failures.size > 10_000) failures.clear();
}

export function clearLoginFailures(ip: string) {
  failures.delete(ip);
}

export function destroySession(c: Context) {
  const id = getCookie(c, COOKIE);
  if (id) db().delete(schema.sessions).where(eq(schema.sessions.id, id)).run();
  deleteCookie(c, COOKIE, { path: '/' });
}

export function isAuthenticated(c: Context): boolean {
  const id = getCookie(c, COOKIE);
  if (!id) return false;
  const row = db().select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
  if (!row) return false;
  if (row.expiresAt < new Date().toISOString()) return false;
  return true;
}

export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (!isAuthenticated(c)) return c.json({ error: 'unauthorized' }, 401);
  await next();
};
