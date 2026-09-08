import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { desc, eq } from 'drizzle-orm';
import { sqlite, db, schema, closeDatabase, openDatabase, currentDatabasePath } from '../db/index.js';
import { dataDir } from '../config.js';
import { storage } from '../integrations/storage.js';
import { isMsConnected } from '../integrations/onedrive.js';
import { getSetting, getSettingInt, clearSettingsCache } from './settings.js';
import { logger } from '../logger.js';

export interface BackupResult {
  file: string;
  size: number;
  localKept: number;
  remote: { path: string; kept: number } | null;
}

const NAME_RE = /^app-\d{8}-\d{4}(?:\d{2})?\.db\.gz$/;

function stamp(): string {
  const d = new Date(Date.now() + 9 * 3600_000); // JST
  const p = (n: number) => String(n).padStart(2, '0');
  // 秒まで付ける（同じ分に手動バックアップと復元前の控えを作っても上書きしない）
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function localDir(): string {
  const dir = path.join(dataDir(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** ローカル世代整理。古い順に削除 */
function pruneLocal(keep: number): number {
  const dir = localDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => NAME_RE.test(f))
    .sort();
  while (files.length > keep) {
    const f = files.shift()!;
    fs.unlinkSync(path.join(dir, f));
  }
  return files.length;
}

/** バックアップ先フォルダ（依頼者ルート配下の _システム/バックアップ） */
export function remoteBackupFolder(): string {
  const root = storage().clientRoot().replace(/\/+$/, '');
  const sub = getSetting('backup_folder').replace(/^\/+|\/+$/g, '');
  return `${root}/${sub}`;
}

/**
 * SQLite のオンラインバックアップ API で整合性のあるスナップショットを作り、gzip 圧縮して
 * ローカル（DATA_DIR/backups）と OneDrive に世代保存する。
 */
export async function runBackup(): Promise<BackupResult> {
  const name = `app-${stamp()}.db.gz`;
  const tmp = path.join(localDir(), `.tmp-${process.pid}.db`);
  try {
    await sqlite().backup(tmp);
    const gz = gzipSync(fs.readFileSync(tmp), { level: 6 });
    fs.writeFileSync(path.join(localDir(), name), gz);
    const localKept = pruneLocal(Math.max(1, getSettingInt('backup_local_keep', 7)));

    let remote: BackupResult['remote'] = null;
    const st = storage();
    const remoteOk = st.kind === 'local' || (await isMsConnected().catch(() => false));
    if (remoteOk) {
      const folder = remoteBackupFolder();
      await st.put(folder, name, gz);
      const keep = Math.max(1, getSettingInt('backup_keep_generations', 14));
      const listed = (await st.list(folder)).filter((f) => !f.isFolder && NAME_RE.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
      let kept = listed.length;
      while (listed.length > keep) {
        const old = listed.shift()!;
        try {
          await st.remove({ itemId: old.itemId, path: old.path });
          kept--;
        } catch (err) {
          logger.warn({ err, file: old.path }, '古いバックアップの削除に失敗');
        }
      }
      remote = { path: `${folder}/${name}`, kept };
    }
    return { file: name, size: gz.length, localKept, remote };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function listLocalBackups(): { name: string; size: number; createdAt: string }[] {
  const dir = localDir();
  return fs
    .readdirSync(dir)
    .filter((f) => NAME_RE.test(f))
    .sort()
    .reverse()
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, size: st.size, createdAt: st.mtime.toISOString() };
    });
}

/** 直近のバックアップの状況（自動ジョブの結果と、サーバー内の最新ファイル） */
export function lastBackupInfo(): { at: string | null; ok: boolean | null; error: string | null; file: string | null; remote: boolean } {
  const run = db().select().from(schema.jobRuns).where(eq(schema.jobRuns.name, 'backup')).orderBy(desc(schema.jobRuns.startedAt)).limit(1).get();
  const newest = listLocalBackups()[0] ?? null;
  const runAt = run?.finishedAt ?? run?.startedAt ?? null;
  const fileAt = newest?.createdAt ?? null;
  // 手動バックアップはジョブ履歴に残らないので、ファイルの方が新しければそちらを採用
  const useFile = fileAt && (!runAt || fileAt > runAt);
  return {
    at: useFile ? fileAt : runAt,
    ok: useFile ? true : (run ? run.ok : null),
    error: useFile ? null : (run?.error?.slice(0, 200) ?? null),
    file: newest?.name ?? null,
    remote: !!run?.summary && run.summary.includes('"remote":{'),
  };
}

const SQLITE_MAGIC = 'SQLite format 3\0';
let restoring = false;

/**
 * バックアップ（.db.gz または .db）からデータベースを復元する。
 * 1. 中身を検証（SQLite 形式・主要テーブルの有無・整合性）
 * 2. 念のため現在の DB をバックアップ
 * 3. DB を閉じて差し替え、開き直す（マイグレーションは自動で当たる）
 */
export async function restoreBackup(input: Buffer, label = 'upload'): Promise<{ restoredFrom: string; size: number; safetyBackup: string; clients: number; messages: number }> {
  if (restoring) throw new Error('復元を実行中です');
  restoring = true;
  const tmp = path.join(localDir(), `.restore-${process.pid}.db`);
  try {
    const raw = input.length > 2 && input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input) : input;
    if (raw.subarray(0, 16).toString('latin1') !== SQLITE_MAGIC) throw new Error('SQLite のデータベースファイルではありません（.db または .db.gz を指定してください）');
    fs.writeFileSync(tmp, raw);
    let clients = 0;
    let messages = 0;
    const probe = new Database(tmp, { readonly: true });
    try {
      const tables = new Set((probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name));
      for (const t of ['clients', 'cases', 'conversations', 'messages', 'settings']) {
        if (!tables.has(t)) throw new Error(`このアプリのバックアップではありません（テーブル ${t} がありません）`);
      }
      const check = (probe.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check;
      if (check !== 'ok') throw new Error(`データベースが壊れています: ${check}`);
      clients = (probe.prepare('SELECT COUNT(*) AS c FROM clients').get() as { c: number }).c;
      messages = (probe.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
    } finally {
      probe.close();
    }
    // 念のため現在の状態を残す（ローカルには必ず残る）
    const safety = await runBackup();
    const target = currentDatabasePath();
    closeDatabase();
    try {
      for (const suffix of ['-wal', '-shm']) fs.rmSync(target + suffix, { force: true });
      fs.copyFileSync(tmp, target);
    } finally {
      openDatabase(target);
      clearSettingsCache();
    }
    logger.warn({ label, clients, messages, safetyBackup: safety.file }, 'バックアップから復元しました');
    return { restoredFrom: label, size: raw.length, safetyBackup: safety.file, clients, messages };
  } finally {
    fs.rmSync(tmp, { force: true });
    restoring = false;
  }
}

/** サーバー内の世代から復元 */
export async function restoreLocalBackup(name: string) {
  const p = localBackupPath(name);
  if (!p) throw new Error('バックアップが見つかりません');
  return restoreBackup(fs.readFileSync(p), name);
}

/** ファイル名を検証してローカルのバックアップの絶対パスを返す */
export function localBackupPath(name: string): string | null {
  if (!NAME_RE.test(name)) return null;
  const p = path.join(localDir(), name);
  return fs.existsSync(p) ? p : null;
}
