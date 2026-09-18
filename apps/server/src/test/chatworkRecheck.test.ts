import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-cwrecheck-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.CHATWORK_API_TOKEN = 'test-token';

const ME = 111;
const cwState: { rooms: { room_id: number; name: string; type: 'my' | 'direct' | 'group' }[]; tasks: Record<'open' | 'done', { message_id: string }[]>; fail: boolean } = {
  rooms: [],
  tasks: { open: [], done: [] },
  fail: false,
};

vi.mock('../channels/chatwork.js', async (orig) => {
  const actual = await orig<typeof import('../channels/chatwork.js')>();
  return {
    ...actual,
    chatworkMe: vi.fn(async () => ({ account_id: ME, name: '瀧口 勇' })),
    listRooms: vi.fn(async () => {
      if (cwState.fail) throw new Error('つながりません');
      return cwState.rooms;
    }),
    myTasks: vi.fn(async (status: 'open' | 'done' = 'open') => cwState.tasks[status]),
  };
});

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { recheckChatworkScope } = await import('../services/chatworkRecheck.js');
const { setSetting, clearSettingsCache } = await import('../services/settings.js');
const { navCounts } = await import('../routes/settings.js');
const { upsertAlert, openAlerts } = await import('../services/alerts.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());
beforeEach(() => {
  db().delete(schema.attachments).run();
  db().delete(schema.messages).run();
  db().delete(schema.conversations).run();
  db().delete(schema.alerts).run();
  db().delete(schema.syncState).run();
  clearSettingsCache();
  setSetting('chatwork_scope', 'to_me');
  cwState.rooms = [];
  cwState.tasks = { open: [], done: [] };
  cwState.fail = false;
});

function seedRoom(roomId: number, type: 'direct' | 'group', msgs: { id: string; body: string; from?: number; at?: string }[]) {
  cwState.rooms.push({ room_id: roomId, name: `ルーム${roomId}`, type });
  const conv = db()
    .insert(schema.conversations)
    .values({ channel: 'chatwork', externalThreadId: String(roomId), subject: `ルーム${roomId}`, needsReply: true, unread: msgs.length, archived: false })
    .returning()
    .get();
  msgs.forEach((m, i) => {
    const from = m.from ?? 222;
    db()
      .insert(schema.messages)
      .values({
        conversationId: conv.id,
        channel: 'chatwork',
        externalId: m.id,
        direction: from === ME ? 'out' : 'in',
        senderName: '担当 太郎',
        senderAddress: String(from),
        body: m.body,
        sentAt: m.at ?? `2026-03-0${i + 1}T01:00:00.000Z`,
      })
      .run();
  });
  return conv;
}

const msgs = (id: number) => db().select().from(schema.messages).where(eq(schema.messages.conversationId, id)).all();
const conv = (id: number) => db().select().from(schema.conversations).where(eq(schema.conversations.id, id)).get()!;

describe('取込済みの Chatwork に取込範囲を当て直す', () => {
  it('下書きでは数えるだけで、何も消さない', async () => {
    const c = seedRoom(500, 'group', [
      { id: 'a', body: '雑談です' },
      { id: 'b', body: `[To:${ME}]瀧口 勇さん\n本題です` },
    ]);
    const r = await recheckChatworkScope();
    expect(r.dryRun).toBe(true);
    expect(r.messages).toBe(2);
    expect(r.outOfScope).toBe(1);
    expect(r.removed).toBe(0);
    expect(msgs(c.id).length).toBe(2);
  });

  it('範囲外の受信だけを外し、範囲内は残す', async () => {
    const c = seedRoom(501, 'group', [
      { id: 'a', body: '雑談です' },
      { id: 'b', body: `[To:${ME}]瀧口 勇さん\n本題です` },
      { id: 'c', body: '[To:777]田中さん お願いします' },
      { id: 'd', body: '[toall]全員にお知らせ' },
    ]);
    const r = await recheckChatworkScope({ apply: true });
    expect(r.outOfScope).toBe(2);
    expect(r.removed).toBe(2);
    expect(msgs(c.id).map((m) => m.externalId).sort()).toEqual(['b', 'd']);
    expect(r.emptied).toBe(0);
    expect(conv(c.id).archived).toBe(false);
  });

  it('引用の中の [To:自分] は自分宛と見ないので外れる', async () => {
    const c = seedRoom(502, 'group', [
      { id: 'a', body: `[To:777]田中さん\n[qt][qtmeta aid=222 time=1][To:${ME}]瀧口さん ご確認ください[/qt]\nお願いします` },
      { id: 'b', body: `[To:${ME}]瀧口 勇さん\n本題です` },
    ]);
    await recheckChatworkScope({ apply: true });
    expect(msgs(c.id).map((m) => m.externalId)).toEqual(['b']);
  });

  it('ダイレクトチャットは何も外さない', async () => {
    const c = seedRoom(503, 'direct', [
      { id: 'a', body: 'お世話になります' },
      { id: 'b', body: '承知しました', from: ME },
    ]);
    const r = await recheckChatworkScope({ apply: true });
    expect(r.outOfScope).toBe(0);
    expect(msgs(c.id).length).toBe(2);
  });

  it('自分が送った分は、範囲外でも残す', async () => {
    const c = seedRoom(504, 'group', [
      { id: 'a', body: '雑談です' },
      { id: 'b', body: 'こちらからの連絡です', from: ME },
    ]);
    await recheckChatworkScope({ apply: true });
    expect(msgs(c.id).map((m) => m.externalId)).toEqual(['b']);
  });

  it('自分に振られたタスクは、終わっていても残す', async () => {
    cwState.tasks.done = [{ message_id: 'a' }];
    const c = seedRoom(505, 'group', [{ id: 'a', body: '資料をお願いします' }]);
    const r = await recheckChatworkScope({ apply: true });
    expect(r.outOfScope).toBe(0);
    expect(msgs(c.id).length).toBe(1);
  });

  it('受信が 1 件も残らない会話は受信箱から外し、要確認も消す', async () => {
    const c = seedRoom(506, 'group', [
      { id: 'a', body: '雑談です' },
      { id: 'b', body: '[To:777]田中さん お願いします' },
    ]);
    upsertAlert({ type: 'unlinked_contact', dedupeKey: 'unlinked:chatwork:506', title: 'Chatwork: ルーム506', payload: { conversationId: c.id } });
    expect(navCounts().inbox).toBe(1);

    const r = await recheckChatworkScope({ apply: true });
    expect(r.emptied).toBe(1);
    const after = conv(c.id);
    expect(after.archived).toBe(true);
    expect(after.needsReply).toBe(false);
    expect(after.unread).toBe(0);
    // メニューとアイコンの数も減る
    expect(navCounts().inbox).toBe(0);
    expect(openAlerts().some((a) => a.type === 'unlinked_contact')).toBe(false);
  });

  it('受信が残る会話では、未読と最終日時を残りから作り直す', async () => {
    const c = seedRoom(507, 'group', [
      { id: 'a', body: '雑談です', at: '2026-03-01T01:00:00.000Z' },
      { id: 'b', body: `[To:${ME}]瀧口 勇さん\n本題です`, at: '2026-03-02T01:00:00.000Z' },
      { id: 'c', body: 'また雑談', at: '2026-03-03T01:00:00.000Z' },
    ]);
    await recheckChatworkScope({ apply: true });
    const after = conv(c.id);
    expect(after.unread).toBe(1);
    expect(after.lastMessageAt).toBe('2026-03-02T01:00:00.000Z');
    expect(after.lastInboundAt).toBe('2026-03-02T01:00:00.000Z');
    expect(after.needsReply).toBe(true);
  });

  it('ルームの種別が分からない会話は触らない', async () => {
    // cwState.rooms に入れずに会話だけ作る
    const conv0 = db()
      .insert(schema.conversations)
      .values({ channel: 'chatwork', externalThreadId: '999', needsReply: true, unread: 1, archived: false })
      .returning()
      .get();
    db().insert(schema.messages).values({ conversationId: conv0.id, channel: 'chatwork', externalId: 'z', direction: 'in', senderAddress: '222', body: '雑談', sentAt: '2026-03-01T01:00:00.000Z' }).run();
    const r = await recheckChatworkScope({ apply: true });
    expect(r.skipped).toBe(1);
    expect(r.removed).toBe(0);
    expect(msgs(conv0.id).length).toBe(1);
  });

  it('取込範囲が「すべて」なら何もしない', async () => {
    setSetting('chatwork_scope', 'all');
    const c = seedRoom(508, 'group', [{ id: 'a', body: '雑談です' }]);
    const r = await recheckChatworkScope({ apply: true });
    expect(r.reason).toContain('すべて');
    expect(msgs(c.id).length).toBe(1);
  });

  it('Chatwork に問い合わせできないときは、何も消さずに理由を返す', async () => {
    cwState.fail = true;
    const c = seedRoom(509, 'group', [{ id: 'a', body: '雑談です' }]);
    const r = await recheckChatworkScope({ apply: true });
    expect(r.reason).toContain('ルーム一覧');
    expect(r.removed).toBe(0);
    expect(msgs(c.id).length).toBe(1);
  });

  it('受信ファイルの控えも一緒に外す（メッセージを参照しているため）', async () => {
    const c = seedRoom(510, 'group', [{ id: 'a', body: '雑談です' }]);
    const m = msgs(c.id)[0]!;
    db().insert(schema.attachments).values({ messageId: m.id, filename: 'a.pdf', status: 'pending' }).run();
    await recheckChatworkScope({ apply: true });
    expect(db().select().from(schema.attachments).all().length).toBe(0);
    expect(msgs(c.id).length).toBe(0);
  });
});
