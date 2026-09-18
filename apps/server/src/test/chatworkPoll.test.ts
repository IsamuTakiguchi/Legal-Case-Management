import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-cwpoll-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.CHATWORK_API_TOKEN = 'test-token';

interface Room { room_id: number; name: string; type: 'my' | 'direct' | 'group'; unread_num?: number; last_update_time?: number }
interface Msg { message_id: string; account: { account_id: number; name: string }; body: string; send_time: number; update_time: number }

const ME = 111;
/** Chatwork 側の状態と、どのルームを取りに行ったか */
const cwState: { rooms: Room[]; messages: Map<number, Msg[]>; fetched: number[] } = { rooms: [], messages: new Map(), fetched: [] };

vi.mock('../channels/chatwork.js', async (orig) => {
  const actual = await orig<typeof import('../channels/chatwork.js')>();
  return {
    ...actual,
    chatworkMe: vi.fn(async () => ({ account_id: ME, name: '瀧口 勇' })),
    listRooms: vi.fn(async () => cwState.rooms),
    fetchRoomMessages: vi.fn(async (roomId: number) => {
      cwState.fetched.push(roomId);
      return cwState.messages.get(roomId) ?? [];
    }),
    myTasks: vi.fn(async () => []),
  };
});

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { pollChatwork } = await import('../jobs/chatworkPoll.js');
const { setSetting, clearSettingsCache } = await import('../services/settings.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());
beforeEach(() => {
  db().delete(schema.messages).run();
  db().delete(schema.conversations).run();
  db().delete(schema.syncState).run();
  clearSettingsCache();
  setSetting('chatwork_scope', 'to_me');
  cwState.rooms = [];
  cwState.messages = new Map();
  cwState.fetched = [];
});

const msg = (id: string, body: string, from = 222): Msg => ({ message_id: id, account: { account_id: from, name: '事務局 花子' }, body, send_time: 1_800_000_000, update_time: 1_800_000_000 });

describe('Chatwork の取りこぼし', () => {
  it('Chatwork 側で先に読んだ（未読 0）ルームの [To:自分] も取り込む', async () => {
    // 依頼者にも紐付いておらず、まだ取り込んでいないルーム。未読は 0（スマホで先に読んだ状態）
    cwState.rooms = [{ room_id: 900, name: '新しいグループ', type: 'group', unread_num: 0, last_update_time: 1_800_000_000 }];
    cwState.messages.set(900, [msg('m-1', `[To:${ME}]瀧口 勇さん\n至急ご確認ください`)]);
    const r = await pollChatwork();
    expect(cwState.fetched).toEqual([900]);
    expect(r.ingested).toBe(1);
    const saved = db().select().from(schema.messages).all();
    expect(saved.length).toBe(1);
    expect(saved[0]!.body).toContain('至急ご確認ください');
  });

  it('同じメッセージを何度取り込んでも増えない', async () => {
    cwState.rooms = [{ room_id: 900, name: 'グループ', type: 'group', unread_num: 0, last_update_time: 1_800_000_000 }];
    cwState.messages.set(900, [msg('m-1', `[To:${ME}]瀧口 勇さん\n確認ください`)]);
    await pollChatwork();
    // 取り込み済みのルームは毎回見に行くが、message_id で重複を弾くので増えない
    await pollChatwork();
    expect(cwState.fetched).toEqual([900, 900]);
    expect(db().select().from(schema.messages).all().length).toBe(1);
  });

  it('関わりのないルームで、自分宛でない発言は取り込まない', async () => {
    cwState.rooms = [{ room_id: 901, name: '雑談', type: 'group', unread_num: 0, last_update_time: 1_800_000_000 }];
    cwState.messages.set(901, [msg('m-2', '[To:999]別の人さん\n了解です')]);
    const r = await pollChatwork();
    // ルームは見に行くが、取込範囲の判定で落ちる
    expect(cwState.fetched).toEqual([901]);
    expect(r.ingested).toBe(0);
    expect(db().select().from(schema.messages).all().length).toBe(0);
  });

  it('動きが無いルームは取りに行かない（API を無駄に叩かない）', async () => {
    cwState.rooms = [{ room_id: 902, name: '止まっているグループ', type: 'group', unread_num: 0, last_update_time: 1_700_000_000 }];
    cwState.messages.set(902, [msg('m-3', 'おはようございます')]);
    await pollChatwork(); // 1 回目は控えが無いので見る
    expect(cwState.fetched).toEqual([902]);
    cwState.fetched = [];
    await pollChatwork(); // 2 回目は last_update_time が進んでいないので見ない
    expect(cwState.fetched).toEqual([]);
  });

  it('取得に失敗したルームは、次回もう一度見に行く', async () => {
    const cw = await import('../channels/chatwork.js');
    cwState.rooms = [{ room_id: 903, name: 'エラーになるグループ', type: 'group', unread_num: 0, last_update_time: 1_800_000_000 }];
    vi.mocked(cw.fetchRoomMessages).mockRejectedValueOnce(new Error('Chatwork API エラー 500'));
    await pollChatwork();
    cwState.fetched = [];
    cwState.messages.set(903, [msg('m-4', `[To:${ME}]瀧口 勇さん\n再送です`)]);
    const r = await pollChatwork();
    expect(cwState.fetched).toEqual([903]);
    expect(r.ingested).toBe(1);
  });

  it('マイチャットは対象外', async () => {
    cwState.rooms = [{ room_id: 1, name: 'マイチャット', type: 'my', unread_num: 3, last_update_time: 1_800_000_000 }];
    cwState.messages.set(1, [msg('m-5', `[To:${ME}]自分宛メモ`)]);
    await pollChatwork();
    expect(cwState.fetched).toEqual([]);
  });

  it('ルームが多いときは上限まで見て、残りは次回に回す', async () => {
    cwState.rooms = Array.from({ length: 70 }, (_, i) => ({ room_id: 1000 + i, name: `G${i}`, type: 'group' as const, unread_num: 0, last_update_time: 1_800_000_000 + i }));
    const r1 = await pollChatwork();
    expect(r1.rooms).toBe(60);
    expect(r1.skipped).toBe(10);
    // 次回は、前回見なかった 10 件が残っている
    cwState.fetched = [];
    const r2 = await pollChatwork();
    expect(r2.rooms).toBe(10);
    expect(r2.skipped).toBe(0);
  });
});
