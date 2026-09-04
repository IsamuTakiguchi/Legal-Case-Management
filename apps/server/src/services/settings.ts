import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

export const SETTING_DEFAULTS: Record<string, string> = {
  office_name: '',
  lawyer_name: '',
  signature_gmail: '',
  business_hours_start: '9',
  business_hours_end: '18',
  default_meeting_minutes: '60',
  waiting_followup_business_days: '3',
  scheduling_stale_business_days: '3',
  attachment_subfolder: '受領資料',
  court_docs_subfolder: '提出書面',
  draft_subfolder: '下書き',
  unassigned_folder: '_未振分',
  forms_library_paths: '/書式',
  forms_index_client_subfolders: '提出書面',
  share_link_expiry_days: '30',
  share_link_scope: 'anonymous',
  morning_digest_hour: '8',
  office_location: '',
  holidays: '',
  line_manual_send_note: 'ファイルは LINE公式アカウントの管理画面（チャット）から手動でお送りください。',
};

const cache = new Map<string, string>();

export function getSetting(key: string): string {
  if (cache.has(key)) return cache.get(key)!;
  const row = db().select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  const v = row?.value ?? SETTING_DEFAULTS[key] ?? '';
  cache.set(key, v);
  return v;
}

export function getSettingInt(key: string, fallback = 0): number {
  const n = Number.parseInt(getSetting(key), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function setSetting(key: string, value: string) {
  db()
    .insert(schema.settings)
    .values({ key, value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date().toISOString() } })
    .run();
  cache.set(key, value);
}

export function allSettings(): Record<string, string> {
  const rows = db().select().from(schema.settings).all();
  const out: Record<string, string> = { ...SETTING_DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function getSyncState(key: string): string | null {
  const row = db().select().from(schema.syncState).where(eq(schema.syncState.key, key)).get();
  return row?.value ?? null;
}

export function setSyncState(key: string, value: string) {
  db()
    .insert(schema.syncState)
    .values({ key, value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: schema.syncState.key, set: { value, updatedAt: new Date().toISOString() } })
    .run();
}

export function holidaySet(): Set<string> {
  return new Set(
    getSetting('holidays')
      .split(/[\s,、]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** テスト用 */
export function clearSettingsCache() {
  cache.clear();
}
