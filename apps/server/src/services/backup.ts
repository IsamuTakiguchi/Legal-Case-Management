import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { sqlite } from '../db/index.js';
import { dataDir } from '../config.js';
import { storage } from '../integrations/storage.js';
import { isMsConnected } from '../integrations/onedrive.js';
import { getSetting, getSettingInt } from './settings.js';
import { logger } from '../logger.js';

export interface BackupResult {
  file: string;
  size: number;
  localKept: number;
  remote: { path: string; kept: number } | null;
}

const NAME_RE = /^app-\d{8}-\d{4}\.db\.gz$/;

function stamp(): string {
  const d = new Date(Date.now() + 9 * 3600_000); // JST
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
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

/** ファイル名を検証してローカルのバックアップの絶対パスを返す */
export function localBackupPath(name: string): string | null {
  if (!NAME_RE.test(name)) return null;
  const p = path.join(localDir(), name);
  return fs.existsSync(p) ? p : null;
}
