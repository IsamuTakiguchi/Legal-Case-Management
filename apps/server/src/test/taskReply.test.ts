import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-taskreply-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.CHATWORK_API_TOKEN = 'cw-token';

interface CwTask { task_id: number; room: { room_id: number; name: string }; assigned_by_account: { account_id: number; name: string }; message_id: string; body: string; limit_time: number; status: 'open' | 'done' }
/** Chatwork 側の状態と、送ったもの（実際の送信はしない） */
const cwState: { myOpen: CwTask[]; rooms: Map<string, CwTask | null>; posted: { roomId: number; body: string }[]; statuses: { taskId: number; status: string }[] } = {
  myOpen: [],
  rooms: new Map(),
  posted: [],
  statuses: [],
};

vi.mock('../channels/chatwork.js', async (importActual) => {
  const actual = await importActual<typeof import('../channels/chatwork.js')>();
  return {
    ...actual,
    chatworkMe: async () => ({ account_id: 1, name: '瀧口 勇' }),
    myTasks: vi.fn(async () => cwState.myOpen),
    roomTask: vi.fn(async (roomId: number, taskId: number) => cwState.rooms.get(`${roomId}/${taskId}`) ?? null),
    setTaskStatus: vi.fn(async (_roomId: number, taskId: number, status: string) => {
      cwState.statuses.push({ taskId, status });
    }),
    postMessage: vi.fn(async (roomId: number, body: string) => {
      cwState.posted.push({ roomId, body });
      return { message_id: `p-${cwState.posted.length}` };
    }),
    // 受信箱の会話から送るときは、アダプタの送信口を通る
    chatworkAdapter: {
      ...actual.chatworkAdapter,
      async send(opts: { externalThreadId: string; text: string }) {
        cwState.posted.push({ roomId: Number(opts.externalThreadId), body: opts.text });
        return { externalId: `a-${cwState.posted.length}`, externalThreadId: opts.externalThreadId, sentAt: '2027-09-01T02:00:00.000Z' };
      },
    },
  };
});

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { importChatworkTasks, listTasks } = await import('../services/tasks.js');
const { replyToChatworkTask } = await import('../services/taskReply.js');
const { setSyncState } = await import('../services/settings.js');
const { createApp } = await import('../index.js');
const { setPassword } = await import('../auth/index.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => {
  openTestDatabase();
  setSyncState('chatwork:myAccountId', '1');
});
afterAll(() => closeDatabase());
beforeEach(() => {
  db().delete(schema.tasks).run();
  db().delete(schema.messages).run();
  db().delete(schema.conversations).run();
  cwState.myOpen = [];
  cwState.rooms.clear();
  cwState.posted = [];
  cwState.statuses = [];
});

const staffTask = (id: number, roomId: number, messageId: string, body: string, by = { account_id: 55, name: '中村 事務' }): CwTask => ({
  task_id: id,
  room: { room_id: roomId, name: '事務局' },
  assigned_by_account: by,
  message_id: messageId,
  body,
  limit_time: 0,
  status: 'open',
});
const byCw = (taskId: number) => db().select().from(schema.tasks).where(eq(schema.tasks.chatworkTaskId, taskId)).get()!;

