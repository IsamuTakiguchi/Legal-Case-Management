import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-upload-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.CHATWORK_API_TOKEN = 'cw-token';

/** Chatwork に送ったもの（実際の送信はしない） */
const posted: { text: string; files: { filename: string; data: Buffer }[] }[] = [];
vi.mock('../channels/chatwork.js', async (importActual) => {
  const actual = await importActual<typeof import('../channels/chatwork.js')>();
  return {
    ...actual,
    chatworkMe: async () => ({ account_id: 1, name: '自分' }),
    chatworkAdapter: {
      ...actual.chatworkAdapter,
      async send(opts: { externalThreadId: string; text: string; files?: { filename: string; data: Buffer }[] }) {
        posted.push({ text: opts.text, files: opts.files ?? [] });
        return { externalId: `cw-${posted.length}`, externalThreadId: opts.externalThreadId, sentAt: new Date().toISOString() };
      },
    },
  };
});

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { sendToConversation } = await import('../services/send.js');
const { saveOutboundUpload, readOutboundUpload, pruneOutboundUploads, OUTBOUND_UPLOAD_LIMIT } = await import('../services/outboundUploads.js');
const { scheduleMessage, dispatchScheduled } = await import('../services/scheduledSend.js');
const { getConversation } = await import('../services/inbox.js');
const { createApp } = await import('../index.js');
const { setPassword } = await import('../auth/index.js');
const { sendMessageSchema } = await import('@lcm/shared');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());
beforeEach(() => {
  posted.length = 0;
});

const outbox = (id: string) => path.join(tmp, 'outbox', id);
const newConv = () => db().insert(schema.conversations).values({ channel: 'chatwork', externalThreadId: String(800 + Math.floor(Math.random() * 1000)), counterpartName: '事務局' }).returning().get();

describe('パソコンから選んだファイルを添付して送る', () => {
  it('選んだファイルを添付して送り、送ったあとは一時置き場から消す。会話には添付した名前が残る', async () => {
    const conv = newConv();
    const up = saveOutboundUpload('C:\\Users\\me\\委任状.pdf', 'application/pdf', Buffer.from('%PDF-1.4 test'));
    expect(up.name).toBe('委任状.pdf');
    expect(fs.existsSync(outbox(up.id))).toBe(true);
    await sendToConversation(conv.id, sendMessageSchema.parse({ text: '委任状をお送りします', uploadIds: [up.id] }));
    expect(posted[0]!.files.map((f) => f.filename)).toEqual(['委任状.pdf']);
    expect(posted[0]!.files[0]!.data.toString()).toBe('%PDF-1.4 test');
    expect(fs.existsSync(outbox(up.id))).toBe(false);
    const out = getConversation(conv.id)!.messages.find((m) => m.direction === 'out')!;
    expect(out.sentFiles).toEqual(['委任状.pdf']);
  });

  it('送信予約では、予約の時刻に添付して送る（それまでは片付けで消さない）', async () => {
    const conv = newConv();
    const up = saveOutboundUpload('見積書.xlsx', null, Buffer.from('xlsx'));
    const s = scheduleMessage(conv.id, sendMessageSchema.parse({ text: '見積書です', uploadIds: [up.id] }), new Date(Date.now() + 3600_000).toISOString());
    // 古くなっても、まだ送っていない予約が使うファイルは残す
    const old = new Date(Date.now() - 30 * 86400_000);
    fs.utimesSync(outbox(up.id), old, old);
    pruneOutboundUploads(7);
    expect(fs.existsSync(outbox(up.id))).toBe(true);
    const r = await dispatchScheduled(s.id, { force: true });
    expect(r.ok).toBe(true);
    expect(posted[0]!.files.map((f) => f.filename)).toEqual(['見積書.xlsx']);
    expect(fs.existsSync(outbox(up.id))).toBe(false);
  });

  it('選んだまま送らなかったファイルは、日が経ったら片付ける', () => {
    const fresh = saveOutboundUpload('新しい.pdf', null, Buffer.from('a'));
    const stale = saveOutboundUpload('古い.pdf', null, Buffer.from('b'));
    const old = new Date(Date.now() - 8 * 86400_000);
    fs.utimesSync(outbox(stale.id), old, old);
    expect(pruneOutboundUploads(7)).toBe(1);
    expect(fs.existsSync(outbox(fresh.id))).toBe(true);
    expect(fs.existsSync(outbox(stale.id))).toBe(false);
  });

  it('見つからないファイルを指定したら、送らずに知らせる', async () => {
    const conv = newConv();
    await expect(sendToConversation(conv.id, sendMessageSchema.parse({ text: '送ります', uploadIds: ['00000000-0000-4000-8000-000000000000'] }))).rejects.toThrow('もう一度ファイルを選んでください');
    expect(posted).toHaveLength(0);
    expect(() => readOutboundUpload('../app.db')).toThrow();
  });

  it('空のファイル・大きすぎるファイルは受け付けない', () => {
    expect(() => saveOutboundUpload('空.txt', null, Buffer.alloc(0))).toThrow('空のファイル');
    expect(() => saveOutboundUpload('大.pdf', null, Buffer.alloc(OUTBOUND_UPLOAD_LIMIT + 1))).toThrow('大きすぎます');
  });

  it('画面から 2MB を超えるファイルも上げられる', async () => {
    const app = createApp();
    setPassword('upload-test');
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'upload-test' }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array(3 * 1024 * 1024)], '証拠写真.jpg', { type: 'image/jpeg' }));
    const res = await app.request('/api/outbound-uploads', { method: 'POST', headers: { cookie }, body: fd });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string; size: number };
    expect(body).toMatchObject({ name: '証拠写真.jpg', size: 3 * 1024 * 1024 });
    expect(readOutboundUpload(body.id).mime).toBe('image/jpeg');
  });
});
