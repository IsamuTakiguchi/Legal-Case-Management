import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { db, schema } from '../db/index.js';
import { isConfigured } from '../config.js';
import { storage } from '../integrations/storage.js';
import { joinPath } from '../integrations/onedrive.js';
import { generateStructuredFromContent } from '../integrations/anthropic.js';
import { getSetting } from './settings.js';
import { upsertAlert } from './alerts.js';
import { attachmentBytes, attachmentPolicy, clientFolder, processAttachment, removeStaged, stageAttachment, storedFilename, unassignedFolder } from './attachments.js';
import { sanitizeSuggestedName } from './fileNaming.js';
import { writePreviewCache } from './previewCache.js';
import { syncClientFolderName } from './clientFolders.js';
import { CHANNEL_LABEL, type Channel } from '@lcm/shared';
import { logger } from '../logger.js';

/**
 * 依頼者などから続けて届いた画像（通帳の各ページ、LINE のトーク履歴のスクリーンショットなど）が
 * ひとまとまりの資料なら、1 つの PDF にまとめて依頼者フォルダに保存する。
 *
 * 受信した画像はすぐには保存せず、その会話で画像が届かなくなってしばらくしてから（続きが届き終わってから）、
 * AI に「どれとどれが同じ資料か・どの順番か」を判断させてまとめる。まとめないものは今までどおり 1 枚ずつ保存する。
 */

type AttachmentRow = typeof schema.attachments.$inferSelect;
type MessageRow = typeof schema.messages.$inferSelect;

/** 画像が届かなくなってから、まとめる判断を始めるまでの待ち時間 */
export const MERGE_QUIET_MS = 90_000;
/** これ以上あいて届いた画像は、別の送信とみなす */
export const MERGE_GAP_MS = 10 * 60_000;
/** 1 回の判断で AI に見せる画像の上限 */
const MAX_PER_PLAN = 20;
/** AI に見せられる画像の大きさの上限（API の上限 5MB 未満） */
const MAX_IMAGE = 4_500_000;

/** まとめる機能が有効か（設定で止められる。AI が使えないときはまとめない） */
export function mergeEnabled(): boolean {
  return getSetting('attachment_merge') !== '0' && isConfigured('anthropic');
}

/** PDF にできる画像か（JPEG・PNG） */
export function imageKind(att: { filename: string; mime: string | null }): 'jpg' | 'png' | null {
  const ext = (att.filename.split('.').pop() ?? '').toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg' || att.mime === 'image/jpeg') return 'jpg';
  if (ext === 'png' || att.mime === 'image/png') return 'png';
  return null;
}

/** 受信した添付を、まとめる判断のために待たせるか */
export function shouldWaitForMerge(att: { filename: string; mime: string | null }, direction: string): boolean {
  return direction === 'in' && !!imageKind(att) && mergeEnabled();
}

/**
 * まとめる判断まで待たせる。LINE は届いた画像を後から取れなくなることがあるので、先に控えを取っておく
 */
export async function holdForMerge(att: AttachmentRow, channel: Channel): Promise<void> {
  db()
    .update(schema.attachments)
    .set({ channelRef: { ...(att.channelRef as Record<string, unknown>), mergeWait: true } })
    .where(eq(schema.attachments.id, att.id))
    .run();
  if (channel === 'line') {
    const fresh = db().select().from(schema.attachments).where(eq(schema.attachments.id, att.id)).get()!;
    await stageAttachment(fresh, channel).catch((err) => logger.warn({ err, attachmentId: att.id }, '受信画像の控えの取得に失敗（まとめるときに取り直します）'));
  }
}

function clearWait(att: AttachmentRow) {
  const ref = { ...(att.channelRef as Record<string, unknown>) };
  delete ref.mergeWait;
  db().update(schema.attachments).set({ channelRef: ref }).where(eq(schema.attachments.id, att.id)).run();
  return { ...att, channelRef: ref };
}

