import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-merge-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.STORAGE_BACKEND = 'local';
process.env.LOCAL_CLIENT_ROOT = path.join(tmp, 'clients');
process.env.ANTHROPIC_API_KEY = 'test-key';

// AI の判断は差し替える（まとめ判定は plans の先頭から順に返す。名前付けは「写真」）
const plans: unknown[] = [];
const seen: { purpose?: string; images: number }[] = [];
vi.mock('../integrations/anthropic.js', async (orig) => ({
  ...(await orig<typeof import('../integrations/anthropic.js')>()),
  generateStructuredFromContent: vi.fn(async (opts: { purpose?: string; content: { type: string }[] }) => {
    seen.push({ purpose: opts.purpose, images: opts.content.filter((c) => c.type === 'image').length });
    if (opts.purpose === '受信画像のまとめ判定') return plans.shift();
    return { name: '写真', confident: true };
  }),
}));

/** w×h の単色 PNG（pdf-lib が読める本物の PNG） */
function png(w: number, h: number, shade: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc((w + 1) * h, shade);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0; // filter type
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const IMAGES: Record<string, Buffer> = { p1: png(40, 60, 10), p2: png(40, 60, 20), p3: png(40, 60, 30), photo: png(60, 40, 200), q1: png(30, 30, 50), q2: png(30, 30, 60) };

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { setAdapter } = await import('../channels/registry.js');
const { ingestMessage } = await import('../services/inbox.js');
const { processMergeQueue, mergeSelectedAttachments, imageKind } = await import('../services/attachmentMerge.js');
const { fetchAttachmentData } = await import('../services/attachments.js');
const { setSetting } = await import('../services/settings.js');
const { PDFDocument } = await import('pdf-lib');
const { eq, inArray } = await import('drizzle-orm');

beforeAll(() => {
  openTestDatabase();
  setAdapter('line', {
    channel: 'line',
    isConfigured: () => true,
    fetchAttachment: async ({ ref }: { ref: Record<string, unknown> }) => IMAGES[String(ref.key)]!,
    send: async () => ({ externalId: 'x', externalThreadId: 'x', sentAt: new Date().toISOString() }),
  });
});
afterAll(() => closeDatabase());

let seq = 0;
async function lineImage(userId: string, key: string, sentAt: string) {
  seq++;
  const r = await ingestMessage({
    channel: 'line',
    externalThreadId: userId,
    externalId: `img-${seq}`,
    direction: 'in',
    sentAt,
    senderName: '依頼者',
    body: '',
    attachments: [{ filename: `image_${seq}.png`, mime: 'image/png', ref: { key } }],
    identity: { channel: 'line', lineUserId: userId, displayName: '依頼者' },
  });
  // 受信の後ろで控えを取るのを待つ
  await new Promise((res) => setTimeout(res, 20));
  return db().select().from(schema.attachments).where(eq(schema.attachments.messageId, r.message.id)).get()!;
}
const att = (id: number) => db().select().from(schema.attachments).where(eq(schema.attachments.id, id)).get()!;

describe('続けて届いた画像を 1 つの PDF にまとめる', () => {
  it('届き終わるまで待ち、AI がひと続きと判断した画像だけを読む順に 1 つの PDF にして保存する。別の写真は 1 枚ずつ', async () => {
    const client = db().insert(schema.clients).values({ name: '通帳 太郎', lineUserId: 'U-tsucho' }).returning().get();
    const t0 = Date.parse('2026-10-05T01:00:00.000Z');
    const at = (sec: number) => new Date(t0 + sec * 1000).toISOString();
    const a1 = await lineImage('U-tsucho', 'p1', at(0));
    const a2 = await lineImage('U-tsucho', 'p2', at(5));
    const a3 = await lineImage('U-tsucho', 'p3', at(10));
    const a4 = await lineImage('U-tsucho', 'photo', at(20));
    // すぐには保存しない（まとめの判断待ち）。LINE は控えだけ取っておく
    for (const a of [a1, a2, a3, a4]) {
      expect(a.status).toBe('pending');
      expect((a.channelRef as { mergeWait?: boolean }).mergeWait).toBe(true);
      expect((a.channelRef as { stagedFile?: string }).stagedFile).toBeTruthy();
    }
    // まだ届いている最中（最後の受信から 90 秒たっていない）なら何もしない
    expect(await processMergeQueue()).toEqual({ merged: 0, pages: 0, single: 0 });

    plans.push({ groups: [{ images: [2, 1, 3], unified: true, name: '預金通帳_ゆうちょ銀行' }, { images: [4], unified: false, name: '' }] });
    const r = await processMergeQueue({ now: Date.now() + 120_000 });
    expect(r).toEqual({ merged: 1, pages: 3, single: 1 });
    expect(seen.find((s) => s.purpose === '受信画像のまとめ判定')?.images).toBe(4);

    const [m2, m1, m3] = [att(a2.id), att(a1.id), att(a3.id)];
    for (const m of [m1, m2, m3]) {
      expect(m.status).toBe('stored');
      expect(m.storedPath).toBe(m1.storedPath);
      expect(m.storedPath).toContain('20261005_line_預金通帳_ゆうちょ銀行.pdf');
      expect((m.channelRef as { stagedFile?: string }).stagedFile).toBeUndefined();
    }
    expect((m2.channelRef as { mergedInto: { page: number; pages: number } }).mergedInto).toMatchObject({ page: 1, pages: 3 });
    expect((m1.channelRef as { mergedInto: { page: number } }).mergedInto.page).toBe(2);
    const pdf = await PDFDocument.load(fs.readFileSync(path.join(tmp, 'clients', m1.storedPath!)));
    expect(pdf.getPageCount()).toBe(3);
    // 別の写真は 1 枚のまま保存
    const photo = att(a4.id);
    expect(photo.status).toBe('stored');
    expect(photo.storedPath).toMatch(/\.png$/);
    expect(photo.channelRef).not.toHaveProperty('mergedInto');
    // まとめた画像も、会話のプレビューなどでは元の画像を返す
    expect((await fetchAttachmentData(a2.id)).data.equals(IMAGES.p2!)).toBe(true);
  });

  it('保存しない設定のときはまとめずに「未保存」にし、受信ファイル画面で選んでまとめられる', async () => {
    setSetting('attachment_policy', 'manual');
    const t0 = Date.parse('2026-10-05T03:00:00.000Z');
    const b1 = await lineImage('U-other', 'q1', new Date(t0).toISOString());
    const b2 = await lineImage('U-other', 'q2', new Date(t0 + 3000).toISOString());
    const r = await processMergeQueue({ now: Date.now() + 120_000 });
    expect(r).toEqual({ merged: 0, pages: 0, single: 2 });
    expect([att(b1.id).status, att(b2.id).status]).toEqual(['held', 'held']);

    const m = await mergeSelectedAttachments([b2.id, b1.id], { name: 'LINEトーク履歴' });
    expect(m.pages).toBe(2);
    expect(m.filename).toBe('20261005_line_LINEトーク履歴.pdf');
    // 届いた順に並べる（選んだ順ではない）
    expect((att(b1.id).channelRef as { mergedInto: { page: number } }).mergedInto.page).toBe(1);
    // 依頼者が分からないものは未振分フォルダへ
    expect(att(b1.id).status).toBe('unassigned');
    expect(att(b1.id).storedPath).toContain('_未振分');
    // 未振分の PDF を依頼者に振り分けると、まとめた画像すべてが同じ PDF の新しい場所を指す
    const { assignAttachment } = await import('../services/attachments.js');
    const later = db().insert(schema.clients).values({ name: '後から 判明' }).returning().get();
    await assignAttachment(b2.id, later.id);
    expect([att(b1.id).status, att(b2.id).status]).toEqual(['stored', 'stored']);
    expect(att(b1.id).storedPath).toBe(att(b2.id).storedPath);
    expect(att(b1.id).storedPath).toContain('後から 判明');
    expect(fs.existsSync(path.join(tmp, 'clients', att(b1.id).storedPath!))).toBe(true);
    // 未振分の PDF の画像を 1 枚だけ不要にしても、ほかの画像が使っている PDF は消さない
    const { ignoreAttachment } = await import('../services/attachments.js');
    const c1 = await lineImage('U-third', 'q1', new Date(t0 + 60_000).toISOString());
    const c2 = await lineImage('U-third', 'q2', new Date(t0 + 63_000).toISOString());
    await processMergeQueue({ now: Date.now() + 120_000 });
    const m2 = await mergeSelectedAttachments([c1.id, c2.id], { name: '別の資料' });
    expect(att(c1.id).status).toBe('unassigned');
    await ignoreAttachment(c1.id);
    expect(fs.existsSync(path.join(tmp, 'clients', m2.path))).toBe(true);
    await ignoreAttachment(c2.id);
    expect(fs.existsSync(path.join(tmp, 'clients', m2.path))).toBe(false);
    // 保存済みのものは、まとめ直さない
    await expect(mergeSelectedAttachments([b1.id, b2.id], { name: 'x' })).rejects.toThrow('保存済み');
    setSetting('attachment_policy', 'client_only');
  });

  it('JPEG・PNG 以外はまとめない', () => {
    expect(imageKind({ filename: 'a.JPG', mime: null })).toBe('jpg');
    expect(imageKind({ filename: 'scan.pdf', mime: 'application/pdf' })).toBeNull();
    expect(imageKind({ filename: 'IMG_1.HEIC', mime: 'image/heic' })).toBeNull();
    const ids = db().select({ id: schema.attachments.id }).from(schema.attachments).where(inArray(schema.attachments.status, ['stored'])).all();
    expect(ids.length).toBeGreaterThan(0);
  });
});
