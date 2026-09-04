import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';

const envSchema = z.object({
  PORT: z.coerce.number().default(8787),
  PUBLIC_BASE_URL: z.string().default('http://localhost:8787'),
  DATA_DIR: z.string().default('./data'),
  APP_PASSWORD: z.string().default(''),
  SESSION_SECRET: z.string().min(8).default('dev-only-secret-change-me'),
  LOG_LEVEL: z.string().default('info'),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),

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
export function env(): Env {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`環境変数が不正です: ${parsed.error.message}`);
    }
    cached = parsed.data;
  }
  return cached;
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
      return !!(e.LINE_CHANNEL_SECRET && e.LINE_CHANNEL_ACCESS_TOKEN);
    case 'chatwork':
      return !!e.CHATWORK_API_TOKEN;
    case 'google':
      return !!(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET);
    case 'zoom':
      return !!(e.ZOOM_ACCOUNT_ID && e.ZOOM_CLIENT_ID && e.ZOOM_CLIENT_SECRET);
    case 'microsoft':
      return !!(e.MS_TENANT_ID && e.MS_CLIENT_ID && e.MS_CLIENT_SECRET);
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
