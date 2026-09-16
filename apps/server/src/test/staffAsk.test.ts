import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-staffask-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.CHATWORK_API_TOKEN = 'cw-token';
process.env.PUBLIC_BASE_URL = 'https://lex.example.com';

/** Chatwork に送った内容を控える（実際の送信はしない） */
const sent: { kind: 'message' | 'task'; roomId: number; body: string; toIds?: number[]; limit?: number }[] = [];
vi.mock('../channels/chatwork.js', async (importActual) => {
  const actual = await importActual<typeof import('../channels/chatwork.js')>();
  return {
    ...actual,
    myChatRoomId: async () => 900,
    listRooms: async () => [
      { room_id: 900, name: 'マイチャット', type: 'my' },
      { room_id: 500, name: '事務局 全体', type: 'group' },
    ],
    postMessage: async (roomId: number, body: string) => {
      sent.push({ kind: 'message', roomId, body });
      return { message_id: 'cw-1' };
    },
    createTask: async (roomId: number, body: string, toIds: number[], limit?: number) => {
      sent.push({ kind: 'task', roomId, body, toIds, limit });
      return { task_ids: [77] };
    },
  };
});

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { staffAskContext, sendStaffAsk, buildStaffAskBody } = await import('../services/staffAsk.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

let seq = 0;
function seed() {
  const n = ++seq;
  const client = db().insert(schema.clients).values({ name: '山田 花子', chatworkRoomId: 300 }).returning().get();
  const staff = db().insert(schema.staffMembers).values({ name: '中村 事務', chatworkAccountId: 12345 }).returning().get();
  const kase = db().insert(schema.cases).values({ clientId: client.id, title: '山田 離婚', staffId: staff.id, chatworkRoomId: 200 }).returning().get();
  const conv = db()
    .insert(schema.conversations)
    .values({ channel: 'gmail', externalThreadId: `t-${n}`, clientId: client.id, caseId: kase.id, counterpartName: '山田 花子', lastMessageAt: '2027-09-01T01:00:00.000Z' })
    .returning()
    .get();
  const msg = db()
    .insert(schema.messages)
    .values({ conversationId: conv.id, clientId: client.id, channel: 'gmail', externalId: `m-${n}`, direction: 'in', senderName: '山田 花子', body: '査定書をお送りしましたが届いていますか。', sentAt: '2027-09-01T01:00:00.000Z' })
    .returning()
    .get();
  return { client, staff, kase, conv, msg };
}

describe('受信した連絡を事務局に確認する', () => {
  it('送り先と担当の候補を出す（事件専用ルームが先頭、担当は事件の担当事務局）', async () => {
    const { conv, staff, msg } = seed();
    const ctx = await staffAskContext({ kind: 'conversation', conversationId: conv.id });
    expect(ctx.defaultStaffId).toBe(staff.id);
    expect(ctx.rooms.map((r) => [r.roomId, r.kind])).toEqual([
      [200, 'case'],
      [300, 'client'],
      [900, 'my'],
      [500, 'other'],
    ]);
    expect(ctx.defaultRoomId).toBe(200);
    expect(ctx.subject).toMatchObject({ kind: 'message', head: expect.stringContaining('Gmail'), body: '査定書をお送りしましたが届いていますか。', link: `/inbox/${conv.id}` });
    expect(ctx.subject!.head).toContain('山田 花子');
    expect(msg.id).toBeTypeOf('number');
    expect(ctx.blocked).toBeNull();
  });

  it('宛先・引用・アプリへのリンクを付けた本文を組み立てる', async () => {
    const { conv, staff } = seed();
    const ctx = await staffAskContext({ kind: 'conversation', conversationId: conv.id });
    const body = buildStaffAskBody(ctx, { text: '査定書が届いているか確認をお願いします', staff: { name: staff.name, chatworkAccountId: staff.chatworkAccountId } });
    expect(body).toContain('[To:12345] 中村 事務さん');
    expect(body).toContain('【山田 花子 / 山田 離婚】');
    expect(body).toContain('[info][title]届いた連絡（Gmail');
    expect(body).toContain('査定書をお送りしましたが届いていますか。');
    expect(body).toContain(`https://lex.example.com/inbox/${conv.id}`);
  });

  it('送るとその Chatwork ルームの会話にも控えが残る', async () => {
    sent.length = 0;
    const { conv, staff } = seed();
    const r = await sendStaffAsk({ kind: 'conversation', conversationId: conv.id }, { roomId: 200, staffId: staff.id, text: '届いているか確認をお願いします' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'message', roomId: 200 });
    expect(r.messageId).toBeTypeOf('number');
    const saved = db().select().from(schema.messages).where(eq(schema.messages.id, r.messageId!)).get()!;
    expect(saved.direction).toBe('out');
    expect(saved.body).toContain('届いているか確認をお願いします');
    // 控えは Chatwork ルームの会話に入る
    const conv2 = db().select().from(schema.conversations).where(eq(schema.conversations.id, saved.conversationId)).get()!;
    expect([conv2.channel, conv2.externalThreadId]).toEqual(['chatwork', '200']);
  });

  it('タスクとして送ると担当者と期限を付け、アプリ側の返事待ちも作れる', async () => {
    sent.length = 0;
    const { conv, staff, kase } = seed();
    const r = await sendStaffAsk({ kind: 'conversation', conversationId: conv.id }, { roomId: 200, staffId: staff.id, text: '受領を確認してください', asTask: true, due: '2027-09-05', createWaitingTask: true });
    expect(sent[0]).toMatchObject({ kind: 'task', roomId: 200, toIds: [12345] });
    expect(sent[0]!.limit).toBe(Math.floor(new Date('2027-09-05T18:00:00+09:00').getTime() / 1000));
    expect(r.chatworkTaskId).toBe(77);
    const task = db().select().from(schema.tasks).where(eq(schema.tasks.id, r.waitingTaskId!)).get()!;
    expect(task.title).toContain('事務局に確認');
    expect([task.status, task.caseId, task.conversationId]).toEqual(['waiting_other', kase.id, conv.id]);
  });

  it('Chatwork アカウント未登録の担当にはタスクで送れない', async () => {
    const { conv } = seed();
    const other = db().insert(schema.staffMembers).values({ name: '新人 事務' }).returning().get();
    await expect(sendStaffAsk({ kind: 'conversation', conversationId: conv.id }, { roomId: 200, staffId: other.id, text: '確認お願いします', asTask: true })).rejects.toThrow(/Chatwork アカウント/);
  });
});

describe('事件の記録を事務局に確認する', () => {
  it('記録を引用し、その記録へのリンクを付けて送る', async () => {
    sent.length = 0;
    const { client, staff, kase } = seed();
    const note = db()
      .insert(schema.caseNotes)
      .values({
        caseId: kase.id,
        clientId: client.id,
        kind: 'phone',
        counterpart: '山田 花子',
        occurredAt: '2027-09-01T01:00:00.000Z',
        gist: '査定書の受領を確認した',
        theirSaid: ['2 社のうち 1 社は届いた'],
        ourSaid: ['残り 1 社を待つ'],
        decisions: ['残り 1 社が届き次第、調停に提出する'],
        nextActions: [{ title: '残り 1 社の査定書を受領', due: '2027-09-08' }],
        rawText: '元メモ',
      })
      .returning()
      .get();

    const ctx = await staffAskContext({ kind: 'note', noteId: note.id });
    expect(ctx.subject).toMatchObject({ kind: 'note', link: `/cases/${kase.id}#note-${note.id}` });
    expect(ctx.subject!.head).toContain('電話の記録');
    expect(ctx.subject!.head).toContain('山田 花子');
    // 引用には要旨・発言・決定・次のアクションが入る
    expect(ctx.subject!.body).toContain('査定書の受領を確認した');
    expect(ctx.subject!.body).toContain('山田 花子: 2 社のうち 1 社は届いた');
    expect(ctx.subject!.body).toContain('こちら: 残り 1 社を待つ');
    expect(ctx.subject!.body).toContain('決定: 残り 1 社が届き次第、調停に提出する');
    expect(ctx.subject!.body).toContain('次のアクション: 残り 1 社の査定書を受領（2027-09-08）');
    // 事件・依頼者は記録からたどる
    expect([ctx.caseId, ctx.clientId, ctx.defaultStaffId]).toEqual([kase.id, client.id, staff.id]);

    const r = await sendStaffAsk({ kind: 'note', noteId: note.id }, { roomId: 200, staffId: staff.id, text: '残り 1 社の状況を確認してください', createWaitingTask: true });
    expect(sent).toHaveLength(1);
    const body = sent[0]!.body;
    expect(body).toContain('[To:12345] 中村 事務さん');
    expect(body).toContain('【山田 花子 / 山田 離婚】');
    expect(body).toContain('[info][title]事件の記録（電話の記録');
    expect(body).toContain(`https://lex.example.com/cases/${kase.id}#note-${note.id}`);
    // 返事待ちは会話ではなく事件に紐付く
    const task = db().select().from(schema.tasks).where(eq(schema.tasks.id, r.waitingTaskId!)).get()!;
    expect([task.caseId, task.clientId, task.conversationId, task.status]).toEqual([kase.id, client.id, null, 'waiting_other']);
  });

  it('決定事項が無い記録では「決定:」を出さない', async () => {
    const { client, kase } = seed();
    const note = db()
      .insert(schema.caseNotes)
      .values({ caseId: kase.id, clientId: client.id, kind: 'memo', occurredAt: '2027-09-01T01:00:00.000Z', gist: '中身だけの記録' })
      .returning()
      .get();
    const ctx = await staffAskContext({ kind: 'note', noteId: note.id });
    expect(ctx.subject!.body).toBe('中身だけの記録');
    expect(ctx.subject!.body).not.toContain('決定:');
  });

  it('引用を外すと記録の中身は載せない', async () => {
    sent.length = 0;
    const { client, kase } = seed();
    const note = db()
      .insert(schema.caseNotes)
      .values({ caseId: kase.id, clientId: client.id, kind: 'meeting', occurredAt: '2027-09-01T01:00:00.000Z', gist: '表に出したくない内容' })
      .returning()
      .get();
    await sendStaffAsk({ kind: 'note', noteId: note.id }, { roomId: 200, text: '進め方を相談させてください', quote: false });
    expect(sent[0]!.body).not.toContain('表に出したくない内容');
    // 引用を外しても、記録へのリンクは残す
    expect(sent[0]!.body).toContain(`https://lex.example.com/cases/${kase.id}#note-${note.id}`);
  });

  it('無い記録は送れない', async () => {
    await expect(staffAskContext({ kind: 'note', noteId: 999999 })).rejects.toThrow(/記録が見つかりません/);
  });
});
