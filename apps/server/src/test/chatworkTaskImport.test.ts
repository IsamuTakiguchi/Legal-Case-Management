import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-cwtask-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.CHATWORK_API_TOKEN = 'test-token';

interface CwTask { task_id: number; room: { room_id: number; name: string }; body: string; limit_time: number; status: 'open' | 'done' }
/** Chatwork 側の状態（テストで差し替える） */
const cwState: { myOpen: CwTask[]; rooms: Map<string, CwTask | null> } = { myOpen: [], rooms: new Map() };

vi.mock('../channels/chatwork.js', async (orig) => {
  const actual = await orig<typeof import('../channels/chatwork.js')>();
  return {
    ...actual,
    myTasks: vi.fn(async () => cwState.myOpen),
    roomTask: vi.fn(async (roomId: number, taskId: number) => {
      const key = `${roomId}/${taskId}`;
      if (!cwState.rooms.has(key)) throw new Error('確かめられません');
      return cwState.rooms.get(key) ?? null;
    }),
    setTaskStatus: vi.fn(async () => undefined),
  };
});

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { importChatworkTasks } = await import('../services/tasks.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());
beforeEach(() => {
  db().delete(schema.tasks).run();
  cwState.myOpen = [];
  cwState.rooms.clear();
});

const task = (id: number, roomId: number, body: string, status: 'open' | 'done' = 'open'): CwTask => ({
  task_id: id,
  room: { room_id: roomId, name: 'ルーム' },
  body,
  limit_time: 0,
  status,
});

describe('Chatwork タスクの自動取込', () => {
  it('自分に振られた未完了のタスクを取り込む（2 回目は増えない）', async () => {
    cwState.myOpen = [task(11, 100, '[To:1]瀧口 勇さん\n準備書面の確認')];
    expect((await importChatworkTasks()).imported).toBe(1);
    const t = db().select().from(schema.tasks).where(eq(schema.tasks.chatworkTaskId, 11)).get();
    expect(t?.title).toBe('準備書面の確認');
    expect(t?.chatworkRoomId).toBe(100);
    expect((await importChatworkTasks()).imported).toBe(0);
  });

  it('期限が付いていれば期日として取り込む', async () => {
    cwState.myOpen = [{ ...task(12, 100, '控訴期限の確認'), limit_time: 1_800_000_000 }];
    await importChatworkTasks();
    const t = db().select().from(schema.tasks).where(eq(schema.tasks.chatworkTaskId, 12)).get();
    expect(t?.dueAt).toBe(new Date(1_800_000_000_000).toISOString());
  });

  it('Chatwork で完了したタスクは、こちらも完了にする', async () => {
    cwState.myOpen = [task(13, 100, '書面の送付')];
    await importChatworkTasks();
    cwState.myOpen = [];
    cwState.rooms.set('100/13', task(13, 100, '書面の送付', 'done'));
    expect((await importChatworkTasks()).completed).toBe(1);
    expect(db().select().from(schema.tasks).where(eq(schema.tasks.chatworkTaskId, 13)).get()?.status).toBe('done');
  });

  it('Chatwork から消えたタスクも完了にする', async () => {
    cwState.myOpen = [task(14, 100, '消えるタスク')];
    await importChatworkTasks();
    cwState.myOpen = [];
    cwState.rooms.set('100/14', null);
    expect((await importChatworkTasks()).completed).toBe(1);
  });

  it('担当事務局に振ったタスク（自分の一覧に出ない）を、勝手に完了にしない', async () => {
    db()
      .insert(schema.tasks)
      .values({ title: '謄本の取寄せ', status: 'open', chatworkRoomId: 200, chatworkTaskId: 21 })
      .run();
    // 相手のタスクなので /my/tasks には出ないが、ルームでは未完了のまま
    cwState.myOpen = [];
    cwState.rooms.set('200/21', task(21, 200, '謄本の取寄せ', 'open'));
    expect((await importChatworkTasks()).completed).toBe(0);
    expect(db().select().from(schema.tasks).where(eq(schema.tasks.chatworkTaskId, 21)).get()?.status).toBe('open');
  });

  it('状態を確かめられなかったときは触らない', async () => {
    db().insert(schema.tasks).values({ title: '確認できないタスク', status: 'open', chatworkRoomId: 300, chatworkTaskId: 31 }).run();
    cwState.myOpen = [];
    // rooms に入れていない＝取得でエラー
    expect((await importChatworkTasks()).completed).toBe(0);
    expect(db().select().from(schema.tasks).where(eq(schema.tasks.chatworkTaskId, 31)).get()?.status).toBe('open');
  });

  it('ルームが分からないタスクも触らない', async () => {
    db().insert(schema.tasks).values({ title: 'ルーム不明', status: 'open', chatworkTaskId: 41 }).run();
    cwState.myOpen = [];
    expect((await importChatworkTasks()).completed).toBe(0);
  });
});

describe('Chatwork タスクの題名の作り方', () => {
  it('宛先だけの行は飛ばして、次の行を題名にする', async () => {
    const { chatworkTaskTitle } = await import('../services/tasks.js');
    expect(chatworkTaskTitle('[To:1]瀧口 勇さん\n準備書面の確認')).toBe('準備書面の確認');
    expect(chatworkTaskTitle('準備書面の確認')).toBe('準備書面の確認');
  });

  it('宛先の行しか無ければ、それをそのまま使う（中身を失わない）', async () => {
    const { chatworkTaskTitle } = await import('../services/tasks.js');
    expect(chatworkTaskTitle('[To:1]瀧口 勇さん')).toBe('@瀧口 勇さん');
  });

  it('本文が空でも題名は空にならない', async () => {
    const { chatworkTaskTitle } = await import('../services/tasks.js');
    expect(chatworkTaskTitle('')).toBe('（無題のタスク）');
  });
});
