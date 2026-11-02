import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-cwtask-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.CHATWORK_API_TOKEN = 'test-token';

interface CwTask { task_id: number; room: { room_id: number; name: string }; body: string; limit_time: number; status: 'open' | 'done'; message_id?: string }
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

describe('Chatwork タスクの依頼者・事件への紐付け', () => {
  beforeEach(() => {
    db().delete(schema.messages).run();
    db().delete(schema.conversations).run();
    db().delete(schema.cases).run();
    db().delete(schema.clients).run();
  });
  const get = (id: number) => db().select().from(schema.tasks).where(eq(schema.tasks.chatworkTaskId, id)).get();

  it('依頼者のルームなら、その依頼者と主な事件に付ける', async () => {
    const client = db().insert(schema.clients).values({ name: '山田 太郎', chatworkRoomId: 500 }).returning().get();
    db().insert(schema.cases).values({ clientId: client.id, title: '山田 相談', status: 'consultation' }).run();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '山田 離婚', status: 'active' }).returning().get();
    db().insert(schema.cases).values({ clientId: client.id, title: '山田 旧件', status: 'closed' }).run();
    cwState.myOpen = [task(51, 500, '委任状の確認')];
    await importChatworkTasks();
    expect(get(51)).toMatchObject({ clientId: client.id, caseId: kase.id });
  });

  it('事件専用ルームなら、その事件と依頼者に付ける', async () => {
    const client = db().insert(schema.clients).values({ name: '佐藤 花子' }).returning().get();
    db().insert(schema.cases).values({ clientId: client.id, title: '佐藤 交通事故', status: 'active' }).run();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '佐藤 相続', status: 'active', chatworkRoomId: 600 }).returning().get();
    cwState.myOpen = [task(52, 600, '遺産目録の作成')];
    await importChatworkTasks();
    expect(get(52)).toMatchObject({ clientId: client.id, caseId: kase.id });
  });

  it('元のメッセージを取り込んでいれば、そのメッセージの事件に付ける', async () => {
    const client = db().insert(schema.clients).values({ name: '鈴木 一郎' }).returning().get();
    db().insert(schema.cases).values({ clientId: client.id, title: '鈴木 破産', status: 'active' }).run();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '鈴木 貸金', status: 'wrapup' }).returning().get();
    const conv = db().insert(schema.conversations).values({ channel: 'chatwork', externalThreadId: '700' }).returning().get();
    db()
      .insert(schema.messages)
      .values({ conversationId: conv.id, channel: 'chatwork', externalId: 'm-700', direction: 'in', body: '貸金の件', sentAt: '2026-10-01T00:00:00.000Z', clientId: client.id, caseId: kase.id })
      .run();
    cwState.myOpen = [{ ...task(53, 700, '貸金の件、返事をお願いします'), message_id: 'm-700' }];
    await importChatworkTasks();
    expect(get(53)).toMatchObject({ clientId: client.id, caseId: kase.id });
  });

  it('事務局のルームなど依頼者が分からないルームでは、本文の依頼者名から推定する（宛先の名前は使わない）', async () => {
    db().insert(schema.clients).values({ name: '瀧口 次郎' }).run();
    const client = db().insert(schema.clients).values({ name: '高橋 健' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '高橋 労働', status: 'active' }).returning().get();
    cwState.myOpen = [task(54, 800, '[To:1]瀧口 勇さん\n高橋さんから電話がありました。折り返しお願いします')];
    await importChatworkTasks();
    expect(get(54)).toMatchObject({ clientId: client.id, caseId: kase.id });
  });

  it('分からなければ紐付けない', async () => {
    db().insert(schema.clients).values({ name: '伊藤 誠' }).run();
    cwState.myOpen = [task(55, 900, '事務所の備品の発注')];
    await importChatworkTasks();
    expect(get(55)).toMatchObject({ clientId: null, caseId: null });
  });

  it('取り込み済みで紐付いていないタスクにも、次の取込で付ける', async () => {
    cwState.myOpen = [task(56, 1000, '書証の整理')];
    await importChatworkTasks();
    expect(get(56)?.clientId).toBeNull();
    const client = db().insert(schema.clients).values({ name: '中村 修', chatworkRoomId: 1000 }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '中村 建物明渡', status: 'active' }).returning().get();
    await importChatworkTasks();
    expect(get(56)).toMatchObject({ clientId: client.id, caseId: kase.id });
  });

  it('依頼者だけ付いていたタスクには、同じ依頼者の事件を足す', async () => {
    const client = db().insert(schema.clients).values({ name: '小林 学', chatworkRoomId: 1100 }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '小林 離婚', status: 'active' }).returning().get();
    db().insert(schema.tasks).values({ title: '戸籍の取寄せ', status: 'open', clientId: client.id, chatworkRoomId: 1100, chatworkTaskId: 57 }).run();
    cwState.myOpen = [task(57, 1100, '戸籍の取寄せ')];
    await importChatworkTasks();
    expect(get(57)).toMatchObject({ clientId: client.id, caseId: kase.id });
  });

  it('手で事件を外したタスクには、事件を付け直さない', async () => {
    const client = db().insert(schema.clients).values({ name: '加藤 進', chatworkRoomId: 1200 }).returning().get();
    db().insert(schema.cases).values({ clientId: client.id, title: '加藤 債務整理', status: 'active' }).run();
    db()
      .insert(schema.tasks)
      .values({ title: '通帳の確認', status: 'open', clientId: client.id, chatworkRoomId: 1200, chatworkTaskId: 58, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' })
      .run();
    cwState.myOpen = [task(58, 1200, '通帳の確認')];
    await importChatworkTasks();
    expect(get(58)).toMatchObject({ clientId: client.id, caseId: null });
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
