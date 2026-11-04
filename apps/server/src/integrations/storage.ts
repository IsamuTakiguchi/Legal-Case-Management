import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config.js';
import * as od from './onedrive.js';

export interface StoredFile {
  path: string;
  itemId?: string;
  webUrl?: string;
  size: number;
}

export interface ListedFile {
  name: string;
  path: string;
  itemId?: string;
  isFolder: boolean;
  size?: number;
  modifiedAt?: string;
  createdAt?: string;
  webUrl?: string;
}

/** 前回から新しくできた・変わったファイル（フォルダ配下すべて） */
export interface ChangedFiles {
  files: ListedFile[];
  /** 次に続きを取るときに渡す目印 */
  cursor: string;
  /** 目印なしで取った（初回。フォルダ配下のファイルがすべて返る） */
  initial: boolean;
}

/** 一覧しようとしたフォルダが無い（まだ作られていない）ときのエラー */
export class FolderNotFoundError extends Error {
  constructor(public folderPath: string) {
    super(`フォルダがありません: ${folderPath}`);
    this.name = 'FolderNotFoundError';
  }
}

export interface StorageBackend {
  kind: 'onedrive' | 'local';
  clientRoot(): string;
  /** フォルダを（親も含めて）作る。既にあれば何もしない */
  ensureFolder(folderPath: string): Promise<void>;
  /**
   * ファイルを保存する。dedupe を付けると、同じ名前・同じ大きさのファイルが既にあれば
   * それを使い回す（再実行・再デプロイでの二重保存を防ぐ）。違う中身なら従来どおり連番を付けて別ファイルにする
   */
  put(folderPath: string, filename: string, data: Buffer, opts?: { dedupe?: boolean }): Promise<StoredFile>;
  get(file: { itemId?: string | null; path: string }): Promise<Buffer>;
  move(file: { itemId?: string | null; path: string }, newFolderPath: string): Promise<StoredFile>;
  list(folderPath: string): Promise<ListedFile[]>;
  shareLink?(file: { itemId?: string | null; path: string }, expiresAt: Date): Promise<string>;
  /**
   * フォルダ配下で、前回（cursor）から新しくできた・変わったファイル（accept の形式だけ、limit 件まで）。
   * cursor が無いときの扱いは置き場所による（OneDrive はいまから見はじめる、ローカルは配下すべて）
   */
  changedFiles?(folderPath: string, cursor: string | null, opts?: { accept?: RegExp; limit?: number }): Promise<ChangedFiles>;
  remove(file: { itemId?: string | null; path: string }): Promise<void>;
}

class OneDriveStorage implements StorageBackend {
  kind = 'onedrive' as const;
  clientRoot() {
    return env().ONEDRIVE_CLIENT_ROOT;
  }
  async put(folderPath: string, filename: string, data: Buffer, opts: { dedupe?: boolean } = {}): Promise<StoredFile> {
    if (opts.dedupe) {
      const existing = await od.getItemByPath(od.joinPath(folderPath, filename)).catch(() => null);
      if (existing && existing.size === data.length) {
        return { path: od.joinPath(folderPath, existing.name), itemId: existing.id, webUrl: existing.webUrl, size: existing.size };
      }
    }
    const item = await od.uploadFile(folderPath, filename, data, 'rename');
    return { path: od.joinPath(folderPath, item.name), itemId: item.id, webUrl: item.webUrl, size: item.size ?? data.length };
  }
  private async resolveId(file: { itemId?: string | null; path: string }): Promise<string> {
    if (file.itemId) return file.itemId;
    const item = await od.getItemByPath(file.path);
    if (!item) throw new Error(`ファイルが見つかりません: ${file.path}`);
    return item.id;
  }
  async get(file: { itemId?: string | null; path: string }): Promise<Buffer> {
    return od.downloadFile(await this.resolveId(file));
  }
  async move(file: { itemId?: string | null; path: string }, newFolderPath: string): Promise<StoredFile> {
    const moved = await od.moveItem(await this.resolveId(file), newFolderPath);
    return { path: od.joinPath(newFolderPath, moved.name), itemId: moved.id, webUrl: moved.webUrl, size: moved.size ?? 0 };
  }
  async ensureFolder(folderPath: string): Promise<void> {
    await od.ensureFolder(folderPath);
  }
  async list(folderPath: string): Promise<ListedFile[]> {
    const items = await od.listChildren(folderPath).catch((err) => {
      if (String(err).includes('エラー 404')) throw new FolderNotFoundError(folderPath);
      throw err;
    });
    return items.map((i) => ({
      name: i.name,
      path: od.joinPath(folderPath, i.name),
      itemId: i.id,
      isFolder: !!i.folder,
      size: i.size,
      modifiedAt: i.lastModifiedDateTime,
      webUrl: i.webUrl,
    }));
  }
  async shareLink(file: { itemId?: string | null; path: string }, expiresAt: Date): Promise<string> {
    return od.createShareLink(await this.resolveId(file), { scope: 'anonymous', expiresAt });
  }
  /**
   * Graph の delta で変更を取る。ドライブ全体の変更を 1 ページずつ受け取り、フォルダ配下・形式（accept）で絞ったものだけ残す。
   * 目印が無いとき（初回）・古くて使えないときは、過去分は読まずに「いま」から見はじめる（ドライブ全体を読み込まない）
   */
  async changedFiles(folderPath: string, cursor: string | null, opts: { accept?: RegExp; limit?: number } = {}): Promise<ChangedFiles> {
    if (!cursor) return { files: [], cursor: await od.latestDriveDeltaLink(), initial: true };
    const root = od.joinPath(folderPath);
    const files: ListedFile[] = [];
    const limit = opts.limit ?? 500;
    const collect = (items: od.DriveItem[]) => {
      for (const i of items) {
        if (files.length >= limit) return;
        if (!i.file || i.deleted) continue;
        if (opts.accept && !opts.accept.test(i.name)) continue;
        const parent = driveParentPath(i.parentReference?.path);
        const p = od.joinPath(parent, i.name);
        if (root !== '/' && p !== root && !p.startsWith(`${root}/`)) continue;
        files.push({ name: i.name, path: p, itemId: i.id, isFolder: false, size: i.size, modifiedAt: i.lastModifiedDateTime, createdAt: i.createdDateTime, webUrl: i.webUrl });
      }
    };
    try {
      const next = await od.driveDeltaPages(cursor, collect);
      return { files, cursor: next || cursor, initial: false };
    } catch (err) {
      // 目印が古くなった（410 resyncRequired など）ときは、いまから見はじめる
      if (/ 410 |resync/i.test(String(err))) return { files: [], cursor: await od.latestDriveDeltaLink(), initial: true };
      throw err;
    }
  }
  async remove(file: { itemId?: string | null; path: string }): Promise<void> {
    await od.deleteItem(await this.resolveId(file));
  }
}

