import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-staffask-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.CHATWORK_API_TOKEN = 'cw-token';
process.env.PUBLIC_BASE_URL = 'https://lex.example.com';

let cwSeq = 0;
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
      // 送るたびに別の ID（同じ ID だと、控えが前の送信のものとして扱われる）
      return { message_id: `cw-${++cwSeq}` };
    },
    createTask: async (roomId: number, body: string, toIds: number[], limit?: number) => {
      sent.push({ kind: 'task', roomId, body, toIds, limit });
      return { task_ids: [77] };
    },
  };
});

/** AI に渡した指示を控える */
const aiCalls: { system: string; user: string }[] = [];
vi.mock('../integrations/anthropic.js', async (orig) => ({
  ...(await orig<typeof import('../integrations/anthropic.js')>()),
  generateStructured: vi.fn(async (opts: { system: string; user: string }) => {
    aiCalls.push({ system: opts.system, user: opts.user });
    return { text: '下書き', title: '題名' };
  }),
}));

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { staffAskContext, sendStaffAsk, buildStaffAskBody, draftStaffAsk } = await import('../services/staffAsk.js');
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
    expect([task.status, task.caseId, task.conversationId]).toEqual(['waiting_staff', kase.id, conv.id]);
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
    expect([task.caseId, task.clientId, task.conversationId, task.status]).toEqual([kase.id, client.id, null, 'waiting_staff']);
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

