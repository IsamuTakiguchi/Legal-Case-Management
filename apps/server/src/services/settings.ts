import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

export const SETTING_DEFAULTS: Record<string, string> = {
  office_name: '登大路総合法律事務所',
  lawyer_name: '瀧口勇',
  signature_gmail: `***********************************
弁護士・中小企業診断士 瀧口勇
〒630-8213 奈良市登大路町５番地 修徳ビル１階
登大路総合法律事務所
ＨＰ http://www.noboriohji.com/
電話 0742（23）8710 FAX 0742（23）8699
Mail takiguchi@noborilaw.com
***********************************`,
  access_note: `なお、契約車以外の駐車場がございませんので、お車でお越しの際は、修徳ビル隣のモータープール(有料)をご利用ください。
アクセス方法は、次のＵＲＬをご覧下さい。
http://www.noboriohji.com/access/`,
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
  web_meeting_provider: 'auto',
  office_location: '登大路総合法律事務所（奈良市登大路町5番地 修徳ビル1階）',
  holidays: '',
  /** 依頼者フォルダの区分レイアウト（JSON: {consultation:'0.相談', active:'1.進行事件', ...}）。空ならルート直下 */
  client_status_folders: '',
  /** 区分に対応しないが依頼者フォルダを含むフォルダ（改行区切り。例: 4.その他（顧問等）） */
  client_extra_folders: '',
  /** 新規依頼者フォルダの名前の形。{kana}=読みの頭文字、{name}=氏名、{case}=事件名。例: "{kana}{name}　{case}"。空なら氏名のみ。既存フォルダから自動推定 */
  client_folder_name_format: '',
  /** Google でログインできるメールアドレス（カンマ／改行区切り）。空なら「Google に接続」したアカウント */
  login_google_emails: '',
  backup_folder: '_システム/バックアップ',
  backup_keep_generations: '14',
  backup_local_keep: '7',
  digest_title: 'おはようございます。本日のまとめ',
  digest_footer: '',
  digest_max_items: '15',
  alert_notify_title: '確認が必要な事項',
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
