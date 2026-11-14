import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-attsug-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.STORAGE_BACKEND = 'local';
process.env.LOCAL_CLIENT_ROOT = path.join(tmp, 'clients');
process.env.DATA_DIR = tmp;

let requested = true;
const seen: { purpose: string; user: string }[] = [];
vi.mock('../integrations/anthropic.js', async (orig) => ({
  ...(await orig<typeof import('../integrations/anthropic.js')>()),
  generateStructured: vi.fn(async (opts: { purpose: string; user: string }) => {
    seen.push({ purpose: opts.purpose, user: opts.user });
    if (opts.purpose === '資料の提供依頼の読み取り') return requested ? { requested: true, items: [{ what: '訴状の写し', keywords: ['訴状'] }, { what: '和解案', keywords: ['和解'] }] } : { requested: false, items: [] };
    // 一覧から「訴状」の行の番号を選ぶ（和解案は無い）
    const line = opts.user.split('\n').find((l) => /^\d+: .*訴状/.test(l))!;
    return { picks: [{ index: Number(line.split(':')[0]), reason: '訴状の写し' }], note: '和解案は見つかりませんでした' };
  }),
}));

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { suggestRequestedFiles } = await import('../services/attachmentSuggest.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

function seed() {
  const root = path.join(tmp, 'clients', '山田太郎');
  fs.mkdirSync(path.join(root, '提出書面'), { recursive: true });
  fs.mkdirSync(path.join(root, '受信'), { recursive: true });
  fs.writeFileSync(path.join(root, '提出書面', '20261001_訴状.pdf'), 'x');
  fs.writeFileSync(path.join(root, '受信', '20261005_gmail_通帳.jpg'), 'x');
  fs.writeFileSync(path.join(root, 'メモ.bin'), 'x');
  const client = db().insert(schema.clients).values({ name: '山田 太郎', onedriveFolderPath: '山田太郎' }).returning().get();
  const conv = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: `t-${Math.random()}`, clientId: client.id, counterpartName: '山田 太郎' }).returning().get();
  const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  db().insert(schema.messages).values({ conversationId: conv.id, channel: 'gmail', externalId: `m-${Math.random()}`, direction: 'out', body: 'ご連絡します', sentAt: at(60) }).run();
  db().insert(schema.messages).values({ conversationId: conv.id, channel: 'gmail', externalId: `m-${Math.random()}`, direction: 'in', body: '訴状の写しと和解案を送ってください', sentAt: at(5) }).run();
  return { client, conv };
}

describe('資料の提供依頼への添付の候補', () => {
  it('頼まれた資料を依頼者フォルダ（下のフォルダも）から探して返す。見つからない資料は一言添える', async () => {
    const { conv } = seed();
    const r = await suggestRequestedFiles(conv.id);
    expect(r.requested).toEqual(['訴状の写し', '和解案']);
    expect(r.files.map((f) => f.name)).toEqual(['20261001_訴状.pdf']);
    expect(r.files[0]!.reason).toBe('訴状の写し');
    expect(r.note).toContain('和解案');
    // AI に見せた一覧には、添付できない種類（.bin）は入らない
    const listed = seen.find((x) => x.purpose === '提供を求められた資料のファイル選び')!.user;
    expect(listed).toContain('訴状.pdf');
    expect(listed).toContain('通帳.jpg');
    expect(listed).not.toContain('メモ.bin');
    // 最後の受信だけを読む（こちらが送った「ご連絡します」より前は読まない）
    expect(seen.find((x) => x.purpose === '資料の提供依頼の読み取り')!.user).not.toContain('ご連絡します');
  });

  it('資料を頼まれていなければ、何も探さない', async () => {
    requested = false;
    seen.length = 0;
    const { conv } = seed();
    const r = await suggestRequestedFiles(conv.id);
    expect(r.files).toEqual([]);
    expect(seen.map((x) => x.purpose)).toEqual(['資料の提供依頼の読み取り']);
    requested = true;
  });
});
