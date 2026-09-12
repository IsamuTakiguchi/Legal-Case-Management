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
  business_hours_start: '9:00',
  business_hours_end: '18:00',
  travel_buffer_minutes: '60',
  slot_gap_minutes: '0',
  slot_step_minutes: '30',
  default_meeting_minutes: '60',
  waiting_followup_business_days: '3',
  scheduling_stale_business_days: '3',
  attachment_subfolder: '受領資料',
  /** 受信ファイルの扱い: auto | client_only | manual（services/attachments.ts 参照） */
  attachment_policy: 'client_only',
  attachment_smart_names: '1',
  court_docs_subfolder: '提出書面',
  draft_subfolder: '下書き',
  unassigned_folder: '_未振分',
  forms_library_paths: '/書式',
  forms_index_client_subfolders: '提出書面',
  share_link_expiry_days: '30',
  /** API 利用料の円換算に使う為替レート（1 ドル＝何円） */
  usd_jpy_rate: '150',
  /** 使う AI モデル（空なら環境変数 ANTHROPIC_MODEL の既定）。packages/shared の AI_MODELS 参照 */
  ai_model: '',
  /** 判定・仕分けなど軽い処理に使うモデル（空なら上と同じ） */
  ai_model_light: '',
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
  /** Gmail の取込範囲: all（すべて）| primary（受信トレイの「メイン」タブだけ。プロモーション・ソーシャル・新着・フォーラムは除外） */
  gmail_categories: 'all',
  /** 自分の送信元とみなすメールアドレス（別名・他アカウント。カンマ区切り）。ここからのメールは受信ではなく送信として扱う */
  my_email_addresses: '',
  /** Chatwork の取込範囲: all（参加ルームの全メッセージ）| to_me（自分宛の To・自分への返信 re・全員宛・ダイレクト・自分に振られたタスクのメッセージだけ） */
  chatwork_scope: 'all',
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

/** "10:00" / "10" / "９：３０" → 0 時からの分。読めなければ fallback */
export function parseHm(v: string | null | undefined, fallback: number): number {
  const m = String(v ?? '')
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ':')
    .match(/^(\d{1,2})(?::(\d{1,2}))?(?:時)?$/);
  if (!m) return fallback;
  const h = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  if (h > 24 || mi > 59) return fallback;
  return h * 60 + mi;
}

/** 分 → "10:00" */
export function fmtHm(min: number): string {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}

/** 営業時間（分単位。設定は "10:00" のように分まで指定できる） */
export function businessHours(): { startMin: number; endMin: number } {
  const startMin = parseHm(getSetting('business_hours_start'), 9 * 60);
  const endMin = parseHm(getSetting('business_hours_end'), 18 * 60);
  return endMin > startMin ? { startMin, endMin } : { startMin: 9 * 60, endMin: 18 * 60 };
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
