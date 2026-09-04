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
  webUrl?: string;
}

export interface StorageBackend {
  kind: 'onedrive' | 'local';
  clientRoot(): string;
  put(folderPath: string, filename: string, data: Buffer): Promise<StoredFile>;
  get(file: { itemId?: string | null; path: string }): Promise<Buffer>;
  move(file: { itemId?: string | null; path: string }, newFolderPath: string): Promise<StoredFile>;
  list(folderPath: string): Promise<ListedFile[]>;
  shareLink?(file: { itemId?: string | null; path: string }, expiresAt: Date): Promise<string>;
}

class OneDriveStorage implements StorageBackend {
  kind = 'onedrive' as const;
  clientRoot() {
    return env().ONEDRIVE_CLIENT_ROOT;
  }
  async put(folderPath: string, filename: string, data: Buffer): Promise<StoredFile> {
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
  async list(folderPath: string): Promise<ListedFile[]> {
    const items = await od.listChildren(folderPath);
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
    if (!abs.startsWith(this.base)) throw new Error('不正なパスです');
    return abs;
  }
  async put(folderPath: string, filename: string, data: Buffer): Promise<StoredFile> {
    const dir = this.abs(folderPath);
    await fs.mkdir(dir, { recursive: true });
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
  async list(folderPath: string): Promise<ListedFile[]> {
    const dir = this.abs(folderPath);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const out: ListedFile[] = [];
    for (const e of entries) {
      const st = await fs.stat(path.join(dir, e.name)).catch(() => null);
      out.push({ name: e.name, path: od.joinPath(folderPath, e.name), isFolder: e.isDirectory(), size: st?.size, modifiedAt: st?.mtime.toISOString() });
    }
    return out;
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
