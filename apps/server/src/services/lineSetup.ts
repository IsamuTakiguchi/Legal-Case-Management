/**
 * LINE の初期設定を自動化する。
 * - チャネル ID + シークレットからチャネルアクセストークンを自動発行（30 日有効、期限前に再発行）
 * - Webhook エンドポイント URL を API で登録し、疎通テストを行う
 */
import { env } from '../config.js';
import { getSetting, setSetting } from './settings.js';
import { encrypt, decrypt } from '../crypto.js';
import { logger } from '../logger.js';

const TOKEN_KEY = 'line_auto_token'; // 暗号化 JSON {token, expiresAt}

interface StoredToken {
  token: string;
  expiresAt: string;
}

function readStored(): StoredToken | null {
  const raw = getSetting(TOKEN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(decrypt(raw)) as StoredToken;
  } catch {
    return null;
  }
}

/** 使うべきアクセストークンを返す。手入力の長期トークンがあればそれを優先 */
export async function lineAccessToken(): Promise<string> {
  const e = env();
  if (e.LINE_CHANNEL_ACCESS_TOKEN) return e.LINE_CHANNEL_ACCESS_TOKEN;
  if (!e.LINE_CHANNEL_ID || !e.LINE_CHANNEL_SECRET) throw new Error('LINE のチャネル ID / シークレットが未設定です');
  const stored = readStored();
  if (stored && new Date(stored.expiresAt).getTime() - Date.now() > 3 * 86400_000) return stored.token;
  return issueChannelToken();
}

/** client_credentials でチャネルアクセストークン（短期・30日）を発行 */
export async function issueChannelToken(): Promise<string> {
  const e = env();
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: e.LINE_CHANNEL_ID!, client_secret: e.LINE_CHANNEL_SECRET! });
  const res = await fetch('https://api.line.me/v2/oauth/accessToken', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) throw new Error(`LINE トークン発行に失敗 ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  const expiresAt = new Date(Date.now() + j.expires_in * 1000).toISOString();
  setSetting(TOKEN_KEY, encrypt(JSON.stringify({ token: j.access_token, expiresAt })));
  logger.info({ expiresAt }, 'LINE チャネルアクセストークンを発行しました');
  return j.access_token;
}

/** 期限が近ければ再発行（日次ジョブ用） */
export async function refreshLineTokenIfNeeded(): Promise<{ refreshed: boolean }> {
  const e = env();
  if (e.LINE_CHANNEL_ACCESS_TOKEN || !e.LINE_CHANNEL_ID || !e.LINE_CHANNEL_SECRET) return { refreshed: false };
  const stored = readStored();
  if (stored && new Date(stored.expiresAt).getTime() - Date.now() > 5 * 86400_000) return { refreshed: false };
  await issueChannelToken();
  return { refreshed: true };
}

export interface WebhookState {
  endpoint?: string;
  active?: boolean;
  testSuccess?: boolean;
  testDetail?: string;
  registered: boolean;
}

/** Webhook URL を登録して疎通テストする */
export async function registerLineWebhook(): Promise<WebhookState> {
  const token = await lineAccessToken();
  const base = env().PUBLIC_BASE_URL.replace(/\/$/, '');
  const endpoint = `${base}/webhooks/line`;
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const out: WebhookState = { registered: false, endpoint };
  if (!base.startsWith('https://')) {
    out.testDetail = '公開 URL が https ではないため Webhook を登録できません';
    return out;
  }
  const put = await fetch('https://api.line.me/v2/bot/channel/webhook/endpoint', { method: 'PUT', headers: h, body: JSON.stringify({ endpoint }) });
  if (!put.ok) {
    out.testDetail = `Webhook URL の登録に失敗 ${put.status}: ${await put.text()}`;
    return out;
  }
  out.registered = true;
  const test = await fetch('https://api.line.me/v2/bot/channel/webhook/test', { method: 'POST', headers: h, body: JSON.stringify({ endpoint }) });
  if (test.ok) {
    const j = (await test.json()) as { success: boolean; statusCode?: number; detail?: string };
    out.testSuccess = j.success;
    out.testDetail = j.success ? '疎通テスト成功' : `疎通テスト失敗: ${j.detail ?? j.statusCode ?? ''}`;
  } else {
    out.testDetail = `疎通テストの実行に失敗 ${test.status}`;
  }
  const info = await fetch('https://api.line.me/v2/bot/channel/webhook/endpoint', { headers: h });
  if (info.ok) {
    const j = (await info.json()) as { endpoint: string; active: boolean };
    out.active = j.active;
    out.endpoint = j.endpoint;
  }
  return out;
}
