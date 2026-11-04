import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-gmailalways-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

/** Gmail にあるメール（テストで差し替える） */
type Msg = { id: string; threadId: string; labelIds: string[]; internalDate: string; payload: unknown };
const box: { messages: Msg[]; history: string[] } = { messages: [], history: [] };
const mail = (id: string, from: string, subject: string, labels: string[]): Msg => ({
  id,
  threadId: `t-${id}`,
  labelIds: ['INBOX', 'UNREAD', ...labels],
  internalDate: String(Date.now()),
  payload: {
    mimeType: 'text/plain',
    headers: [
      { name: 'From', value: from },
      { name: 'To', value: 'me@example.com' },
      { name: 'Subject', value: subject },
      { name: 'Message-ID', value: `<${id}@x>` },
    ],
    body: { data: Buffer.from(`${subject} の本文`).toString('base64url') },
  },
});

vi.mock('../integrations/google.js', async (orig) => ({
  ...(await orig<typeof import('../integrations/google.js')>()),
  isGoogleConnected: () => true,
  gmailApi: () => ({
    users: {
      getProfile: async () => ({ data: { emailAddress: 'me@example.com', historyId: '100' } }),
      settings: { sendAs: { list: async () => ({ data: { sendAs: [] } }) } },
      history: { list: async () => ({ data: { historyId: '101', history: [{ messagesAdded: box.history.map((id) => ({ message: { id } })) }] } }) },
      messages: {
        // from: で検索されたら、その送信元のものだけ返す
        list: async (o: { q?: string }) => {
          const m = /from:(\S+)/.exec(o.q ?? '');
          const hits = box.messages.filter((x) => !m || JSON.stringify(x.payload).toLowerCase().includes(m[1]!));
          return { data: { messages: hits.map((x) => ({ id: x.id })) } };
        },
        get: async (o: { id: string }) => {
          const found = box.messages.find((x) => x.id === o.id);
          if (!found) throw Object.assign(new Error('not found'), { code: 404 });
          return { data: found };
        },
      },
    },
  }),
}));

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { pollGmail, refetchGmailFrom, isAlwaysIngestSender } = await import('../jobs/gmailPoll.js');
const { matchesAlwaysSender } = await import('../channels/gmail.js');
const { setSetting, setSyncState } = await import('../services/settings.js');
const { listConversations } = await import('../services/inbox.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());
beforeEach(() => {
  box.messages = [];
  box.history = [];
  setSetting('gmail_categories', 'primary');
  setSetting('gmail_always_senders', '');
  setSyncState('gmail:historyId', '99');
});
const ingested = (id: string) => !!db().select().from(schema.messages).where(eq(schema.messages.externalId, id)).get();

describe('Gmail で必ず取り込む送信元', () => {
  it('アドレスの一致、またはドメイン（サブドメインも）で判定する', () => {
    const list = ['no-reply02@ben54.jp', 'courts.go.jp'];
    expect(matchesAlwaysSender('No-Reply02@ben54.jp', list)).toBe(true);
    expect(matchesAlwaysSender('other@ben54.jp', list)).toBe(false);
    expect(matchesAlwaysSender('info@courts.go.jp', list)).toBe(true);
    expect(matchesAlwaysSender('a@tokyo.courts.go.jp', list)).toBe(true);
    expect(matchesAlwaysSender('a@notcourts.go.jp', list)).toBe(false);
    expect(matchesAlwaysSender(null, list)).toBe(false);
    expect(matchesAlwaysSender('a@ben54.jp', ['@ben54.jp'.replace(/^@/, '')])).toBe(true);
  });

  it('「メインだけ」でも、設定した送信元からの「新着」は取り込む。それ以外の「新着」は取り込まない', async () => {
    setSetting('gmail_always_senders', 'no-reply02@ben54.jp');
    box.messages = [mail('a1', 'no-reply02@ben54.jp', '受付のお知らせ', ['CATEGORY_UPDATES']), mail('a2', 'news@shop.example', 'セール', ['CATEGORY_UPDATES'])];
    box.history = ['a1', 'a2'];
    const r = await pollGmail();
    expect(r).toMatchObject({ ingested: 1, skipped: 1 });
    expect(ingested('a1')).toBe(true);
    expect(ingested('a2')).toBe(false);
    // 受信箱にも出る（「新着」に分類されていても隠さない）
    expect(listConversations({}).some((c) => c.counterpartAddress === 'no-reply02@ben54.jp')).toBe(true);
  });

  it('登録済みの依頼者・関係者からのメールは、設定に入れなくても取り込む', async () => {
    const client = db().insert(schema.clients).values({ name: '山田 太郎', emails: ['Yamada@example.jp'] }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '山田 離婚' }).returning().get();
    db().insert(schema.caseContacts).values({ caseId: kase.id, role: 'opponent_counsel', name: '鈴木 一郎', emails: ['suzuki@law.example.jp'] }).run();
    expect(isAlwaysIngestSender('yamada@example.jp')).toBe(true);
    expect(isAlwaysIngestSender('suzuki@law.example.jp')).toBe(true);
    expect(isAlwaysIngestSender('stranger@example.jp')).toBe(false);
    box.messages = [mail('b1', '山田 太郎 <yamada@example.jp>', '書類の件', ['CATEGORY_UPDATES']), mail('b2', 'suzuki@law.example.jp', 'ご連絡', ['CATEGORY_FORUMS'])];
    box.history = ['b1', 'b2'];
    expect((await pollGmail()).ingested).toBe(2);
  });

  it('落ちたメールは、送信元を指定して取り込み直せる（重ねて入らない）', async () => {
    box.messages = [mail('c1', 'no-reply02@ben54.jp', '申込の受付', ['CATEGORY_UPDATES']), mail('c2', 'no-reply02@ben54.jp', '予約の確定', ['CATEGORY_PROMOTIONS'])];
    box.history = ['c1', 'c2'];
    expect((await pollGmail()).skipped).toBe(2);
    expect(ingested('c1')).toBe(false);
    expect(await refetchGmailFrom('no-reply02@ben54.jp')).toEqual({ found: 2, ingested: 2 });
    expect(ingested('c1') && ingested('c2')).toBe(true);
    expect(await refetchGmailFrom('no-reply02@ben54.jp')).toEqual({ found: 2, ingested: 0 });
    // ドメインでも探せる
    expect((await refetchGmailFrom('ben54.jp')).found).toBe(2);
  });

  it('送信元の形がおかしければ断る（Gmail の検索に余計な条件を混ぜない）', async () => {
    await expect(refetchGmailFrom('a@b.jp OR is:anywhere')).rejects.toThrow('メールアドレスか、ドメイン');
    await expect(refetchGmailFrom('foo')).rejects.toThrow('メールアドレスか、ドメイン');
  });
});
