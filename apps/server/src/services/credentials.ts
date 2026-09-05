/**
 * 接続情報（API キーなど）を画面から保存できるようにする。
 * settings テーブルに `cred:<ENV名>` として暗号化保存し、起動時と保存時に環境変数へ上書きする。
 */
import { like } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { encrypt, decrypt } from '../crypto.js';
import { setEnvOverrides, envHasValue, env } from '../config.js';
import { logger } from '../logger.js';

export interface CredentialField {
  key: string; // 環境変数名
  label: string;
  secret: boolean;
  placeholder?: string;
}

export interface CredentialService {
  id: 'general' | 'anthropic' | 'line' | 'chatwork' | 'google' | 'microsoft' | 'zoom';
  label: string;
  doc: string;
  fields: CredentialField[];
}

export const CREDENTIAL_SERVICES: CredentialService[] = [
  {
    id: 'general',
    label: '公開 URL',
    doc: 'deploy.md',
    fields: [{ key: 'PUBLIC_BASE_URL', label: '公開 URL（https://…、末尾スラッシュなし）', secret: false, placeholder: 'https://app.example.com' }],
  },
  {
    id: 'anthropic',
    label: 'Claude（Anthropic API）',
    doc: 'deploy.md',
    fields: [
      { key: 'ANTHROPIC_API_KEY', label: 'API キー', secret: true, placeholder: 'sk-ant-…' },
      { key: 'ANTHROPIC_MODEL', label: 'モデル', secret: false, placeholder: 'claude-opus-5' },
    ],
  },
  {
    id: 'line',
    label: 'LINE公式アカウント',
    doc: 'line.md',
    fields: [
      { key: 'LINE_CHANNEL_ID', label: 'チャネル ID（チャネル基本設定に表示）', secret: false },
      { key: 'LINE_CHANNEL_SECRET', label: 'チャネルシークレット（同じ画面）', secret: true },
      { key: 'LINE_CHANNEL_ACCESS_TOKEN', label: '長期アクセストークン（任意。空なら自動発行）', secret: true },
      { key: 'LINE_MONTHLY_PUSH_LIMIT', label: '月間送信上限（ライト 5000 / スタンダード 30000）', secret: false, placeholder: '5000' },
    ],
  },
  {
    id: 'chatwork',
    label: 'Chatwork',
    doc: 'chatwork.md',
    fields: [
      { key: 'CHATWORK_API_TOKEN', label: 'API トークン', secret: true },
      { key: 'CHATWORK_WEBHOOK_TOKEN', label: 'Webhook トークン（任意・即時受信用）', secret: true },
      { key: 'CHATWORK_NOTIFY_ROOM_ID', label: '通知先ルーム ID（空ならマイチャット）', secret: false },
    ],
  },
  {
    id: 'google',
    label: 'Google（Gmail・カレンダー）',
    doc: 'google.md',
    fields: [
      { key: 'GOOGLE_CLIENT_ID', label: 'OAuth クライアント ID', secret: false },
      { key: 'GOOGLE_CLIENT_SECRET', label: 'OAuth クライアントシークレット', secret: true },
      { key: 'GOOGLE_CALENDAR_ID', label: 'カレンダー ID（既定 primary）', secret: false, placeholder: 'primary' },
    ],
  },
  {
    id: 'microsoft',
    label: 'OneDrive for Business',
    doc: 'onedrive.md',
    fields: [
      { key: 'MS_TENANT_ID', label: 'ディレクトリ（テナント）ID', secret: false },
      { key: 'MS_CLIENT_ID', label: 'アプリケーション（クライアント）ID', secret: false },
      { key: 'MS_CLIENT_SECRET', label: 'クライアントシークレットの値', secret: true },
      { key: 'ONEDRIVE_CLIENT_ROOT', label: '依頼者フォルダのルート（OneDrive 上のパス）', secret: false, placeholder: '/依頼者' },
    ],
  },
  {
    id: 'zoom',
    label: 'Zoom',
    doc: 'zoom.md',
    fields: [
      { key: 'ZOOM_ACCOUNT_ID', label: 'Account ID', secret: false },
      { key: 'ZOOM_CLIENT_ID', label: 'Client ID', secret: false },
      { key: 'ZOOM_CLIENT_SECRET', label: 'Client Secret', secret: true },
    ],
  },
];

const PREFIX = 'cred:';
const ALL_KEYS = new Set([...CREDENTIAL_SERVICES.flatMap((s) => s.fields.map((f) => f.key)), 'MS_AUTH_MODE']);

export function loadCredentialOverrides(): Record<string, string> {
  const rows = db().select().from(schema.settings).where(like(schema.settings.key, `${PREFIX}%`)).all();
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.slice(PREFIX.length);
    if (!ALL_KEYS.has(k)) continue;
    try {
      out[k] = decrypt(r.value);
    } catch (err) {
      logger.warn({ err, key: k }, '接続情報の復号に失敗');
    }
  }
  return out;
}

/** 起動時に呼ぶ */
export function applyCredentialOverrides() {
  setEnvOverrides(loadCredentialOverrides());
}

export function saveCredentials(values: Record<string, string>) {
  const now = new Date().toISOString();
  for (const [k, v] of Object.entries(values)) {
    if (!ALL_KEYS.has(k)) continue;
    const key = `${PREFIX}${k}`;
    if (v === '') {
      db().delete(schema.settings).where(like(schema.settings.key, key)).run();
      continue;
    }
    const enc = encrypt(v.trim());
    db()
      .insert(schema.settings)
      .values({ key, value: enc, updatedAt: now })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: enc, updatedAt: now } })
      .run();
  }
  applyCredentialOverrides();
}

function mask(v: string): string {
  if (v.length <= 8) return '••••';
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

/** 画面表示用（秘密値はマスク） */
export function describeCredentials() {
  const overrides = loadCredentialOverrides();
  const e = env() as unknown as Record<string, unknown>;
  return CREDENTIAL_SERVICES.map((s) => ({
    ...s,
    fields: s.fields.map((f) => {
      const fromDb = overrides[f.key];
      const fromEnv = envHasValue(f.key) ? String(process.env[f.key]) : '';
      const effective = String(e[f.key] ?? '');
      return {
        ...f,
        set: !!effective,
        source: fromDb ? 'db' : fromEnv ? 'env' : 'none',
        display: f.secret ? (effective ? mask(effective) : '') : effective,
      };
    }),
  }));
}
