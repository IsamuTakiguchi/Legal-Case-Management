import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-reaction-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.CHATWORK_API_TOKEN = 'cw-token';

/** Chatwork に投稿した本文を控える（実際の送信はしない） */
const posted: { roomId: number; body: string }[] = [];
vi.mock('../channels/chatwork.js', async (importActual) => {
  const actual = await importActual<typeof import('../channels/chatwork.js')>();
  return {
    ...actual,
    chatworkMe: async () => ({ account_id: 1, name: '自分' }),
    // アダプタ本体はモジュール内の postMessage を呼ぶので、送信口そのものを差し替える
    chatworkAdapter: {
      ...actual.chatworkAdapter,
      async send(opts: { externalThreadId: string; text: string }) {
        posted.push({ roomId: Number(opts.externalThreadId), body: opts.text });
        return { externalId: `cw-${posted.length}`, externalThreadId: opts.externalThreadId, sentAt: '2027-09-01T02:00:00.000Z' };
      },
    },
  };
});

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { parseChatworkReactions, DEFAULT_CHATWORK_REACTIONS } = await import('@lcm/shared');
const { sendToConversation } = await import('../services/send.js');
const { setSetting } = await import('../services/settings.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

describe('Chatwork のリアクション（ワンタップ返信）', () => {
  it('既定では Chatwork のリアクションと同じ 6 つを出す', () => {
    const rs = parseChatworkReactions('');
    expect(rs).toHaveLength(6);
    expect(rs.map((r) => r.label)).toEqual(['了解', 'ありがとう', 'いいね', '拍手', 'にっこり', 'びっくり']);
    // 絵文字コードから画面用の絵文字が決まる
    expect(rs[0]).toMatchObject({ text: '(roger) 了解しました', emoji: '✅' });
    expect(rs[2]).toMatchObject({ text: '(y)', emoji: '👍' });
    expect(parseChatworkReactions(null)).toEqual(parseChatworkReactions(DEFAULT_CHATWORK_REACTIONS));
  });

  it('設定を書き換えられる。空行・コメント・重複は捨て、ラベル省略も読める', () => {
    const rs = parseChatworkReactions(['# 事務局向け', '', '確認します|(nod) 確認します', '(bow) 承知しました', 'だぶり|(nod) 確認します'].join('\n'));
    expect(rs).toEqual([
      { label: '確認します', text: '(nod) 確認します', emoji: '🙆' },
      { label: '(bow) 承知しました', text: '(bow) 承知しました', emoji: '🙏' },
    ]);
  });

  it('知らない絵文字コードでも落ちず、吹き出しの絵文字にする', () => {
    expect(parseChatworkReactions('ひとこと|よろしくお願いします')).toEqual([{ label: 'ひとこと', text: 'よろしくお願いします', emoji: '💬' }]);
  });

  it('送ると返信タグ付きで Chatwork に投稿され、文体サンプルには残らない', async () => {
    posted.length = 0;
    setSetting('lawyer_name', '瀧口 勇');
    const conv = db()
      .insert(schema.conversations)
      .values({ channel: 'chatwork', externalThreadId: '700', counterpartName: '事務局', lastMessageAt: '2027-09-01T01:00:00.000Z' })
      .returning()
      .get();
    const target = db()
      .insert(schema.messages)
      .values({
        conversationId: conv.id,
        channel: 'chatwork',
        externalId: '9001',
        direction: 'in',
        senderName: '中村 事務',
        body: '査定書の写しを送付しました。',
        sentAt: '2027-09-01T01:00:00.000Z',
        raw: { account: { account_id: 12345 }, message_id: '9001' },
      })
      .returning()
      .get();

    const before = db().select().from(schema.styleSamples).all().length;
    const r = await sendToConversation(conv.id, { text: '(roger) 了解しました', attachmentIds: [], driveFiles: [], createWaitingTask: false, replyToMessageId: target.id }, { learn: false });

    expect(posted).toHaveLength(1);
    expect(posted[0]!.roomId).toBe(700);
    // Chatwork の返信タグが付く
    expect(posted[0]!.body).toBe('[rp aid=12345 to=700-9001][pname:12345]さん\n(roger) 了解しました');
    // 定型の一言は文体サンプルにしない
    expect(db().select().from(schema.styleSamples).all().length).toBe(before);
    const saved = db().select().from(schema.messages).where(eq(schema.messages.id, r.messageId)).get()!;
    expect(saved.direction).toBe('out');
    expect(saved.body).toBe('(roger) 了解しました');
  });
});
