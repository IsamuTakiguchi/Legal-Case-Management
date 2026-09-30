import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { fetchAttachmentData } from './attachments.js';
import { imagePreviewMime } from '@lcm/shared';
import { readPreviewCache, writePreviewCache } from './previewCache.js';

/**
 * 会話画面で画像をその場に表示するためのプレビュー。
 * 毎回 OneDrive や LINE・Chatwork から取り直さないよう、DATA_DIR に控えを置く（古いものから消す）。
 */

/** 画像なら、その Content-Type。画像でなければ null */
export function previewMime(att: { filename: string; mime: string | null }): string | null {
  return imagePreviewMime(att.filename, att.mime);
}

export type PreviewResult = { kind: 'ok'; data: Buffer; mime: string } | { kind: 'not_found' | 'not_image' | 'ignored' };

export async function attachmentPreview(id: number): Promise<PreviewResult> {
  const att = db().select().from(schema.attachments).where(eq(schema.attachments.id, id)).get();
  if (!att) return { kind: 'not_found' };
  if (att.status === 'ignored') return { kind: 'ignored' };
  const mime = previewMime(att);
  if (!mime) return { kind: 'not_image' };
  const cached = readPreviewCache(id);
  if (cached) return { kind: 'ok', data: cached, mime };
  const { data } = await fetchAttachmentData(id);
  writePreviewCache(id, data);
  return { kind: 'ok', data, mime };
}
