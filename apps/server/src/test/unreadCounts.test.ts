import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { eq } from 'drizzle-orm';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-unread-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { ingestMessage, inboxCounts, repairUnreadAfterReply } = await import('../services/inbox.js');
const { navCounts } = await import('../routes/settings.js');
const { badgeCountForPush } = await import('../services/push.js');
const { setSetting, clearSettingsCache } = await import('../services/settings.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());
beforeEach(() => {
  db().delete(schema.messages).run();
  db().delete(schema.conversations).run();
  clearSettingsCache();
  setSetting('gmail_categories', 'all');
  setSetting('app_badge_source', 'inbox_unread');
});

const cw = (threadId: string) => ({
  channel: 'chatwork' as const,
  externalThreadId: threadId,
  attachments: [],
  identity: { channel: 'chatwork' as const, chatworkRoomId: Number(threadId), chatworkAccountId: 77, displayName: '担当 太郎' },
  senderName: '担当 太郎',
  subject: 'ルーム',
});
const conv = (id: number) => db().select().from(schema.conversations).where(eq(schema.conversations.id, id)).get()!;

describe('未読の数え方（「未読だけ」のアイコンがふくらむ問題）', () => {
  it('自分が返信すると、未返信だけでなく未読も戻る（Chatwork や Gmail で直接返した分も同じ）', async () => {
    const r = await ingestMessage({ ...cw('100'), externalId: 'in-1', direction: 'in', sentAt: '2026-09-10T01:00:00.000Z', body: '相談です' });
    expect(conv(r.conversation.id)).toMatchObject({ unread: 1, needsReply: true });
    expect(inboxCounts()).toEqual({ inbox: 1, unread: 1 });

    // アプリを通さず Chatwork で返した分がポーリングで入ってくる
    await ingestMessage({ ...cw('100'), externalId: 'out-1', direction: 'out', sentAt: '2026-09-10T02:00:00.000Z', body: '承知しました', senderName: '自分' });
    expect(conv(r.conversation.id)).toMatchObject({ unread: 0, needsReply: false });
    expect(inboxCounts()).toEqual({ inbox: 0, unread: 0 });
    expect(navCounts().unread).toBe(0);
    expect(badgeCountForPush()).toBe(0);
  });

  it('さかのぼって拾った古い送信では未読を戻さない（最新の受信はまだ読んでいない）', async () => {
    const r = await ingestMessage({ ...cw('101'), externalId: 'in-new', direction: 'in', sentAt: '2026-09-10T01:00:00.000Z', body: '最新の連絡' });
    await ingestMessage({ ...cw('101'), externalId: 'out-old', direction: 'out', sentAt: '2026-09-01T01:00:00.000Z', body: '先週の返信', senderName: '自分' });
    expect(conv(r.conversation.id)).toMatchObject({ unread: 1, needsReply: true });
  });

  it('Gmail を「メインだけ」にしていれば、受信箱に出ないプロモーション等は未読にも未返信にも数えない', async () => {
    db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: 'g-1', unread: 2, needsReply: true, archived: false, meta: { category: 'promotions' } }).run();
    db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: 'g-2', unread: 1, needsReply: true, archived: false, meta: { category: 'primary' } }).run();
    db().insert(schema.conversations).values({ channel: 'chatwork', externalThreadId: 'c-1', unread: 1, needsReply: true, archived: false }).run();
    // すべて → 3 件
    expect(inboxCounts()).toEqual({ inbox: 3, unread: 3 });
    // メインだけ → プロモーションを外して 2 件。メニューもアイコンも同じ数になる
    setSetting('gmail_categories', 'primary');
    expect(inboxCounts()).toEqual({ inbox: 2, unread: 2 });
    expect(navCounts()).toMatchObject({ inbox: 2, unread: 2 });
    expect(badgeCountForPush()).toBe(2);
    setSetting('app_badge_source', 'inbox');
    expect(badgeCountForPush()).toBe(2);
  });

  it('アーカイブ済みは数えない', async () => {
    db().insert(schema.conversations).values({ channel: 'chatwork', externalThreadId: 'a-1', unread: 5, needsReply: true, archived: true }).run();
    expect(inboxCounts()).toEqual({ inbox: 0, unread: 0 });
  });

  it('起動時の修復: 自分が最後に送っているのに未読が残っている会話だけ 0 に戻す', async () => {
    // 以前の版で溜まった状態を作る（送信を取り込んでも未読が戻っていなかった）
    const replied = db().insert(schema.conversations).values({ channel: 'chatwork', externalThreadId: 'r-1', unread: 3, needsReply: false, archived: false }).returning().get();
    db().insert(schema.messages).values({ conversationId: replied.id, channel: 'chatwork', externalId: 'r-in', direction: 'in', senderAddress: '77', body: '相談', sentAt: '2026-09-10T01:00:00.000Z' }).run();
    db().insert(schema.messages).values({ conversationId: replied.id, channel: 'chatwork', externalId: 'r-out', direction: 'out', senderAddress: '1', body: '返信', sentAt: '2026-09-10T02:00:00.000Z' }).run();
    // 相手からの連絡が最後で、本当にまだ読んでいないもの
    const pending = db().insert(schema.conversations).values({ channel: 'chatwork', externalThreadId: 'p-1', unread: 1, needsReply: true, archived: false }).returning().get();
    db().insert(schema.messages).values({ conversationId: pending.id, channel: 'chatwork', externalId: 'p-in', direction: 'in', senderAddress: '77', body: '相談', sentAt: '2026-09-10T03:00:00.000Z' }).run();
    expect(inboxCounts().unread).toBe(2);

    expect(repairUnreadAfterReply()).toBe(1);
    expect(conv(replied.id).unread).toBe(0);
    expect(conv(pending.id).unread).toBe(1);
    expect(inboxCounts().unread).toBe(1);
    // 直し終わればもう触らない
    expect(repairUnreadAfterReply()).toBe(0);
  });
});
