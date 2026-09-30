import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../config.js';
import { logger } from '../logger.js';

/**
 * 画像プレビューの控え（DATA_DIR/preview-cache/{添付 ID}）。
 * 会話を開くたびに OneDrive や LINE・Chatwork から取り直さないために置く。上限を超えたら、長く見ていないものから消す
 */

/** 控えに置く 1 枚の上限と、控え全体の上限 */
const MAX_CACHE_FILE = 20 * 1024 * 1024;
const MAX_CACHE_TOTAL = 300 * 1024 * 1024;

function cacheDir(): string {
  return path.join(dataDir(), 'preview-cache');
}

function cachePath(id: number): string {
  return path.join(cacheDir(), String(id));
}

export function readPreviewCache(id: number): Buffer | null {
  const p = cachePath(id);
  try {
    const data = fs.readFileSync(p);
    const now = new Date();
    fs.utimesSync(p, now, now);
    return data;
  } catch {
    return null;
  }
}

export function writePreviewCache(id: number, data: Buffer) {
  if (data.length > MAX_CACHE_FILE) return;
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(cachePath(id), data);
    pruneCache();
  } catch (err) {
    logger.warn({ err, id }, '画像プレビューの控えを保存できませんでした');
  }
}

/** 控えを捨てる（ファイルを「不要」にしたときなど） */
export function dropPreviewCache(id: number) {
  fs.rmSync(cachePath(id), { force: true });
}

function pruneCache() {
  let files: { p: string; size: number; at: number }[];
  try {
    files = fs.readdirSync(cacheDir()).map((name) => {
      const p = path.join(cacheDir(), name);
      const st = fs.statSync(p);
      return { p, size: st.size, at: st.mtimeMs };
    });
  } catch {
    return;
  }
  let total = files.reduce((s, f) => s + f.size, 0);
  for (const f of files.sort((a, b) => a.at - b.at)) {
    if (total <= MAX_CACHE_TOTAL) break;
    fs.rmSync(f.p, { force: true });
    total -= f.size;
  }
}
