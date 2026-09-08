import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { generateStructuredFromContent } from '../integrations/anthropic.js';
import { isConfigured } from '../config.js';
import { extractText } from './forms.js';
import { logger } from '../logger.js';

/**
 * LINE や Gmail から届くファイルは「image_123.jpg」「S__12345.jpg」「IMG_0001.jpg」「document.pdf」のような
 * 中身の分からない名前が多い。そうした名前を判定し、中身（画像・PDF の内容やメッセージ本文）から
 * 意味の分かる日本語の名前を付け直す。
 */

const GENERIC_STEMS = /^(image|img|video|audio|file|files?_\d*|photo|pic|picture|scan|scanned|document|doc|attachment|untitled|new|無題|写真|画像|動画|音声|ファイル|スクリーンショット|screenshot|screen ?shot|受信|添付|line|s|p|dsc|dscf|dscn|pxl|mvimg|fb_img|received|download|noname|名称未設定|figure|slide)$/i;

/** 名前から中身が分からないか（付け直しの対象か） */
export function isGenericFilename(filename: string): boolean {
  const base = filename.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).trim();
  if (!stem) return true;
  // 記号・数字・アンダースコアだけ
  if (/^[\d\s_\-.()（）\[\]#~+]+$/.test(stem)) return true;
  // 英字の短い接頭辞 + 数字（IMG_0001, S__1234, DSC01234, image_12345 など）
  const m = stem.match(/^([A-Za-z\u3040-\u30ff\u4e00-\u9fff ]{0,14}?)[\s_\-]*[\d_\-\s.()]{2,}$/);
  if (m && (m[1] === '' || GENERIC_STEMS.test(m[1].trim()))) return true;
  // 接頭辞だけ（image.jpg, scan.pdf, 写真.jpg）
  if (GENERIC_STEMS.test(stem)) return true;
  // UUID / ハッシュ風
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stem) || /^[0-9a-f]{16,}$/i.test(stem)) return true;
  // 日時だけ（20260908_123456, 2026-09-08 12.34.56 など）
  if (/^\d{4}[-_.]?\d{2}[-_.]?\d{2}[\s_\-T]*[\d.:_\-]*$/.test(stem)) return true;
  return false;
}

/** 名前に使えない文字を落とし、空白は _ にして 40 字までに */
export function sanitizeSuggestedName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/[\s\u3000]+/g, '_')
    .replace(/^[_.\-]+|[_.\-]+$/g, '')
    .slice(0, 40);
}

export interface NamingContext {
  channel: string;
  subject?: string | null;
  body?: string | null;
  senderName?: string | null;
  clientName?: string | null;
  sentAt?: string | null;
}

const nameSchema = z.object({
  name: z.string().describe('ファイル名（拡張子なし、10〜25 字の日本語、記号は使わない。例: 診断書、事故現場の写真、給与明細_2026年8月、賃貸借契約書、相手方からの通知書）'),
  confident: z.boolean().describe('中身やメッセージから内容が十分に分かり、この名前で保存してよいか。分からなければ false'),
});

const IMAGE_MIME: Record<string, 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const MAX_IMAGE = 4_500_000; // API の画像上限 5MB 未満
const MAX_PDF = 10_000_000;

/**
 * 中身を読んで、意味の分かる名前（拡張子なし）を提案する。分からなければ null。
 * 画像は画像として、PDF は文書として渡し、Word・Excel は本文を抜き出して渡す。それ以外はメッセージの文脈だけで判断する
 */
export async function suggestFilename(input: { data: Buffer; filename: string; mime: string | null; context: NamingContext }): Promise<string | null> {
  if (!isConfigured('anthropic')) return null;
  const ext = (input.filename.split('.').pop() ?? '').toLowerCase();
  const content: Anthropic.ContentBlockParam[] = [];
  let howShown = 'メッセージの文脈のみ';
  const imageMime = IMAGE_MIME[ext] ?? (input.mime && /^image\/(jpeg|png|gif|webp)$/.test(input.mime) ? (input.mime as (typeof IMAGE_MIME)[string]) : null);
  if (imageMime && input.data.length <= MAX_IMAGE) {
    content.push({ type: 'image', source: { type: 'base64', media_type: imageMime, data: input.data.toString('base64') } });
    howShown = '画像';
  } else if (ext === 'pdf' && input.data.length <= MAX_PDF) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.data.toString('base64') } });
    howShown = 'PDF';
  } else if (/^(docx|xlsx|xlsm|txt|pdf)$/.test(ext)) {
    try {
      const text = (await extractText(input.filename, input.data)).trim().slice(0, 8000);
      if (text) {
        content.push({ type: 'text', text: `【ファイル本文（先頭）】\n${text}` });
        howShown = '本文の抜粋';
      }
    } catch (err) {
      logger.debug({ err, filename: input.filename }, '本文抽出をスキップ');
    }
  }
  const c = input.context;
  const ctxLines = [
    `チャネル: ${c.channel}`,
    c.clientName ? `依頼者: ${c.clientName}` : '',
    c.senderName ? `送信者: ${c.senderName}` : '',
    c.subject ? `件名: ${c.subject}` : '',
    c.sentAt ? `受信日時: ${c.sentAt}` : '',
    c.body ? `メッセージ本文:\n${c.body.slice(0, 1500)}` : '',
    `元のファイル名: ${input.filename}`,
  ].filter(Boolean);
  content.push({ type: 'text', text: `【添付の提示方法】${howShown}\n\n${ctxLines.join('\n')}` });
  try {
    const r = await generateStructuredFromContent({
      system: [
        '法律事務所の事務補助者として、依頼者などから届いた添付ファイルに、後で探しやすい日本語のファイル名を付けます。',
        '中身（画像・文書）とメッセージの文脈から、書類の種類や写っているものを具体的に表す名前にします。例: 診断書、交通事故証明書、事故現場の写真（交差点）、給与明細_2026年8月、賃貸借契約書、相手方からの通知書、車両損傷写真_前部。',
        '人名や個人番号など不要な個人情報は入れません。日付は分かるときだけ「2026年8月」のように添えます。拡張子や記号（/ \\ : * ? " < > |）は使いません。',
        '中身が読み取れず文脈からも分からない（例: 何の写真か判別できない）ときは confident=false にします。',
      ].join('\n'),
      content,
      schema: nameSchema,
      effort: 'low',
      maxTokens: 500,
    });
    if (!r.confident) return null;
    const name = sanitizeSuggestedName(r.name);
    return name.length >= 2 ? name : null;
  } catch (err) {
    logger.warn({ err, filename: input.filename }, 'ファイル名の提案に失敗');
    return null;
  }
}
