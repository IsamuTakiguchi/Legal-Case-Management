import { google } from 'googleapis';
import type { Auth } from 'googleapis';
type OAuth2Client = Auth.OAuth2Client;
type Credentials = Auth.Credentials;
import { eq } from 'drizzle-orm';
import { env, isConfigured } from '../config.js';
import { db, schema } from '../db/index.js';
import { encrypt, decrypt } from '../crypto.js';
import { logger } from '../logger.js';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
];

export function googleRedirectUri(): string {
  return `${env().PUBLIC_BASE_URL.replace(/\/$/, '')}/api/auth/google/callback`;
}

function newClient(): OAuth2Client {
  if (!isConfigured('google')) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が設定されていません');
  const e = env();
  return new google.auth.OAuth2(e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET, googleRedirectUri());
}

export function googleAuthUrl(state: string): string {
  return newClient().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: GOOGLE_SCOPES, state });
}

/** ログイン用（メールアドレスの確認だけ。Gmail 等の権限は求めない） */
export function googleLoginUrl(state: string): string {
  return newClient().generateAuthUrl({ scope: ['openid', 'email'], prompt: 'select_account', state });
}

/** ログイン用コールバック: トークンは保存せず、確認済みメールアドレスだけ返す */
export async function verifyGoogleLogin(code: string): Promise<string | null> {
  const client = newClient();
  const { tokens } = await client.getToken(code);
  if (tokens.id_token) {
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: env().GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    if (p?.email && p.email_verified) return p.email.toLowerCase();
    return null;
  }
  client.setCredentials(tokens);
  const me = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
  return me.data.email && me.data.verified_email ? me.data.email.toLowerCase() : null;
}

export function loadGoogleTokens(): Credentials | null {
  const row = db().select().from(schema.oauthTokens).where(eq(schema.oauthTokens.provider, 'google')).get();
  if (!row) return null;
  return JSON.parse(decrypt(row.data)) as Credentials;
}

export function saveGoogleTokens(tokens: Credentials, account?: string | null) {
  const existing = loadGoogleTokens();
  const merged: Credentials = { ...existing, ...tokens };
  if (!merged.refresh_token && existing?.refresh_token) merged.refresh_token = existing.refresh_token;
  const data = encrypt(JSON.stringify(merged));
  const now = new Date().toISOString();
  db()
    .insert(schema.oauthTokens)
    .values({ provider: 'google', data, account: account ?? undefined, updatedAt: now })
    .onConflictDoUpdate({ target: schema.oauthTokens.provider, set: { data, ...(account ? { account } : {}), updatedAt: now } })
    .run();
}

export function googleAccount(): string | null {
  const row = db().select().from(schema.oauthTokens).where(eq(schema.oauthTokens.provider, 'google')).get();
  return row?.account ?? null;
}

export function isGoogleConnected(): boolean {
  try {
    return !!loadGoogleTokens()?.refresh_token;
  } catch {
    return false;
  }
}

export async function handleGoogleCallback(code: string): Promise<string> {
  const client = newClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  let email: string | null = null;
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const me = await oauth2.userinfo.get();
    email = me.data.email ?? null;
  } catch (err) {
    logger.warn({ err }, 'Google アカウント情報の取得に失敗');
  }
  saveGoogleTokens(tokens, email);
  authedClient = null;
  return email ?? '';
}

let authedClient: OAuth2Client | null = null;

export function googleClient(): OAuth2Client {
  if (!authedClient) {
    const tokens = loadGoogleTokens();
    if (!tokens?.refresh_token) throw new Error('Google が未接続です。設定画面から接続してください。');
    authedClient = newClient();
    authedClient.setCredentials(tokens);
    authedClient.on('tokens', (t) => saveGoogleTokens(t));
  }
  return authedClient;
}

export function disconnectGoogle() {
  db().delete(schema.oauthTokens).where(eq(schema.oauthTokens.provider, 'google')).run();
  authedClient = null;
}

export function gmailApi() {
  return google.gmail({ version: 'v1', auth: googleClient() });
}

export function calendarApi() {
  return google.calendar({ version: 'v3', auth: googleClient() });
}

/** 接続情報の変更後にクライアントを作り直す */
export function resetGoogleClient() {
  authedClient = null;
}
