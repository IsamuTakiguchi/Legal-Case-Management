import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-staffrooms-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.CHATWORK_API_TOKEN = 'cw-token';

const ROOMS = [
  { room_id: 900, name: 'マイチャット', type: 'my' },
  { room_id: 100, name: '瀧口弁護士伝言帳', type: 'group' },
  { room_id: 200, name: '指示→横井', type: 'group' },
  { room_id: 300, name: '山田 離婚 専用', type: 'group' },
];
vi.mock('../channels/chatwork.js', async (importActual) => ({
  ...(await importActual<typeof import('../channels/chatwork.js')>()),
  myChatRoomId: async () => 900,
  listRooms: async () => ROOMS,
}));

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { staffRooms } = await import('../services/staff.js');
const { staffAskContext } = await import('../services/staffAsk.js');
const { staffSendTargets } = await import('../services/newMessage.js');
const { setSetting } = await import('../services/settings.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

describe('事務局に送るルーム', () => {
  it('全員向けは名前に「伝言帳」を含むルーム、人ごとは「→ 姓」のルーム。無ければ全員向け', () => {
    const r = staffRooms(ROOMS, [
      { id: 1, name: '横井 遥', chatworkRoomId: null },
      { id: 2, name: '中村 花子', chatworkRoomId: null },
    ]);
    expect(r.general).toEqual({ roomId: 100, guessed: true });
    expect(r.byStaff.get(1)).toEqual({ roomId: 200, guessed: true, own: true });
    expect(r.byStaff.get(2)).toEqual({ roomId: 100, guessed: true, own: false });
  });

  it('設定・事務局メンバーに指定したルームを優先する', () => {
    setSetting('staff_room_id', '300');
    const r = staffRooms(ROOMS, [{ id: 2, name: '中村 花子', chatworkRoomId: 400 }]);
    expect(r.general).toEqual({ roomId: 300, guessed: false });
    expect(r.byStaff.get(2)).toEqual({ roomId: 400, guessed: false, own: true });
    setSetting('staff_room_id', '');
  });

  it('事務局に報告・確認: 担当が横井なら「指示→横井」、ほかの人なら伝言帳が既定（事件専用ルームより先）', async () => {
    const yokoi = db().insert(schema.staffMembers).values({ name: '横井 遥', chatworkAccountId: 11 }).returning().get();
    const naka = db().insert(schema.staffMembers).values({ name: '中村 花子', chatworkAccountId: 22 }).returning().get();
    const client = db().insert(schema.clients).values({ name: '山田 花子' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '山田 離婚', staffId: yokoi.id, chatworkRoomId: 300 }).returning().get();
    const t = db().insert(schema.tasks).values({ title: '準備書面', status: 'open', clientId: client.id, caseId: kase.id }).returning().get();
    let ctx = await staffAskContext({ kind: 'task', taskId: t.id });
    expect(ctx.defaultStaffId).toBe(yokoi.id);
    expect(ctx.defaultRoomId).toBe(200);
    expect(ctx.rooms.slice(0, 2).map((r) => [r.roomId, r.name, r.kind])).toEqual([
      [200, '指示→横井', 'staff'],
      [100, '瀧口弁護士伝言帳', 'staff'],
    ]);
    // 画面で担当を変えたときの送り先
    expect(ctx.staff.find((s) => s.id === naka.id)?.roomId).toBe(100);
    db().update(schema.cases).set({ staffId: naka.id }).where(eq(schema.cases.id, kase.id)).run();
    ctx = await staffAskContext({ kind: 'task', taskId: t.id });
    expect(ctx.defaultRoomId).toBe(100);
  });

  it('新しく送る（事務局へ）: 既定は伝言帳（前に別のルームへ送っていても）、人ごとの送り先も返す', async () => {
    const conv = db().insert(schema.conversations).values({ channel: 'chatwork', externalThreadId: '300', counterpartName: '山田 離婚 専用' }).returning().get();
    db().insert(schema.messages).values({ conversationId: conv.id, channel: 'chatwork', externalId: 'ask-1', direction: 'out', body: '確認', sentAt: new Date().toISOString(), raw: { staffAsk: { taskId: 1 } } }).run();
    const r = await staffSendTargets();
    expect(r.defaultRoomId).toBe(100);
    expect(r.staff.find((s) => s.name === '横井 遥')?.roomId).toBe(200);
    expect(r.staff.find((s) => s.name === '中村 花子')?.roomId).toBe(100);
  });
});