/** 1 枚ずつの画像を、順番どおりに 1 ページずつ並べた PDF にする（A4。横長の画像は横向きのページ） */
export async function imagesToPdf(images: { data: Buffer; kind: 'jpg' | 'png' }[], title: string): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator('T-Lex');
  const A4: [number, number] = [595.28, 841.89];
  const margin = 18;
  for (const img of images) {
    const embedded = img.kind === 'png' ? await pdf.embedPng(img.data) : await pdf.embedJpg(img.data);
    const landscape = embedded.width > embedded.height;
    const [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
    const scale = Math.min((pw - margin * 2) / embedded.width, (ph - margin * 2) / embedded.height);
    const w = embedded.width * scale;
    const h = embedded.height * scale;
    const page = pdf.addPage([pw, ph]);
    page.drawImage(embedded, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return Buffer.from(await pdf.save());
}

const planSchema = z.object({
  groups: z
    .array(
      z.object({
        images: z.array(z.number().int()).describe('このまとまりに入る画像の番号（1 始まり）。資料として読む順（ページ順・時系列順）に並べる'),
        unified: z.boolean().describe('2 枚以上がひと続きの 1 つの資料（同じ通帳の各ページ、同じトークのスクリーンショットの続き、同じ書類の各ページなど）なら true。別々の写真・別々の書類なら false'),
        name: z.string().describe('まとめた資料のファイル名（拡張子なし、10〜25 字の日本語。例: 預金通帳_ゆうちょ銀行、LINEトーク履歴_相手方とのやり取り、給与明細_2026年1月〜6月）'),
      }),
    )
    .describe('すべての画像をどれか 1 つのまとまりに入れる。まとめないものは 1 枚だけのまとまりにする'),
});

export interface MergePlanGroup {
  ids: number[];
  unified: boolean;
  name: string;
}

/**
 * AI に画像を見せて、どれとどれが 1 つの資料か・どの順番かを決めてもらう。
 * 番号の重複や漏れがあれば、漏れた画像は 1 枚ずつのまとまりにする
 */
export async function planMerge(items: { id: number; data: Buffer; kind: 'jpg' | 'png' }[], context: { body: string | null; senderName: string | null; clientName: string | null; channel: string }): Promise<MergePlanGroup[]> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  items.forEach((it, i) => {
    content.push({ type: 'text', text: `【画像 ${i + 1}】` });
    content.push({ type: 'image', source: { type: 'base64', media_type: it.kind === 'png' ? 'image/png' : 'image/jpeg', data: it.data.toString('base64') } });
  });
  content.push({
    type: 'text',
    text: [`チャネル: ${context.channel}`, context.clientName ? `依頼者: ${context.clientName}` : '', context.senderName ? `送信者: ${context.senderName}` : '', context.body ? `一緒に届いたメッセージ:\n${context.body.slice(0, 1500)}` : '', `画像は全部で ${items.length} 枚（届いた順）`]
      .filter(Boolean)
      .join('\n'),
  });
  const r = await generateStructuredFromContent({
    purpose: '受信画像のまとめ判定',
    tier: 'light',
    system: [
      '法律事務所の事務補助者として、依頼者などから続けて届いた画像を、資料として整理します。',
      '同じ 1 つの資料の各部分（預金通帳の続きのページ、LINE などのトーク履歴を上から順に撮ったスクリーンショット、複数ページの書類・契約書・明細の各ページ）は 1 つにまとめ、unified=true にします。',
      '並び順は、資料として読む順にします（通帳は日付・ページ順、トーク履歴は時系列順、書類はページ番号順）。届いた順と違っていれば並べ替えます。',
      '別々の資料（事故現場の写真と診断書、別の通帳、無関係のスクリーンショット）は別のまとまりにします。写真は、同じ物を写した複数枚でも、資料として 1 冊にする意味がなければまとめません（unified=false で 1 枚ずつ）。',
      '迷うときはまとめません。すべての画像を、どれか 1 つのまとまりにちょうど 1 回だけ入れてください。',
      'name には、人名や口座番号などの個人情報を入れず、資料の種類が分かる名前を付けます。',
    ].join('\n'),
    content,
    schema: planSchema,
    effort: 'low',
    maxTokens: 2000,
  });
  const seen = new Set<number>();
  const out: MergePlanGroup[] = [];
  for (const g of r.groups) {
    const ids = g.images.filter((n) => n >= 1 && n <= items.length && !seen.has(n)).map((n) => (seen.add(n), items[n - 1]!.id));
    if (!ids.length) continue;
    const name = sanitizeSuggestedName(g.name) || '受信資料';
    out.push({ ids, unified: g.unified && ids.length >= 2, name });
  }
  items.forEach((it, i) => {
    if (!seen.has(i + 1)) out.push({ ids: [it.id], unified: false, name: '' });
  });
  return out;
}

/**
 * 指定した画像を、この順番で 1 つの PDF にまとめて保存する。
 * 依頼者が分かれば依頼者フォルダ、分からなければ未振分フォルダに保存する。
 * まとめた画像はそれぞれ「保存済み（PDF の n ページ目）」になる
 */
export async function mergeAttachmentsToPdf(ids: number[], name: string, opts: { clientId?: number | null } = {}): Promise<{ path: string; pages: number; filename: string }> {
  const d = db();
  if (ids.length < 2) throw new Error('PDF にまとめるには、画像を 2 つ以上選んでください');
  const rows = d.select().from(schema.attachments).where(inArray(schema.attachments.id, ids)).all();
  const atts = ids.map((id) => rows.find((r) => r.id === id)).filter((a): a is AttachmentRow => !!a);
  if (atts.length !== ids.length) throw new Error('見つからないファイルがあります');
  for (const a of atts) {
    if (!imageKind(a)) throw new Error(`「${a.filename}」は PDF にまとめられません（JPEG・PNG の画像だけまとめられます）`);
    if (a.status === 'stored' || a.status === 'ignored' || a.status === 'unassigned') throw new Error(`「${a.filename}」はすでに保存済みか不要にしたファイルです。まとめられるのは、まだ保存していないファイルだけです`);
  }
  const msgs = d.select().from(schema.messages).where(inArray(schema.messages.id, [...new Set(atts.map((a) => a.messageId))])).all();
  const msgOf = (a: AttachmentRow) => msgs.find((m) => m.id === a.messageId) as MessageRow;
  const first = msgOf(atts[0]!);
  const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, first.conversationId)).get();
  const clientId = opts.clientId ?? atts.find((a) => a.clientId)?.clientId ?? conv?.clientId ?? null;
  if (clientId) await syncClientFolderName(clientId).catch(() => null);
  const client = clientId ? (d.select().from(schema.clients).where(eq(schema.clients.id, clientId)).get() ?? null) : null;

  // ほかの処理が取得中のものがあれば、まとめない（二重保存の防止）
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  const now = new Date().toISOString();
  const claimed = d
    .update(schema.attachments)
    .set({ processingAt: now })
    .where(and(inArray(schema.attachments.id, ids), or(isNull(schema.attachments.processingAt), lt(schema.attachments.processingAt, stale))))
    .returning({ id: schema.attachments.id })
    .all();
  if (claimed.length !== ids.length) {
    d.update(schema.attachments).set({ processingAt: null }).where(and(inArray(schema.attachments.id, claimed.map((c) => c.id)), eq(schema.attachments.processingAt, now))).run();
    throw new Error('別の処理が取得中のファイルがあります。少し待ってからやり直してください');
  }
  try {
    const images: { data: Buffer; kind: 'jpg' | 'png' }[] = [];
    for (const a of atts) images.push({ data: await attachmentBytes(a, msgOf(a).channel as Channel), kind: imageKind(a)! });
    const title = sanitizeSuggestedName(name) || '受信資料';
    const pdf = await imagesToPdf(images, title);
    const filename = storedFilename(first.channel as Channel, first.sentAt, `${title}.pdf`);
    const folder = client ? joinPath(clientFolder(client), getSetting('attachment_subfolder')) : unassignedFolder();
    const stored = await storage().put(folder, filename, pdf, { dedupe: true });
    atts.forEach((a, i) => {
      const ref = { ...(a.channelRef as Record<string, unknown>) };
      delete ref.mergeWait;
      ref.mergedInto = { name: filename, page: i + 1, pages: atts.length };
      d.update(schema.attachments)
        .set({ status: client ? 'stored' : 'unassigned', storedPath: stored.path, driveItemId: stored.itemId ?? null, clientId: client?.id ?? null, error: null, channelRef: ref })
        .where(eq(schema.attachments.id, a.id))
        .run();
      // 会話の画面のプレビューは、まとめた後も元の画像を出す
      writePreviewCache(a.id, images[i]!.data);
      removeStaged({ id: a.id, channelRef: ref });
    });
    if (!client) {
      upsertAlert({
        type: 'unassigned_file',
        dedupeKey: `unassigned_file:${atts[0]!.id}`,
        title: `振り分け待ちのファイル: ${filename}（${CHANNEL_LABEL[first.channel as Channel]}・画像 ${atts.length} 枚を PDF にまとめたもの）`,
        body: `送信者: ${first.senderName ?? conv?.counterpartName ?? '不明'}`,
        payload: { attachmentId: atts[0]!.id, conversationId: first.conversationId },
      });
    }
    logger.info({ ids, path: stored.path, pages: atts.length }, '受信画像を 1 つの PDF にまとめて保存しました');
    return { path: stored.path, pages: atts.length, filename };
  } finally {
    d.update(schema.attachments).set({ processingAt: null }).where(inArray(schema.attachments.id, ids)).run();
  }
}