/**
 * Graph の parentReference.path（「/drive/root:/依頼者/山田」「/drives/b!xx/root:/依頼者/%E5%B1%B1」）を、
 * アプリで使うパス（「/依頼者/山田」）にする。「%」を含む名前でも壊れないよう、読めなければそのまま使う
 */
export function driveParentPath(p: string | null | undefined): string {
  const rel = (p ?? '').replace(/^.*?root:/, '');
  let decoded = rel;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    decoded = rel;
  }
  return od.joinPath(decoded);
}

/** OneDrive 同期フォルダに直接書き込む（事務所 PC で動かす場合の代替） */
export class LocalFolderStorage implements StorageBackend {
  kind = 'local' as const;
  private base: string;
  constructor(base: string) {
    this.base = path.resolve(base);
  }
  clientRoot() {
    return '/';
  }
  private abs(p: string) {
    const abs = path.resolve(this.base, p.replace(/^\/+/, ''));
    if (abs !== this.base && !abs.startsWith(this.base + path.sep)) throw new Error('不正なパスです');
    return abs;
  }
  async put(folderPath: string, filename: string, data: Buffer, opts: { dedupe?: boolean } = {}): Promise<StoredFile> {
    const dir = this.abs(folderPath);
    await fs.mkdir(dir, { recursive: true });
    if (opts.dedupe) {
      const st = await fs.stat(path.join(dir, filename)).catch(() => null);
      if (st?.isFile() && st.size === data.length) {
        return { path: od.joinPath(folderPath, filename), size: st.size };
      }
    }
    let name = filename;
    let n = 1;
    for (;;) {
      try {
        await fs.access(path.join(dir, name));
        const ext = path.extname(filename);
        name = `${path.basename(filename, ext)} (${n++})${ext}`;
      } catch {
        break;
      }
    }
    await fs.writeFile(path.join(dir, name), data);
    return { path: od.joinPath(folderPath, name), size: data.length };
  }
  async get(file: { path: string }): Promise<Buffer> {
    return fs.readFile(this.abs(file.path));
  }
  async move(file: { path: string }, newFolderPath: string): Promise<StoredFile> {
    const data = await this.get(file);
    const stored = await this.put(newFolderPath, path.basename(file.path), data);
    await fs.unlink(this.abs(file.path));
    return stored;
  }
  async ensureFolder(folderPath: string): Promise<void> {
    await fs.mkdir(this.abs(folderPath), { recursive: true });
  }
  async list(folderPath: string): Promise<ListedFile[]> {
    const dir = this.abs(folderPath);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
      if (err?.code === 'ENOENT') throw new FolderNotFoundError(folderPath);
      return [];
    });
    const out: ListedFile[] = [];
    for (const e of entries) {
      const st = await fs.stat(path.join(dir, e.name)).catch(() => null);
      out.push({ name: e.name, path: od.joinPath(folderPath, e.name), isFolder: e.isDirectory(), size: st?.size, modifiedAt: st?.mtime.toISOString() });
    }
    return out;
  }
  async remove(file: { path: string }): Promise<void> {
    await fs.unlink(this.abs(file.path));
  }
  /** フォルダ配下を見て、目印（前回の時刻）より後に変わったファイルを返す */
  async changedFiles(folderPath: string, cursor: string | null, opts: { accept?: RegExp; limit?: number } = {}): Promise<ChangedFiles> {
    const startedAt = new Date().toISOString();
    const limit = opts.limit ?? 500;
    const out: ListedFile[] = [];
    const walk = async (dir: string, depth: number) => {
      if (depth > 8) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(this.abs(dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = od.joinPath(dir, e.name);
        if (e.isDirectory()) {
          await walk(p, depth + 1);
          continue;
        }
        if (out.length >= limit) return;
        if (opts.accept && !opts.accept.test(e.name)) continue;
        const st = await fs.stat(this.abs(p)).catch(() => null);
        if (!st) continue;
        if (cursor && st.mtime.toISOString() <= cursor) continue;
        out.push({ name: e.name, path: p, isFolder: false, size: st.size, modifiedAt: st.mtime.toISOString(), createdAt: st.birthtime.toISOString() });
      }
    };
    await walk(folderPath, 0);
    return { files: out, cursor: startedAt, initial: !cursor };
  }
}

let backend: StorageBackend | null = null;
export function storage(): StorageBackend {
  if (!backend) backend = env().STORAGE_BACKEND === 'local' ? new LocalFolderStorage(env().LOCAL_CLIENT_ROOT) : new OneDriveStorage();
  return backend;
}

/** テスト用 */
export function setStorageBackend(b: StorageBackend | null) {
  backend = b;
}
