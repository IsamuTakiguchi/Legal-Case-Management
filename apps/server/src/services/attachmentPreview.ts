import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { fetchAttachmentData } from './attachments.js';
import { imagePreviewMime } from '@lcm/shared';
import { readPreviewCache, writePreviewCache } from './previewCache.js';
import { logger } from '../logger.js';

/**
 * 会話画面で画像をその場に表示するためのプレビュー。
 * 毎回 OneDrive や LINE・Chatwork から取り直さないよう、DATA_DIR に控えを置く（古いものから消す）。
 */

/** 画像なら、その Content-Type。画像でなければ null */
export function previewMime(att: { filename: string; mime: string | null }): string | null {
  return imagePreviewMime(att.filename, att.mime);
}

export type PreviewResult = { kind: 'ok'; data: Buffer; mime: string } | { kind: 'not_found' | 'not_image' | 'ignored' | 'busy' };

/**
 * 元（OneDrive・LINE・Chatwork）に取りに行くのは同時に 2 件まで。
 * 画像の多い会話を開くと一度に何十件も頼むことになり、OneDrive の混雑エラーや Chatwork の回数制限を招くため
 */
/** 順番待ちを含めて timeoutMs を過ぎたら諦める（画面はファイル名のリンクだけの表示に戻る） */
export const previewLimits = { maxConcurrent: 2, timeoutMs: 45_000 };
let running = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= previewLimits.maxConcurrent) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function timeout(ms: number): Promise<'timeout'> {
  return new Promise((r) => setTimeout(() => r('timeout'), ms).unref());
}

export async function attachmentPreview(id: number): Promise<PreviewResult> {
  const att = db().select().from(schema.attachments).where(eq(schema.attachments.id, id)).get();
  if (!att) return { kind: 'not_found' };
  if (att.status === 'ignored') return { kind: 'ignored' };
  const mime = previewMime(att);
  if (!mime) return { kind: 'not_image' };
  const cached = readPreviewCache(id);
  if (cached) return { kind: 'ok', data: cached, mime };
  // 時間切れで返したあとも取得は続け、控えに入れておく（次に開いたときはすぐ出る）
  const job = withSlot(async () => readPreviewCache(id) ?? (await fetchAttachmentData(id)).data).then((data) => {
    writePreviewCache(id, data);
    return data;
  });
  const data = await Promise.race([job, timeout(previewLimits.timeoutMs)]);
  if (data === 'timeout') {
    job.catch((err) => logger.warn({ err, id }, '画像プレビューの取得に失敗'));
    return { kind: 'busy' };
  }
  return { kind: 'ok', data, mime };
}