/**
 * 待たせている受信画像を、会話ごと・続けて届いたひとまとまりごとに処理する（毎分のジョブ）。
 * まだ画像が届いている最中の会話は次の回に回す
 */
export async function processMergeQueue(opts: { now?: number; quietMs?: number } = {}): Promise<{ merged: number; pages: number; single: number }> {
  const now = opts.now ?? Date.now();
  const quietMs = opts.quietMs ?? MERGE_QUIET_MS;
  const d = db();
  const waiting = d
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.status, 'pending'))
    .all()
    .filter((a) => (a.channelRef as { mergeWait?: boolean }).mergeWait);
  const result = { merged: 0, pages: 0, single: 0 };
  if (!waiting.length) return result;
  const msgs = d.select().from(schema.messages).where(inArray(schema.messages.id, [...new Set(waiting.map((a) => a.messageId))])).all();
  const byConv = new Map<number, { att: AttachmentRow; msg: MessageRow }[]>();
  for (const att of waiting) {
    const msg = msgs.find((m) => m.id === att.messageId);
    if (!msg) continue;
    const list = byConv.get(msg.conversationId) ?? [];
    list.push({ att, msg });
    byConv.set(msg.conversationId, list);
  }
  for (const [conversationId, list] of byConv) {
    // まだ届いている最中なら待つ
    const newest = Math.max(...list.map((x) => new Date(x.att.createdAt).getTime()));
    if (now - newest < quietMs) continue;
    list.sort((a, b) => a.msg.sentAt.localeCompare(b.msg.sentAt) || a.att.id - b.att.id);
    // 間があいたところで区切る（別の機会に送られたものは混ぜない）
    const runs: (typeof list)[] = [];
    for (const x of list) {
      const last = runs[runs.length - 1];
      if (last && new Date(x.msg.sentAt).getTime() - new Date(last[last.length - 1]!.msg.sentAt).getTime() <= MERGE_GAP_MS) last.push(x);
      else runs.push([x]);
    }
    const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get();
    for (const run of runs) {
      const atts = run.map((x) => clearWait(x.att));
      const clientId = atts.find((a) => a.clientId)?.clientId ?? conv?.clientId ?? null;
      const policy = attachmentPolicy();
      // 保存しない設定（手動・依頼者不明）のときは、今までどおり 1 枚ずつ「未保存」にする
      const canSave = policy === 'auto' || (policy === 'client_only' && !!clientId);
      if (atts.length < 2 || !canSave || !mergeEnabled()) {
        for (const a of atts) await processAttachment(a.id).catch((err) => logger.warn({ err, attachmentId: a.id }, '受信画像の保存に失敗'));
        result.single += atts.length;
        continue;
      }
      const client = clientId ? (d.select().from(schema.clients).where(eq(schema.clients.id, clientId)).get() ?? null) : null;
      for (let i = 0; i < atts.length; i += MAX_PER_PLAN) {
        const chunk = atts.slice(i, i + MAX_PER_PLAN);
        const items: { id: number; data: Buffer; kind: 'jpg' | 'png' }[] = [];
        const rest: AttachmentRow[] = [];
        for (const a of chunk) {
          try {
            const data = await attachmentBytes(a, run[0]!.msg.channel as Channel);
            if (data.length > MAX_IMAGE) rest.push(a);
            else items.push({ id: a.id, data, kind: imageKind(a)! });
          } catch (err) {
            logger.warn({ err, attachmentId: a.id }, '受信画像の取得に失敗（まとめずに保存を試みます）');
            rest.push(a);
          }
        }
        let plan: MergePlanGroup[] = items.map((it) => ({ ids: [it.id], unified: false, name: '' }));
        if (items.length >= 2) {
          const bodies = [...new Set(run.map((x) => x.msg.body).filter((b) => b && b.trim()))].join('\n');
          try {
            plan = await planMerge(items, { body: bodies || null, senderName: run[0]!.msg.senderName, clientName: client?.name ?? null, channel: run[0]!.msg.channel });
          } catch (err) {
            logger.warn({ err, conversationId }, '受信画像のまとめ判定に失敗（1 枚ずつ保存します）');
          }
        }
        for (const g of plan) {
          if (g.unified && g.ids.length >= 2) {
            try {
              const r = await mergeAttachmentsToPdf(g.ids, g.name, { clientId });
              result.merged++;
              result.pages += r.pages;
              continue;
            } catch (err) {
              logger.warn({ err, ids: g.ids }, '受信画像の PDF へのまとめに失敗（1 枚ずつ保存します）');
            }
          }
          for (const id of g.ids) await processAttachment(id).catch((err) => logger.warn({ err, attachmentId: id }, '受信画像の保存に失敗'));
          result.single += g.ids.length;
        }
        for (const a of rest) await processAttachment(a.id).catch((err) => logger.warn({ err, attachmentId: a.id }, '受信画像の保存に失敗'));
        result.single += rest.length;
      }
    }
  }
  return result;
}

