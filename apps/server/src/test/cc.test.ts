import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-cc-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.CHATWORK_API_TOKEN = 'cw-token';

/** 各チャネルに送った中身を控える（実際には送らない） */
const sent: { channel: string; to?: string | null; cc?: string[]; bcc?: string[]; text: string }[] = [];
// 送信 ID はテストをまたいで重ならないようにする（同じ ID だと同じメッセージとして扱われる）
let seq = 0;
const fake = (channel: string) => ({
  isConfigured: () => true,
  async send(opts: { externalThreadId: string; to?: string | null; text: string; cc?: string[]; bcc?: string[] }) {
    sent.push({ channel, to: opts.to, cc: opts.cc, bcc: opts.bcc, text: opts.text });
    seq++;
    const thread = opts.externalThreadId.startsWith('new:') ? `gmail-thread-${seq}` : opts.externalThreadId;
    return { externalId: `${channel}-out-${seq}`, externalThreadId: thread, sentAt: new Date().toISOString() };
  },
});
vi.mock('../channels/gmail.js', async (orig) => {
  const actual = await orig<typeof import('../channels/gmail.js')>();
  return { ...actual, gmailAdapter: { ...actual.gmailAdapter, ...fake('gmail') } };
});
vi.mock('../channels/chatwork.js', async (orig) => {
  const actual = await orig<typeof import('../channels/chatwork.js')>();
  return { ...actual, chatworkAdapter: { ...actual.chatworkAdapter, ...fake('chatwork') } };
});

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { sendToConversation } = await import('../services/send.js');
const { ccSuggestions, parseAddressList } = await import('../services/ccSuggest.js');
const { buildMime } = await import('../channels/gmail.js');
const { getConversation } = await import('../services/inbox.js');
const { scheduleMessage, dispatchScheduled } = await import('../services/scheduledSend.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());
beforeEach(() => {
  sent.length = 0;
});

const base = { attachmentIds: [], driveFiles: [], createWaitingTask: false };

function gmailConv(clientId: number, to: string) {
  return db()
    .insert(schema.conversations)
    .values({ channel: 'gmail', externalThreadId: `t-${Math.random()}`, clientId, counterpartAddress: to, counterpartName: to, subject: 'ご連絡' })
    .returning()
    .get();
}

describe('メールの CC・BCC', () => {
  it('Cc・Bcc のヘッダーを付ける', () => {
    const mime = buildMime({ from: 'me@law.jp', to: 'a@x.jp', cc: ['b@x.jp', 'c@x.jp'], bcc: ['d@x.jp'], subject: 's', text: 't' });
    expect(mime).toContain('To: a@x.jp\r\nCc: b@x.jp, c@x.jp\r\nBcc: d@x.jp');
    expect(buildMime({ from: 'me@law.jp', to: 'a@x.jp', subject: 's', text: 't' })).not.toContain('Cc:');
  });

  it('CC・BCC を付けて送り、送った記録に残す。宛先と同じアドレスや重複は除く', async () => {
    const client = db().insert(schema.clients).values({ name: '山田 花子', emails: ['hanako@x.jp'] }).returning().get();
    const conv = gmailConv(client.id, 'hanako@x.jp');
    await sendToConversation(conv.id, { ...base, text: 'ご報告です', cc: ['taro@x.jp', 'Taro@x.jp', 'hanako@x.jp'], bcc: ['office@law.jp', 'taro@x.jp'] });
    expect(sent[0]).toMatchObject({ channel: 'gmail', to: 'hanako@x.jp', cc: ['taro@x.jp'], bcc: ['office@law.jp'] });
    const view = getConversation(conv.id)!;
    const out = view.messages.find((m) => m.direction === 'out')!;
    expect(out.cc).toEqual(['taro@x.jp']);
    expect(out.bcc).toEqual(['office@law.jp']);
  });

  it('おかしなアドレスや、Gmail 以外のチャネルへの CC は送らずに止める', async () => {
    const client = db().insert(schema.clients).values({ name: '佐藤 太郎', chatworkRoomId: 77 }).returning().get();
    const cw = db().insert(schema.conversations).values({ channel: 'chatwork', externalThreadId: '77', clientId: client.id }).returning().get();
    await expect(sendToConversation(cw.id, { ...base, text: 'x', cc: ['a@x.jp'] })).rejects.toThrow('Gmail だけ');
    const gm = gmailConv(client.id, 'sato@x.jp');
    await expect(sendToConversation(gm.id, { ...base, text: 'x', cc: ['a@x.jp\r\nBcc: evil@x.jp'] })).rejects.toThrow('正しくありません');
    expect(sent).toHaveLength(0);
  });

  it('前回の CC を既定にし、依頼者のほかのアドレス・担当者・これまでの CC を候補に出す', async () => {
    const client = db().insert(schema.clients).values({ name: '株式会社ABC', emails: ['info@abc.jp', 'keiri@abc.jp'] }).returning().get();
    db().insert(schema.clientPersons).values({ clientId: client.id, name: '佐藤 花子', title: '総務部', emails: ['sato@abc.jp'] }).run();
    const conv = gmailConv(client.id, 'info@abc.jp');
    // 相手が CC を付けてきたメール
    db()
      .insert(schema.messages)
      .values({ conversationId: conv.id, channel: 'gmail', externalId: 'in-1', direction: 'in', sentAt: new Date(Date.now() - 7200_000).toISOString(), body: 'よろしくお願いします', raw: { cc: '鈴木 <suzuki@abc.jp>, info@abc.jp' } })
      .run();
    // まだ送っていなければ、既定の CC は空
    expect(ccSuggestions({ clientId: client.id, toAddress: 'info@abc.jp', conversationId: conv.id }).defaults).toEqual([]);

    await sendToConversation(conv.id, { ...base, text: 'ご連絡です', cc: ['sato@abc.jp'] });
    const s = ccSuggestions({ clientId: client.id, toAddress: 'info@abc.jp', conversationId: conv.id });
    expect(s.defaults).toEqual(['sato@abc.jp']);
    const addrs = s.candidates.map((c) => c.address);
    expect(addrs).toEqual(expect.arrayContaining(['keiri@abc.jp', 'sato@abc.jp', 'suzuki@abc.jp']));
    // 宛先（To）自身は候補に出さない
    expect(addrs).not.toContain('info@abc.jp');
    expect(s.candidates.find((c) => c.address === 'sato@abc.jp')?.label).toContain('佐藤');

    // 同じ宛先への別の会話（新しいメール）でも、前回の CC が既定になる
    const conv2 = gmailConv(client.id, 'info@abc.jp');
    expect(ccSuggestions({ clientId: client.id, toAddress: 'info@abc.jp', conversationId: conv2.id }).defaults).toEqual(['sato@abc.jp']);
    // 会話をまだ決めていないとき（依頼者に確認）も同じ
    expect(ccSuggestions({ clientId: client.id, toAddress: 'info@abc.jp' }).defaults).toEqual(['sato@abc.jp']);

    // 前回 CC を外して送ったら、次は既定に入れない
    await sendToConversation(conv.id, { ...base, text: 'もう一通' });
    expect(ccSuggestions({ clientId: client.id, toAddress: 'info@abc.jp', conversationId: conv.id }).defaults).toEqual([]);
  });

  it('送信予約でも CC・BCC を付けて送る', async () => {
    const client = db().insert(schema.clients).values({ name: '鈴木 一郎', emails: ['ichiro@x.jp'] }).returning().get();
    const conv = gmailConv(client.id, 'ichiro@x.jp');
    const s = scheduleMessage(conv.id, { ...base, text: '予約した連絡', cc: ['wife@x.jp'], bcc: ['office@law.jp'] }, new Date(Date.now() + 3600_000).toISOString());
    await dispatchScheduled(s.id, { force: true });
    expect(sent[0]).toMatchObject({ cc: ['wife@x.jp'], bcc: ['office@law.jp'] });
  });

  it('ヘッダーの文字列からアドレスを取り出す', () => {
    expect(parseAddressList('"山田 太郎" <taro@x.jp>, b@y.co.jp')).toEqual(['taro@x.jp', 'b@y.co.jp']);
    expect(parseAddressList(['a@x.jp'])).toEqual(['a@x.jp']);
    expect(parseAddressList(null)).toEqual([]);
  });
});
