import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { env } from './config.js';

let keyCache: Buffer | null = null;
function key(): Buffer {
  if (!keyCache) keyCache = scryptSync(env().SESSION_SECRET, 'lcm-token-encryption', 32);
  return keyCache;
}

/** AES-256-GCM で文字列を暗号化（OAuth トークン保存用） */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decrypt(payload: string): string {
  const [v, ivB, tagB, encB] = payload.split('.');
  if (v !== 'v1' || !ivB || !tagB || !encB) throw new Error('暗号化データの形式が不正です');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encB, 'base64url')), decipher.final()]).toString('utf8');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function hmacSha256Base64(secret: Buffer | string, body: Buffer | string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