/**
 * 受信ファイル画面で選んだ画像を、届いた順（同時なら選んだ順）に 1 つの PDF にまとめて保存する。
 * 名前を入れなければ、AI が中身から付ける（AI が使えなければ「受信資料」）
 */
export async function mergeSelectedAttachments(ids: number[], opts: { name?: string | null; clientId?: number | null } = {}) {
  const d = db();
  const rows = d.select().from(schema.attachments).where(inArray(schema.attachments.id, ids)).all();
  const msgs = d.select().from(schema.messages).where(inArray(schema.messages.id, [...new Set(rows.map((r) => r.messageId))])).all();
  const sentAt = (a: AttachmentRow) => msgs.find((m) => m.id === a.messageId)?.sentAt ?? '';
  const ordered = ids
    .map((id) => rows.find((r) => r.id === id))
    .filter((a): a is AttachmentRow => !!a)
    .sort((a, b) => sentAt(a).localeCompare(sentAt(b)) || ids.indexOf(a.id) - ids.indexOf(b.id));
  let name = opts.name?.trim() || '';
  if (!name && isConfigured('anthropic')) {
    try {
      const items: { id: number; data: Buffer; kind: 'jpg' | 'png' }[] = [];
      for (const a of ordered.slice(0, MAX_PER_PLAN)) {
        const kind = imageKind(a);
        const msg = msgs.find((m) => m.id === a.messageId);
        if (!kind || !msg) continue;
        const data = await attachmentBytes(a, msg.channel as Channel);
        if (data.length <= MAX_IMAGE) items.push({ id: a.id, data, kind });
      }
      if (items.length) {
        const plan = await planMerge(items, { body: null, senderName: msgs[0]?.senderName ?? null, clientName: null, channel: msgs[0]?.channel ?? '' });
        name = plan.find((g) => g.name)?.name ?? '';
      }
    } catch (err) {
      logger.warn({ err }, 'まとめた PDF の名前の提案に失敗');
    }
  }
  return mergeAttachmentsToPdf(
    ordered.map((a) => a.id),
    name || '受信資料',
    { clientId: opts.clientId ?? null },
  );
}
