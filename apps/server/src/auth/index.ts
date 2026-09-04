import bcrypt from 'bcryptjs';
import { eq, lt } from 'drizzle-orm';
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

export function verifyPassword(pw: string): boolean {
  const hash = getSetting('password_hash');
  if (!hash) return false;
  return bcrypt.compareSync(pw, hash);
}

export function setPassword(pw: string) {
  setSetting('password_hash', bcrypt.hashSync(pw, 10));
}

export function createSession(c: Context) {
  const id = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  db().insert(schema.sessions).values({ id, expiresAt: expires.toISOString() }).run();
  db().delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date().toISOString())).run();
  const secure = env().PUBLIC_BASE_URL.startsWith('https://');
  setCookie(c, COOKIE, id, { httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge: SESSION_DAYS * 86400 });
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