describe('タスクから担当事務局に報告・確認する', () => {
  it('タスクの中身（題名・状態・締切・メモ）を引用し、担当は事件の担当事務局、送り先は事件専用ルームが先頭', async () => {
    const { client, kase, staff } = seed();
    const t = db()
      .insert(schema.tasks)
      .values({ title: '準備書面（2）を提出', status: 'open', clientId: client.id, caseId: kase.id, dueAt: '2027-10-20T14:59:59.999Z', note: '証拠説明書も一緒に' })
      .returning()
      .get();
    const ctx = await staffAskContext({ kind: 'task', taskId: t.id });
    expect(ctx.subject).toMatchObject({ kind: 'task', head: 'タスク「準備書面（2）を提出」', link: `/cases/${kase.id}` });
    expect(ctx.subject!.body).toContain('準備書面（2）を提出（対応中）');
    expect(ctx.subject!.body).toContain('締切 2027年10月20日(水)');
    expect(ctx.subject!.body).toContain('証拠説明書も一緒に');
    expect(ctx.defaultStaffId).toBe(staff.id);
    expect(ctx.defaultRoomId).toBe(200);
    const body = buildStaffAskBody(ctx, { text: '明日依頼者に送ります', staff });
    expect(body).toContain('[info][title]タスク（タスク「準備書面（2）を提出」）[/title]');
    expect(body).toContain(`https://lex.example.com/cases/${kase.id}`);
  });

  it('Chatwork で振られたタスクは、そのルームと振った事務局を既定にする', async () => {
    const { client } = seed();
    const other = db().insert(schema.staffMembers).values({ name: '佐藤 事務', chatworkAccountId: 777 }).returning().get();
    const t = db().insert(schema.tasks).values({ title: '書類の確認', status: 'open', clientId: client.id, chatworkRoomId: 500, chatworkAssignedById: 777 }).returning().get();
    const ctx = await staffAskContext({ kind: 'task', taskId: t.id });
    expect(ctx.defaultRoomId).toBe(500);
    expect(ctx.defaultStaffId).toBe(other.id);
  });

  it('送るときに「事務局の回答・作業待ち」を選ぶと、新しく作らずにそのタスクを待ちにする', async () => {
    const { client, kase, staff } = seed();
    const t = db().insert(schema.tasks).values({ title: '証拠の写しを準備', status: 'open', clientId: client.id, caseId: kase.id }).returning().get();
    const before = db().select().from(schema.tasks).all().length;
    sent.length = 0;
    const r = await sendStaffAsk({ kind: 'task', taskId: t.id }, { staffId: staff.id, roomId: 200, text: '証拠の写しの準備をお願いします', createWaitingTask: true, due: '2027-10-18' });
    expect(sent[0]).toMatchObject({ kind: 'message', roomId: 200 });
    expect(sent[0]!.body).toContain('[To:12345] 中村 事務さん');
    expect(r.waitingTaskId).toBe(t.id);
    expect(db().select().from(schema.tasks).all().length).toBe(before);
    const after = db().select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()!;
    expect(after.status).toBe('waiting_staff');
    expect(after.followUpAt).toBe(new Date('2027-10-18T09:00:00+09:00').toISOString());
    // 控えは Chatwork のルームの会話に、どのタスクから送ったかと一緒に残る
    const saved = db().select().from(schema.messages).where(eq(schema.messages.id, r.messageId!)).get()!;
    expect((saved.raw as { staffAsk?: { taskId?: number } }).staffAsk?.taskId).toBe(t.id);
  });

  it('このタスクから送った報告に事務局から返事が来たら、その返事への Chatwork の返信として送れる', async () => {
    const { client, kase, staff } = seed();
    const t = db().insert(schema.tasks).values({ title: '期日請書の提出', status: 'open', clientId: client.id, caseId: kase.id }).returning().get();
    // 返事が来る前は、返信先の候補は無い
    expect((await staffAskContext({ kind: 'task', taskId: t.id })).replyTargets).toEqual([]);
    const first = await sendStaffAsk({ kind: 'task', taskId: t.id }, { staffId: staff.id, roomId: 200, text: '期日請書の提出をお願いします' });
    const asked = db().select().from(schema.messages).where(eq(schema.messages.id, first.messageId!)).get()!;
    // 事務局から返事が届いた
    const reply = db()
      .insert(schema.messages)
      .values({ conversationId: asked.conversationId, channel: 'chatwork', externalId: '1900000001', direction: 'in', senderName: '中村 事務', senderAddress: '12345', body: '[rp aid=1 to=200-1][pname:1]さん\n提出しました。控えは共有フォルダに入れています。', sentAt: new Date(Date.now() + 60_000).toISOString() })
      .returning()
      .get();
    const ctx = await staffAskContext({ kind: 'task', taskId: t.id });
    expect(ctx.replyTargets).toHaveLength(1);
    expect(ctx.replyTargets[0]).toMatchObject({ key: '200-1900000001', roomId: 200, accountId: 12345, senderName: '中村 事務', reason: 'reply', messageId: reply.id, excerpt: '提出しました。控えは共有フォルダに入れています。' });
    expect(ctx.defaultReplyKey).toBe('200-1900000001');

    sent.length = 0;
    // 送り先に別のルームを選んでいても、返信先のルームに送る
    const r = await sendStaffAsk({ kind: 'task', taskId: t.id }, { staffId: staff.id, roomId: 500, text: 'ありがとうございます。確認しました', replyTo: '200-1900000001', quote: false });
    expect(sent[0]).toMatchObject({ kind: 'message', roomId: 200 });
    expect(sent[0]!.body.startsWith('[rp aid=12345 to=200-1900000001][pname:12345]さん\n')).toBe(true);
    // 返信の相手が担当なら、[To] を重ねない
    expect(sent[0]!.body).not.toContain('[To:12345]');
    expect(sent[0]!.body).toContain('ありがとうございます。確認しました');
    expect(r.replyToName).toBe('中村 事務');
    // アプリの会話でも、どのメッセージへの返信かが分かる
    const saved = db().select().from(schema.messages).where(eq(schema.messages.id, r.messageId!)).get()!;
    expect(saved.raw).toMatchObject({ replyToMessageId: reply.id, replyToExternalId: '1900000001', staffAsk: { taskId: t.id } });
    // 返信先に無いものや、タスクとしての送信は断る
    await expect(sendStaffAsk({ kind: 'task', taskId: t.id }, { roomId: 200, text: 'x', replyTo: '200-999' })).rejects.toThrow('返信先のメッセージが見つかりません');
    await expect(sendStaffAsk({ kind: 'task', taskId: t.id }, { staffId: staff.id, roomId: 200, text: 'x', replyTo: '200-1900000001', asTask: true })).rejects.toThrow('返信にはできません');
  });

  it('Chatwork で振られたタスクは、元のメッセージへの返信を既定にし、別の担当には [To] も付ける', async () => {
    const { client, staff } = seed();
    db().insert(schema.staffMembers).values({ name: '佐藤 事務', chatworkAccountId: 888 }).run();
    const t = db()
      .insert(schema.tasks)
      .values({ title: '相手方代理人に電話', status: 'open', clientId: client.id, chatworkRoomId: 500, chatworkTaskId: 9001, chatworkMessageId: '1800000001', chatworkAssignedById: 888, chatworkAssignedByName: '佐藤 事務' })
      .returning()
      .get();
    const ctx = await staffAskContext({ kind: 'task', taskId: t.id });
    expect(ctx.replyTargets[0]).toMatchObject({ key: '500-1800000001', roomId: 500, accountId: 888, senderName: '佐藤 事務', reason: 'task', excerpt: '相手方代理人に電話' });
    expect(ctx.defaultReplyKey).toBe('500-1800000001');
    sent.length = 0;
    await sendStaffAsk({ kind: 'task', taskId: t.id }, { staffId: staff.id, roomId: 500, text: '電話しました。来週回答があります', replyTo: '500-1800000001' });
    expect(sent[0]!.body.startsWith('[rp aid=888 to=500-1800000001][pname:888]さん\n[To:12345] 中村 事務さん\n')).toBe(true);
    // 振られたタスクに返信した印が付く
    expect(db().select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()!.chatworkRepliedAt).toBeTruthy();
  });

  it('タスクのきっかけになった Chatwork のメッセージにも返信できる（Gmail などは対象外）', async () => {
    const { client, kase, msg } = seed();
    const conv = db().insert(schema.conversations).values({ channel: 'chatwork', externalThreadId: '600', clientId: client.id, counterpartName: '事務局 全体' }).returning().get();
    const cwMsg = db()
      .insert(schema.messages)
      .values({ conversationId: conv.id, channel: 'chatwork', externalId: '1700000001', direction: 'in', senderName: '中村 事務', senderAddress: '12345', body: '[To:1] 山田さんの戸籍が届きました', sentAt: '2027-09-02T01:00:00.000Z' })
      .returning()
      .get();
    const fromCw = db().insert(schema.tasks).values({ title: '戸籍の確認', status: 'open', clientId: client.id, caseId: kase.id, sourceMessageId: cwMsg.id }).returning().get();
    const ctx = await staffAskContext({ kind: 'task', taskId: fromCw.id });
    expect(ctx.replyTargets.map((r) => [r.key, r.reason])).toEqual([['600-1700000001', 'source']]);
    expect(ctx.replyTargets[0]!.excerpt).toBe('@ 山田さんの戸籍が届きました');
    expect(ctx.rooms.some((r) => r.roomId === 600)).toBe(true);
    const fromMail = db().insert(schema.tasks).values({ title: '査定書の確認', status: 'open', clientId: client.id, caseId: kase.id, sourceMessageId: msg.id }).returning().get();
    expect((await staffAskContext({ kind: 'task', taskId: fromMail.id })).replyTargets).toEqual([]);
  });

  it('AI の下書きは「報告」と「確認・依頼」を選べる', async () => {
    const { client, kase } = seed();
    const t = db().insert(schema.tasks).values({ title: '答弁書案を作成', status: 'open', clientId: client.id, caseId: kase.id }).returning().get();
    aiCalls.length = 0;
    await draftStaffAsk({ kind: 'task', taskId: t.id }, { mode: 'report', instruction: '今日中に案を送る' });
    await draftStaffAsk({ kind: 'task', taskId: t.id }, { mode: 'ask' });
    expect(aiCalls[0]!.system).toContain('状況報告');
    expect(aiCalls[0]!.system).toContain('いまどこまで進んだか');
    expect(aiCalls[0]!.user).toContain('タスク（タスク「答弁書案を作成」）');
    expect(aiCalls[0]!.user).toContain('今日中に案を送る');
    expect(aiCalls[1]!.system).toContain('確認・依頼');
    expect(aiCalls[1]!.system).not.toContain('状況報告');
  });
});
