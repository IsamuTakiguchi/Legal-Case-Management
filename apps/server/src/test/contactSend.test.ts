import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-contactsend-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

// Gmail・LINE を「接続済み」にする（実際には送らない）
let lineReady = true;
vi.mock('../channels/gmail.js', async (orig) => {
  const actual = await orig<typeof import('../channels/gmail.js')>();
  return { ...actual, gmailAdapter: { ...actual.gmailAdapter, isConfigured: () => true } };
});
vi.mock('../channels/line.js', async (orig) => {
  const actual = await orig<typeof import('../channels/line.js')>();
  return { ...actual, lineAdapter: { ...actual.lineAdapter, isConfigured: () => lineReady } };
});

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { contactSendTargets, startContactConversation, clientSendTargets } = await import('../services/newMessage.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

function seed() {
  const client = db().insert(schema.clients).values({ name: '山田 花子', emails: ['hanako@x.jp'] }).returning().get();
  const kase = db().insert(schema.cases).values({ clientId: client.id, title: '山田 離婚' }).returning().get();
  const counsel = db().insert(schema.caseContacts).values({ caseId: kase.id, role: 'opponent_counsel', name: '鈴木 弁護士', organization: '鈴木法律事務所', emails: ['suzuki@law.jp'] }).returning().get();
  const opponent = db().insert(schema.caseContacts).values({ caseId: kase.id, role: 'opponent', name: '山田 太郎', lineUserId: 'U-taro' }).returning().get();
  const court = db().insert(schema.caseContacts).values({ caseId: kase.id, role: 'court', name: '家庭裁判所 書記官', phone: '0742-00-0000' }).returning().get();
  return { client, kase, counsel, opponent, court };
}

describe('事件の連絡先から関係者に送る', () => {
  it('メールは件名を付けた新しいメールの会話を、その事件・依頼者・関係者に紐付けて開く', () => {
    const { client, kase, counsel } = seed();
    expect(contactSendTargets(counsel.id).targets.map((t) => t.channel)).toEqual(['gmail']);
    expect(() => startContactConversation(counsel.id, { channel: 'gmail', subject: '  ' })).toThrow('件名');
    const { conversationId } = startContactConversation(counsel.id, { channel: 'gmail', subject: '山田 離婚について' });
    const conv = db().select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get()!;
    expect(conv).toMatchObject({ channel: 'gmail', contactId: counsel.id, caseId: kase.id, clientId: client.id, counterpartAddress: 'suzuki@law.jp', subject: '山田 離婚について' });
    expect(conv.externalThreadId.startsWith('new:')).toBe(true);

    // やり取りが始まったメールは「前のメールの続き」に出て、その会話を開ける
    db().update(schema.conversations).set({ externalThreadId: 'gmail-thread-1', lastMessageAt: new Date().toISOString() }).where(eq(schema.conversations.id, conversationId)).run();
    expect(contactSendTargets(counsel.id).gmailThreads.map((t) => t.conversationId)).toEqual([conversationId]);
    expect(startContactConversation(counsel.id, { channel: 'gmail', threadConversationId: conversationId }).conversationId).toBe(conversationId);
  });

  it('LINE は相手とのトークを開く。連絡先が無い・チャネルが未設定なら開かない', () => {
    const { opponent, court } = seed();
    const a = startContactConversation(opponent.id, { channel: 'line' });
    // 2 回目は同じトーク
    expect(startContactConversation(opponent.id, { channel: 'line' }).conversationId).toBe(a.conversationId);
    // メールアドレスが無い相手にメールは送れない
    expect(() => startContactConversation(opponent.id, { channel: 'gmail', subject: 'x' })).toThrow('送れません');
    expect(contactSendTargets(court.id).targets).toEqual([]);
    expect(contactSendTargets(court.id).missing).toContain('メールアドレスが未登録です');
    lineReady = false;
    expect(() => startContactConversation(opponent.id, { channel: 'line' })).toThrow('送れません');
    lineReady = true;
  });

  it('依頼者の送り先に、各チャネルが接続済みかを付ける（関係者のボタンを出すかに使う）', () => {
    const { client } = seed();
    expect(clientSendTargets(client.id).configured).toEqual({ gmail: true, line: true, chatwork: false });
  });
});
