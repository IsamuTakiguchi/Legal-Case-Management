import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-newmsg-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.CHATWORK_API_TOKEN = 'cw-token';

vi.mock('../channels/chatwork.js', async (importActual) => ({
  ...(await importActual<typeof import('../channels/chatwork.js')>()),
  listRooms: async () => [
    { room_id: 900, name: 'マイチャット', type: 'my' },
    { room_id: 400, name: '中村さん', type: 'direct' },
    { room_id: 500, name: '事務局 全体', type: 'group' },
  ],
}));

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { setAdapter } = await import('../channels/registry.js');
const { clientSendTargets, startClientConversation, staffSendTargets, startRoomConversation } = await import('../services/newMessage.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => {
  openTestDatabase();
  for (const channel of ['gmail', 'line'] as const) {
    setAdapter(channel, { channel, isConfigured: () => true, fetchAttachment: async () => Buffer.from(''), send: async () => ({ externalId: 'x', externalThreadId: 'x', sentAt: new Date().toISOString() }) });
  }
});
afterAll(() => closeDatabase());

describe('こちらから新しく送る（依頼者）', () => {
  it('送れる宛先（本人・窓口ごと）と、送れない理由を出す', () => {
    const c = db().insert(schema.clients).values({ name: '山田 花子', emails: ['hanako@example.jp'], lineUserId: 'U-hanako' }).returning().get();
    db().insert(schema.clientPersons).values({ clientId: c.id, name: '鈴木 美香', title: '長女', emails: ['mika@example.jp'], primary: true }).run();
    const r = clientSendTargets(c.id);
    expect(r.targets.map((t) => [t.channel, t.recipient, t.to])).toEqual([
      ['gmail', '鈴木 美香（長女）', 'mika@example.jp'],
      ['gmail', '山田 花子', 'hanako@example.jp'],
      ['line', '山田 花子', 'LINE'],
    ]);
    expect(r.missing.some((m) => m.includes('Chatwork のルームが未設定'))).toBe(true);
    expect(r.missing.some((m) => m.includes('メールアドレスが未登録'))).toBe(false);
  });

  it('メールは件名を付けた新しいメールにする（件名は必須）。前のメールの続きにもできる', () => {
    const c = db().insert(schema.clients).values({ name: '佐藤 太郎', emails: ['taro@example.jp'] }).returning().get();
    expect(() => startClientConversation(c.id, { channel: 'gmail', subject: ' ' })).toThrow('件名を入力してください');
    const r = startClientConversation(c.id, { channel: 'gmail', subject: '次回期日のご連絡' });
    const conv = db().select().from(schema.conversations).where(eq(schema.conversations.id, r.conversationId)).get()!;
    expect(conv).toMatchObject({ channel: 'gmail', clientId: c.id, counterpartAddress: 'taro@example.jp', subject: '次回期日のご連絡' });
    expect(conv.externalThreadId.startsWith('new:')).toBe(true);
    // 前のメール（実在のスレッド）の続き
    const old = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: 'thread-1', clientId: c.id, subject: '資料の件', lastMessageAt: '2026-10-01T00:00:00.000Z', archived: true }).returning().get();
    expect(clientSendTargets(c.id).gmailThreads.map((t) => t.subject)).toEqual(['資料の件']);
    expect(startClientConversation(c.id, { channel: 'gmail', threadConversationId: old.id }).conversationId).toBe(old.id);
    expect(db().select().from(schema.conversations).where(eq(schema.conversations.id, old.id)).get()!.archived).toBe(false);
    // 別の依頼者のメールの続きにはしない
    const other = db().insert(schema.clients).values({ name: '別人', emails: ['x@example.jp'] }).returning().get();
    expect(() => startClientConversation(other.id, { channel: 'gmail', threadConversationId: old.id })).toThrow('続けるメールが見つかりません');
  });

  it('LINE は相手ごとに 1 つの会話。連絡先の無いチャネルでは開かない', () => {
    const c = db().insert(schema.clients).values({ name: '田中 一郎', lineUserId: 'U-tanaka' }).returning().get();
    const a = startClientConversation(c.id, { channel: 'line' });
    expect(startClientConversation(c.id, { channel: 'line' }).conversationId).toBe(a.conversationId);
    expect(() => startClientConversation(c.id, { channel: 'gmail', subject: '件名' })).toThrow('この宛先に送れません');
  });
});

describe('こちらから新しく送る（事務局）', () => {
  it('ルーム（マイチャットは除く）と事務局メンバー、既定のルームを出す。ルームの会話は 1 つ', async () => {
    db().insert(schema.staffMembers).values({ name: '中村 事務', chatworkAccountId: 12345 }).run();
    const r = await staffSendTargets();
    expect(r.rooms.map((x) => x.roomId)).toEqual([400, 500]);
    expect(r.defaultRoomId).toBe(500);
    expect(r.staff.map((s) => s.name)).toContain('中村 事務');
    const a = startRoomConversation(500, '事務局 全体');
    expect(db().select().from(schema.conversations).where(eq(schema.conversations.id, a.conversationId)).get()).toMatchObject({ channel: 'chatwork', externalThreadId: '500', counterpartName: '事務局 全体' });
    expect(startRoomConversation(500, '事務局 全体').conversationId).toBe(a.conversationId);
    // 前に事務局へ確認を送ったルームがあれば、それを既定にする
    const conv = db().insert(schema.conversations).values({ channel: 'chatwork', externalThreadId: '400', counterpartName: '中村さん' }).returning().get();
    db().insert(schema.messages).values({ conversationId: conv.id, channel: 'chatwork', externalId: 'cw-ask-1', direction: 'out', body: '確認です', sentAt: new Date().toISOString(), raw: { staffAsk: { taskId: 1 } } }).run();
    expect((await staffSendTargets()).defaultRoomId).toBe(400);
  });
});