describe('Chatwork で振られたタスクへの返信', () => {
  it('取り込むときに、元のメッセージと振った人を控える。自分で振ったタスクは返信の対象外', async () => {
    cwState.myOpen = [staffTask(21, 300, '777', '[To:1]瀧口 勇さん\n陳述書の確認をお願いします'), staffTask(22, 400, '888', '自分用メモ', { account_id: 1, name: '瀧口 勇' })];
    await importChatworkTasks();
    expect(byCw(21)).toMatchObject({ chatworkMessageId: '777', chatworkAssignedById: 55, chatworkAssignedByName: '中村 事務' });
    const listed = listTasks({ status: 'active' });
    expect(listed.find((t) => t.chatworkTaskId === 21)?.chatworkReplyable).toBe(true);
    expect(listed.find((t) => t.chatworkTaskId === 22)?.chatworkReplyable).toBe(false);
  });

  it('以前の版で取り込んだタスクにも、次の取込で返信先を足す', async () => {
    db().insert(schema.tasks).values({ title: '旧タスク', status: 'open', chatworkRoomId: 300, chatworkTaskId: 23 }).run();
    expect(listTasks({ status: 'active' })[0]?.chatworkReplyable).toBe(false);
    cwState.myOpen = [staffTask(23, 300, '779', '旧タスク')];
    expect((await importChatworkTasks()).imported).toBe(0);
    expect(byCw(23)).toMatchObject({ chatworkMessageId: '779', chatworkAssignedById: 55 });
    expect(listTasks({ status: 'active' })[0]?.chatworkReplyable).toBe(true);
  });

  it('タスクのメッセージに Chatwork の返信タグ付きで送り、完了にすると Chatwork のタスクも完了にする', async () => {
    cwState.myOpen = [staffTask(24, 300, '777', '陳述書の確認をお願いします')];
    await importChatworkTasks();
    const r = await replyToChatworkTask(byCw(24).id, { text: '確認しました。修正点はありません。', after: 'done' });
    expect(cwState.posted).toEqual([{ roomId: 300, body: '[rp aid=55 to=300-777][pname:55]さん\n確認しました。修正点はありません。' }]);
    expect(r).toMatchObject({ to: '中村 事務', status: 'done', conversationId: null });
    const t = byCw(24);
    expect(t.status).toBe('done');
    expect(t.chatworkRepliedAt).toBeTruthy();
    expect(cwState.statuses).toEqual([{ taskId: 24, status: 'done' }]);
  });

  it('そのルームが受信箱にあれば、会話にも返信として残す。「事務局待ち」にもできる', async () => {
    const conv = db().insert(schema.conversations).values({ channel: 'chatwork', externalThreadId: '300', counterpartName: '事務局', lastMessageAt: '2027-09-01T01:00:00.000Z' }).returning().get();
    const src = db()
      .insert(schema.messages)
      .values({ conversationId: conv.id, channel: 'chatwork', externalId: '777', direction: 'in', senderName: '中村 事務', body: '陳述書の確認をお願いします', sentAt: '2027-09-01T01:00:00.000Z', raw: { account: { account_id: 55 }, message_id: '777' } })
      .returning()
      .get();
    cwState.myOpen = [staffTask(25, 300, '777', '陳述書の確認をお願いします')];
    await importChatworkTasks();
    const r = await replyToChatworkTask(byCw(25).id, { text: '2 点質問があります。', after: 'waiting_staff' });
    expect(cwState.posted[0]!.body).toBe('[rp aid=55 to=300-777][pname:55]さん\n2 点質問があります。');
    expect(r.conversationId).toBe(conv.id);
    const saved = db().select().from(schema.messages).where(eq(schema.messages.id, r.messageId!)).get()!;
    expect(saved).toMatchObject({ direction: 'out', body: '2 点質問があります。' });
    expect((saved.raw as { replyToMessageId: number }).replyToMessageId).toBe(src.id);
    expect(byCw(25).status).toBe('waiting_staff');
    // 「そのまま」なら状態は変えない
    await replyToChatworkTask(byCw(25).id, { text: '追記です。', after: 'keep' });
    expect(byCw(25).status).toBe('waiting_staff');
  });

  it('返信先が分からない古いタスクは Chatwork に問い合わせて補う', async () => {
    const t = db().insert(schema.tasks).values({ title: '古い', status: 'open', chatworkRoomId: 300, chatworkTaskId: 26 }).returning().get();
    cwState.rooms.set('300/26', staffTask(26, 300, '790', '古い'));
    await replyToChatworkTask(t.id, { text: '対応しました。', after: 'keep' });
    expect(cwState.posted[0]!.body).toBe('[rp aid=55 to=300-790][pname:55]さん\n対応しました。');
    expect(byCw(26).chatworkMessageId).toBe('790');
  });

  it('自分で振ったタスク・Chatwork 以外のタスクには送らない', async () => {
    cwState.myOpen = [staffTask(27, 400, '888', '自分用', { account_id: 1, name: '瀧口 勇' })];
    await importChatworkTasks();
    await expect(replyToChatworkTask(byCw(27).id, { text: 'x', after: 'keep' })).rejects.toThrow('返信する相手がいません');
    const local = db().insert(schema.tasks).values({ title: 'アプリだけ', status: 'open' }).returning().get();
    await expect(replyToChatworkTask(local.id, { text: 'x', after: 'keep' })).rejects.toThrow('Chatwork から取り込んだタスクではありません');
    expect(cwState.posted).toHaveLength(0);
  });

  it('API から送れる。本文が空なら送らない', async () => {
    cwState.myOpen = [staffTask(28, 300, '777', '確認依頼')];
    await importChatworkTasks();
    const app = createApp();
    setPassword('task-reply-test');
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'task-reply-test' }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const post = (body: unknown) => app.request(`/api/tasks/${byCw(28).id}/chatwork-reply`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    expect((await post({ text: '   ' })).ok).toBe(false);
    expect(cwState.posted).toHaveLength(0);
    const res = await post({ text: '確認しました。' });
    expect(res.status).toBe(200);
    expect(cwState.posted).toHaveLength(1);
    expect(byCw(28).status).toBe('open');
  });
});
