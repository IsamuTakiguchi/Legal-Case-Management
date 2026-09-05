import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

const envSchema = z.object({
  PORT: z.coerce.number().default(8787),
  PUBLIC_BASE_URL: z.string().default('http://localhost:8787'),
  DATA_DIR: z.string().default('./data'),
  APP_PASSWORD: z.string().default(''),
  /** 未設定なら初回起動時に自動生成して DATA_DIR/session_secret に保存する */
  SESSION_SECRET: z.string().min(8),
  LOG_LEVEL: z.string().default('info'),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),

  LINE_CHANNEL_ID: z.string().optional(),
  LINE_CHANNEL_SECRET: z.string().optional(),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().optional(),
  LINE_MONTHLY_PUSH_LIMIT: z.coerce.number().default(5000),

  CHATWORK_API_TOKEN: z.string().optional(),
  CHATWORK_WEBHOOK_TOKEN: z.string().optional(),
  CHATWORK_NOTIFY_ROOM_ID: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().default('primary'),

  ZOOM_ACCOUNT_ID: z.string().optional(),
  ZOOM_CLIENT_ID: z.string().optional(),
  ZOOM_CLIENT_SECRET: z.string().optional(),

  MS_TENANT_ID: z.string().optional(),
  MS_CLIENT_ID: z.string().optional(),
  MS_CLIENT_SECRET: z.string().optional(),
  /** app = 自前のアプリ登録（既定）, device = 公開クライアントでデバイスコード接続（アプリ登録不要） */
  MS_AUTH_MODE: z.enum(['app', 'device']).default('app'),

  STORAGE_BACKEND: z.enum(['onedrive', 'local']).default('onedrive'),
  ONEDRIVE_CLIENT_ROOT: z.string().default('/依頼者'),
  LOCAL_CLIENT_ROOT: z.string().default('./data/clients'),

  JOBS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * SESSION_SECRET が環境変数にない場合、DATA_DIR 内のファイルから読む（なければ生成して保存）。
 * セッション Cookie の署名と接続情報の暗号化キーに使うため、再デプロイ後も同じ値である必要がある。
 */
function loadOrCreateSessionSecret(dir: string): string {
  const file = path.join(path.resolve(dir), 'session_secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 8) return existing;
  } catch {
    // 未作成
  }
  const secret = randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
  } catch (err) {
    console.warn(`SESSION_SECRET を保存できません（${file}）。再起動のたびにログインし直しになります: ${String(err)}`);
  }
  return secret;
}
/** 画面から保存した接続情報（DB に暗号化保存）で環境変数を上書きする */
let overrides: Record<string, string> = {};

export function env(): Env {
  if (!cached) {
    const merged: Record<string, string | undefined> = { ...process.env };
    // ホスティング側が公開 URL を教えてくれる場合は既定値に使う（Render / Railway / Fly.io）
    if (!merged.PUBLIC_BASE_URL && merged.RENDER_EXTERNAL_URL) merged.PUBLIC_BASE_URL = merged.RENDER_EXTERNAL_URL;
    if (!merged.PUBLIC_BASE_URL && merged.RAILWAY_PUBLIC_DOMAIN) merged.PUBLIC_BASE_URL = `https://${merged.RAILWAY_PUBLIC_DOMAIN}`;
    if (!merged.PUBLIC_BASE_URL && merged.FLY_APP_NAME) merged.PUBLIC_BASE_URL = `https://${merged.FLY_APP_NAME}.fly.dev`;
    if (!merged.SESSION_SECRET) merged.SESSION_SECRET = loadOrCreateSessionSecret(merged.DATA_DIR ?? './data');
    for (const [k, v] of Object.entries(overrides)) if (v !== '') merged[k] = v;
    const parsed = envSchema.safeParse(merged);
    if (!parsed.success) {
      throw new Error(`環境変数が不正です: ${parsed.error.message}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export function setEnvOverrides(values: Record<string, string>) {
  overrides = { ...values };
  cached = null;
}

export function envOverrides(): Record<string, string> {
  return { ...overrides };
}

/** .env（環境変数）側に値があるか */
export function envHasValue(key: string): boolean {
  return !!process.env[key];
}

export function dataDir(): string {
  return path.resolve(env().DATA_DIR);
}

export function dbPath(): string {
  return path.join(dataDir(), 'app.db');
}

export function isConfigured(service: 'line' | 'chatwork' | 'google' | 'zoom' | 'microsoft' | 'anthropic'): boolean {
  const e = env();
  switch (service) {
    case 'line':
      return !!(e.LINE_CHANNEL_SECRET && (e.LINE_CHANNEL_ACCESS_TOKEN || e.LINE_CHANNEL_ID));
    case 'chatwork':
      return !!e.CHATWORK_API_TOKEN;
    case 'google':
      return !!(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET);
    case 'zoom':
      return !!(e.ZOOM_ACCOUNT_ID && e.ZOOM_CLIENT_ID && e.ZOOM_CLIENT_SECRET);
    case 'microsoft':
      return e.MS_AUTH_MODE === 'device' || !!(e.MS_TENANT_ID && e.MS_CLIENT_ID && e.MS_CLIENT_SECRET);
    case 'anthropic':
      return !!e.ANTHROPIC_API_KEY;
  }
}

/** テスト用: 環境変数キャッシュを破棄 */
export function resetEnvCache() {
  cached = null;
}

export function ensureDataDirSafe() {
  fs.mkdirSync(dataDir(), { recursive: true });
}
