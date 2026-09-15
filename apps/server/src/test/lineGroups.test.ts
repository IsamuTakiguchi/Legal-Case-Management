import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-linegroup-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
// LINE 未設定にして、グループ名の問い合わせをしない状態で確かめる
delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
delete process.env.LINE_CHANNEL_SECRET;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { repairLineGroupConversations, threadIdFromRaw } = await import('../services/lineGroups.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

/** 以前の取り込み方（グループの発言も個人トークに入れていた）でデータを作る */
function seedMixedConversation() {
  const client = db().insert(schema.clients).values({ name: '山田 花子', lineUserId: 'Umember' }).returning().get();
  const conv = db()
    .insert(schema.conversations)
    .values({ channel: 'line', externalThreadId: 'Umember', clientId: client.id, counterpartName: '山田 花子', lastMessageAt: '2027-05-03T00:00:00.000Z' })
    .returning()
    .get();
  const mk = (externalId: string, body: string, sentAt: string, source: Record<string, unknown>, direction: 'in' | 'out' = 'in') =>
    db()
      .insert(schema.messages)
      .values({ conversationId: conv.id, clientId: client.id, channel: 'line', externalId, direction, body, sentAt, raw: { source } })
      .returning()
      .get();
  const personal = mk('m-1', '個人トークの連絡です', '2027-05-01T00:00:00.000Z', { type: 'user', userId: 'Umember' });
  const group1 = mk('m-2', 'グループでの連絡です', '2027-05-02T00:00:00.000Z', { type: 'group', groupId: 'Cgroup', userId: 'Umember' });
  const group2 = mk('m-3', 'グループでの連絡その 2', '2027-05-03T00:00:00.000Z', { type: 'group', groupId: 'Cgroup', userId: 'Uother' });
  const mine = mk('m-4', 'こちらから個人に送った分', '2027-05-03T01:00:00.000Z', {}, 'out');
  return { client, conv, personal, group1, group2, mine };
}

describe('グループの発言を個人トークから分け直す', () => {
  it('生データからトークの ID を読む', () => {
    expect(threadIdFromRaw({ source: { type: 'group', groupId: 'C1', userId: 'U1' } })).toBe('C1');
    expect(threadIdFromRaw({ source: { type: 'room', roomId: 'R1' } })).toBe('R1');
    expect(threadIdFromRaw({ source: { type: 'user', userId: 'U1' } })).toBeNull();
    expect(threadIdFromRaw(null)).toBeNull();
  });

  it('グループの発言だけをグループの会話へ移し、個人トークと自分の送信は残す', async () => {
    const { conv, personal, group1, group2, mine, client } = seedMixedConversation();
    const r = await repairLineGroupConversations();
    expect(r).toMatchObject({ moved: 2, created: 1 });

    const group = db().select().from(schema.conversations).where(eq(schema.conversations.externalThreadId, 'Cgroup')).get()!;
    expect(group.clientId).toBe(client.id);
    const inGroup = db().select().from(schema.messages).where(eq(schema.messages.conversationId, group.id)).all().map((m) => m.id);
    expect(inGroup.sort()).toEqual([group1.id, group2.id].sort());
    // 会話の最終日時も計算し直す
    expect(group.lastMessageAt).toBe('2027-05-03T00:00:00.000Z');

    const left = db().select().from(schema.messages).where(eq(schema.messages.conversationId, conv.id)).all().map((m) => m.id);
    expect(left.sort()).toEqual([personal.id, mine.id].sort());
    // 残っている会話は消さない
    expect(db().select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)).get()?.archived).toBe(false);

    // 2 回流しても増えない
    expect((await repairLineGroupConversations()).moved).toBe(0);
  });

  it('グループの発言しかない会話は、移したあと一覧から隠す', async () => {
    const conv = db()
      .insert(schema.conversations)
      .values({ channel: 'line', externalThreadId: 'Uonlygroup', counterpartName: '佐藤 太郎', lastMessageAt: '2027-06-01T00:00:00.000Z' })
      .returning()
      .get();
    db()
      .insert(schema.messages)
      .values({ conversationId: conv.id, channel: 'line', externalId: 'm-10', direction: 'in', body: 'グループのみ', sentAt: '2027-06-01T00:00:00.000Z', raw: { source: { type: 'group', groupId: 'Cgroup2', userId: 'Uonlygroup' } } })
      .run();
    await repairLineGroupConversations();
    expect(db().select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)).get()?.archived).toBe(true);
    expect(db().select().from(schema.conversations).where(eq(schema.conversations.externalThreadId, 'Cgroup2')).get()).toBeTruthy();
  });
});

describe('グループの会話の名前', () => {
  it('会話の名前はグループ名、発言者はメンバー名で分けて記録する', async () => {
    const { ingestMessage } = await import('../services/inbox.js');
    const { message, conversation } = await ingestMessage(
      {
        channel: 'line',
        externalThreadId: 'Cgroup-name',
        externalId: 'gm-1',
        direction: 'in',
        sentAt: '2027-07-01T00:00:00.000Z',
        senderName: '田中 一郎',
        senderAddress: 'Umember-1',
        threadName: '〇〇事件 連絡グループ',
        body: 'よろしくお願いします',
        attachments: [],
        identity: { channel: 'line', lineUserId: null, displayName: '〇〇事件 連絡グループ' },
      },
      { processAttachments: false },
    );
    expect(conversation.counterpartName).toBe('〇〇事件 連絡グループ');
    expect(message.senderName).toBe('田中 一郎');
  });
});
