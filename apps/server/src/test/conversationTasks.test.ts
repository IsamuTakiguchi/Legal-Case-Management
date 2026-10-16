import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-convtasks-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

/** AI に渡した内容と、返す案（テストごとに差し替える） */
let last = { system: '', user: '' };
let reply: Record<string, unknown> = { tasks: [], comment: '' };
vi.mock('../integrations/anthropic.js', async (orig) => ({
  ...(await orig<typeof import('../integrations/anthropic.js')>()),
  generateStructured: vi.fn(async (opts: { system: string; user: string }) => {
    last = { system: opts.system, user: opts.user };
    return reply;
  }),
}));

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { suggestConversationTasks, createConversationTasks } = await import('../services/conversationTasks.js');
const { setSetting } = await import('../services/settings.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => {
  openTestDatabase();
  setSetting('lawyer_name', '瀧口');
});
afterAll(() => closeDatabase());

let seq = 0;
function seed() {
  const n = ++seq;
  const client = db().insert(schema.clients).values({ name: '山田 花子' }).returning().get();
  const closed = db().insert(schema.cases).values({ clientId: client.id, title: '山田 旧件', status: 'closed' }).returning().get();
  const kase = db().insert(schema.cases).values({ clientId: client.id, title: '山田 離婚', status: 'active' }).returning().get();
  const conv = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: `u-${n}`, clientId: client.id, counterpartName: '山田 花子', lastMessageAt: '2026-10-15T01:00:00.000Z' }).returning().get();
  const msg = (direction: 'in' | 'out', body: string, at: string) =>
    db().insert(schema.messages).values({ conversationId: conv.id, clientId: client.id, channel: 'line', externalId: `m-${n}-${at}`, direction, senderName: direction === 'in' ? '山田 花子' : null, body, sentAt: at }).returning().get();
  msg('in', '戸籍謄本はどこで取ればいいですか？', '2026-10-14T01:00:00.000Z');
  msg('out', '確認して明日までにご連絡します。', '2026-10-14T02:00:00.000Z');
  const lastIn = msg('in', '源泉徴収票は来週金曜までにお送りします。', '2026-10-15T01:00:00.000Z');
  db().insert(schema.tasks).values({ title: '財産目録の作成', status: 'open', clientId: client.id }).run();
  return { client, kase, closed, conv, lastIn };
}

describe('会話からタスクを登録', () => {
  it('やり取り（自分と相手を分けて）と未了のタスクを AI に渡し、事件の候補を出す', async () => {
    const { kase, conv } = seed();
    reply = {
      tasks: [
        { title: '戸籍謄本の取り方を連絡', due: '2026-10-16', replyBy: '2026-10-20', status: 'open', note: '明日までに連絡すると伝えた' },
        { title: '源泉徴収票の受領待ち', due: null, replyBy: '10-24', status: 'waiting_client', note: '' },
      ],
      comment: '',
    };
    const r = await suggestConversationTasks(conv.id);
    expect(last.user).toContain('[山田 花子 ');
    expect(last.user).toContain('[自分（瀧口） ');
    expect(last.user).toContain('確認して明日までにご連絡します。');
    expect(last.user).toContain('未了のタスク（重複させない）:\n・財産目録の作成（対応中）');
    expect(last.system).toContain('こちらが約束したこと');
    // 返信待ちでないタスクの返信期限は捨てる
    expect(r.tasks[0]).toMatchObject({ title: '戸籍謄本の取り方を連絡', replyBy: null });
    // 事件の候補は進行中の事件だけ（終了事件は出さない）
    expect(r.cases).toEqual([{ id: kase.id, title: '山田 離婚' }]);
    expect(r.defaultCaseId).toBe(kase.id);
  });

  it('直した案をタスクにする（会話・依頼者・事件・きっかけの受信に紐付け、返信待ちは返信期限を持つ）', async () => {
    const { client, kase, conv, lastIn } = seed();
    const r = await createConversationTasks(conv.id, {
      tasks: [
        { title: '戸籍謄本の取り方を連絡', due: '2026-10-16', status: 'open', note: '明日までに連絡すると伝えた' },
        { title: '源泉徴収票の受領待ち', replyBy: '2026-10-23', status: 'waiting_client' },
        { title: '   ', status: 'open' },
      ],
    });
    expect(r.tasks.map((t) => t.title)).toEqual(['戸籍謄本の取り方を連絡', '源泉徴収票の受領待ち']);
    const [a, b] = r.tasks.map((t) => db().select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()!);
    expect(a).toMatchObject({ status: 'open', conversationId: conv.id, clientId: client.id, caseId: kase.id, sourceMessageId: lastIn.id, note: '明日までに連絡すると伝えた', followUpAt: null });
    expect(a!.dueAt).toBeTruthy();
    expect(b).toMatchObject({ status: 'waiting_client', conversationId: conv.id, caseId: kase.id });
    expect(b!.followUpAt).toBeTruthy();
    expect(b!.waitingSince).toBeTruthy();
  });

  it('事件に付けない・別の依頼者の事件は断る・空は断る', async () => {
    const { conv } = seed();
    const none = await createConversationTasks(conv.id, { tasks: [{ title: '連絡' }], caseId: null });
    expect(db().select().from(schema.tasks).where(eq(schema.tasks.id, none.tasks[0]!.id)).get()!.caseId).toBeNull();
    const other = seed();
    await expect(createConversationTasks(conv.id, { tasks: [{ title: '連絡' }], caseId: other.kase.id })).rejects.toThrow('この会話の依頼者の事件ではありません');
    await expect(createConversationTasks(conv.id, { tasks: [{ title: ' ' }] })).rejects.toThrow('登録するタスクがありません');
  });

  it('メッセージの無い会話では案を作らない', async () => {
    const conv = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: 'empty', counterpartName: 'x' }).returning().get();
    await expect(suggestConversationTasks(conv.id)).rejects.toThrow('まだメッセージがありません');
  });
});
