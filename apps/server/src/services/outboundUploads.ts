import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { dataDir } from '../config.js';
import { db, schema } from '../db/index.js';
import type { OutboundFile } from '../channels/types.js';
import { logger } from '../logger.js';

/**
 * 送信に添付する、パソコンから選んだファイルの一時置き場。
 * 画面で選んだ時点でここに上げておき、送信（送信予約なら予約の時刻）に添付して、送り終えたら消す
 */

/** 1 ファイルの上限（本文サイズの上限 25MB に収まるように） */
export const OUTBOUND_UPLOAD_LIMIT = 24 * 1024 * 1024;

const ID_RE = /^[0-9a-f-]{36}$/;

function outboxDir(): string {
  return path.join(dataDir(), 'outbox');
}

function dirOf(id: string): string {
  if (!ID_RE.test(id)) throw new Error('添付ファイルの指定が正しくありません');
  return path.join(outboxDir(), id);
}

interface UploadMeta {
  filename: string;
  mime: string | null;
  size: number;
  createdAt: string;
}

export function saveOutboundUpload(filename: string, mime: string | null, data: Buffer): { id: string; name: string; size: number } {
  const name = path.basename(filename.replace(/\\/g, '/')).trim() || 'ファイル';
  if (data.length === 0) throw new Error(`${name} は空のファイルです`);
  if (data.length > OUTBOUND_UPLOAD_LIMIT) throw new Error(`${name} は大きすぎます（${Math.floor(OUTBOUND_UPLOAD_LIMIT / 1024 / 1024)}MB まで）`);
  const id = randomUUID();
  const dir = dirOf(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'data'), data);
  const meta: UploadMeta = { filename: name, mime: mime || null, size: data.length, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  return { id, name, size: data.length };
}

export function readOutboundUpload(id: string): OutboundFile {
  const dir = dirOf(id);
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as UploadMeta;
    return { filename: meta.filename, mime: meta.mime, data: fs.readFileSync(path.join(dir, 'data')) };
  } catch {
    throw new Error('添付したファイルが見つかりません。もう一度ファイルを選んでください');
  }
}

export function removeOutboundUploads(ids: string[]): void {
  for (const id of ids) {
    try {
      fs.rmSync(dirOf(id), { recursive: true, force: true });
    } catch (err) {
      logger.warn({ err, id }, '添付ファイルの一時置き場を消せませんでした');
    }
  }
}

/**
 * 送らずに残った一時ファイルを片付ける（選んだまま送らなかった・画面で外したもの）。
 * まだ送っていない送信予約（失敗して送り直せるものを含む）が使うファイルは残す
 */
export function pruneOutboundUploads(maxAgeDays = 7): number {
  const dir = outboxDir();
  if (!fs.existsSync(dir)) return 0;
  const keep = new Set<string>();
  for (const r of db().select({ payload: schema.scheduledMessages.payload }).from(schema.scheduledMessages).where(inArray(schema.scheduledMessages.status, ['pending', 'sending', 'failed'])).all()) {
    for (const id of (r.payload as { uploadIds?: string[] } | null)?.uploadIds ?? []) keep.add(id);
  }
  const cutoff = Date.now() - maxAgeDays * 86400_000;
  let n = 0;
  for (const id of fs.readdirSync(dir)) {
    if (keep.has(id) || !ID_RE.test(id)) continue;
    const st = fs.statSync(path.join(dir, id));
    if (st.mtimeMs >= cutoff) continue;
    fs.rmSync(path.join(dir, id), { recursive: true, force: true });
    n++;
  }
  return n;
}
