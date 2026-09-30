import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-preview-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

/** 取りに行った回数（控えが効いているかを見る） */
const fetched: number[] = [];
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
/** 取得にかかる時間と、同時に取りに行った数 */
const slow = { ms: 0, now: 0, max: 0 };
vi.mock('../services/attachments.js', async (importActual) => {
  const actual = await importActual<typeof import('../services/attachments.js')>();
  return {
    ...actual,
    fetchAttachmentData: vi.fn(async (id: number) => {
      fetched.push(id);
      slow.now++;
      slow.max = Math.max(slow.max, slow.now);
      try {
        if (slow.ms) await new Promise((r) => setTimeout(r, slow.ms));
        return { data: PNG, filename: 'x', mime: null };
      } finally {
        slow.now--;
      }
    }),
  };
});

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { imagePreviewMime } = await import('@lcm/shared');
const { createApp } = await import('../index.js');
const { attachmentPreview, previewLimits } = await import('../services/attachmentPreview.js');
const { setPassword } = await import('../auth/index.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

describe('画像の種類の見分け', () => {
  it('画像の種類か拡張子で見分け、SVG やテキストは画像として扱わない', () => {
    expect(imagePreviewMime('photo.JPG', null)).toBe('image/jpeg');
    expect(imagePreviewMime('IMG_0001', 'image/png')).toBe('image/png');
    expect(imagePreviewMime('a.jpg', 'image/jpg')).toBe('image/jpeg');
    expect(imagePreviewMime('scan.heic', 'application/octet-stream')).toBe('image/heic');
    expect(imagePreviewMime('a.webp', 'image/webp; charset=binary')).toBe('image/webp');
    expect(imagePreviewMime('logo.svg', 'image/svg+xml')).toBeNull();
    expect(imagePreviewMime('logo.svg', null)).toBeNull();
    expect(imagePreviewMime('fake.png', 'text/html')).toBeNull();
    expect(imagePreviewMime('書面.pdf', 'application/pdf')).toBeNull();
    expect(imagePreviewMime('書面.pdf', null)).toBeNull();
  });
});

describe('画像のプレビュー', () => {
  it('画像はその場で表示できる形で返し、2 回目は控えから返す。画像以外・不要にしたものは返さない', async () => {
    const app = createApp();
    setPassword('preview-test');
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'preview-test' }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const get = (id: number) => app.request(`/api/attachments/${id}/preview`, { headers: { cookie } });

    const conv = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'U1', lastMessageAt: '2027-09-01T01:00:00.000Z' }).returning().get();
    const msg = db().insert(schema.messages).values({ conversationId: conv.id, channel: 'line', externalId: 'm1', direction: 'in', body: '[画像]', sentAt: '2027-09-01T01:00:00.000Z' }).returning().get();
    const add = (filename: string, mime: string | null, status = 'held') => db().insert(schema.attachments).values({ messageId: msg.id, filename, mime, status }).returning().get().id;
    const img = add('image_1.jpg', null);
    const pdf = add('書面.pdf', 'application/pdf');
    const svg = add('logo.svg', 'image/svg+xml');
    const gone = add('不要.png', 'image/png', 'ignored');

    const r1 = await get(img);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('content-type')).toBe('image/jpeg');
    expect(r1.headers.get('content-disposition')).toBe('inline');
    expect(r1.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await r1.arrayBuffer())).toEqual(PNG);
    expect(fetched).toEqual([img]);
    // 2 回目は取りに行かない
    expect((await get(img)).status).toBe(200);
    expect(fetched).toEqual([img]);

    expect((await get(pdf)).status).toBe(415);
    expect((await get(svg)).status).toBe(415);
    expect((await get(gone)).status).toBe(410);
    expect((await get(99999)).status).toBe(404);
    expect(fetched).toEqual([img]);
    // ログインしていなければ見られない
    expect((await app.request(`/api/attachments/${img}/preview`)).status).toBe(401);

    // 「不要」にしたら控えも消し、以後は表示しない
    const cacheFile = path.join(tmp, 'preview-cache', String(img));
    expect(fs.existsSync(cacheFile)).toBe(true);
    const { ignoreAttachment } = await import('../services/attachments.js');
    await ignoreAttachment(img);
    expect(fs.existsSync(cacheFile)).toBe(false);
    expect((await get(img)).status).toBe(410);
  });
});

describe('画像の多い会話を開いたとき', () => {
  const seed = (n: number) => {
    const conv = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: `U-many-${n}`, lastMessageAt: '2027-09-01T01:00:00.000Z' }).returning().get();
    const msg = db().insert(schema.messages).values({ conversationId: conv.id, channel: 'line', externalId: `many-${n}`, direction: 'in', body: '[画像]', sentAt: '2027-09-01T01:00:00.000Z' }).returning().get();
    return Array.from({ length: n }, (_, i) => db().insert(schema.attachments).values({ messageId: msg.id, filename: `p${i}.jpg`, mime: 'image/jpeg', status: 'held' }).returning().get().id);
  };

  it('元に取りに行くのは同時に 2 件まで（OneDrive の混雑や Chatwork の回数制限を招かない）', async () => {
    const ids = seed(6);
    slow.ms = 30;
    slow.max = 0;
    const rs = await Promise.all(ids.map((id) => attachmentPreview(id)));
    expect(rs.every((r) => r.kind === 'ok')).toBe(true);
    expect(slow.max).toBe(2);
    slow.ms = 0;
  });

  it('時間がかかりすぎたら待たずに諦め（503）、取れた画像は次に開いたときすぐ出す', async () => {
    const [id] = seed(1);
    slow.ms = 200;
    previewLimits.timeoutMs = 50;
    expect((await attachmentPreview(id!)).kind).toBe('busy');
    await new Promise((r) => setTimeout(r, 300));
    const before = fetched.length;
    expect((await attachmentPreview(id!)).kind).toBe('ok');
    expect(fetched.length).toBe(before);
    previewLimits.timeoutMs = 45_000;
    slow.ms = 0;
  });
});
