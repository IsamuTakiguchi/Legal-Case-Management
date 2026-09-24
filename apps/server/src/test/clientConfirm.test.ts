import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-clientconfirm-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.CHATWORK_API_TOKEN = 'cw-token';
process.env.ANTHROPIC_API_KEY = 'test-key';

/** 各チャネルに送った中身を控える（実際には送らない） */
const sent: { channel: string; to?: string | null; subject?: string | null; thread: string; text: string }[] = [];
let chatworkFails = false;
const fake = (channel: string) => ({
  isConfigured: () => true,
  async send(opts: { externalThreadId: string; to?: string | null; subject?: string | null; text: string }) {
    if (channel === 'chatwork' && chatworkFails) throw new Error('Chatwork に届きません');
    sent.push({ channel, to: opts.to, subject: opts.subject, thread: opts.externalThreadId, text: opts.text });
    const thread = opts.externalThreadId.startsWith('new:') ? `gmail-thread-${sent.length}` : opts.externalThreadId;
    return { externalId: `${channel}-out-${sent.length}`, externalThreadId: thread, sentAt: new Date().toISOString() };
  },
});
vi.mock('../channels/gmail.js', async (orig) => {
  const actual = await orig<typeof import('../channels/gmail.js')>();
  return { ...actual, gmailAdapter: { ...actual.gmailAdapter, ...fake('gmail') } };
});
vi.mock('../channels/line.js', async (orig) => {
  const actual = await orig<typeof import('../channels/line.js')>();
  return { ...actual, lineAdapter: { ...actual.lineAdapter, ...fake('line') } };
});
vi.mock('../channels/chatwork.js', async (orig) => {
  const actual = await orig<typeof import('../channels/chatwork.js')>();
  return { ...actual, chatworkAdapter: { ...actual.chatworkAdapter, ...fake('chatwork') } };
});
vi.mock('../services/lineFriends.js', async (orig) => ({ ...(await orig<typeof import('../services/lineFriends.js')>()), assertLineDeliverable: async () => undefined }));

/** AI に渡した指示を控え、決まった下書きを返す */
const prompts: { system: string; user: string }[] = [];
vi.mock('../integrations/anthropic.js', async (orig) => ({
  ...(await orig<typeof import('../integrations/anthropic.js')>()),
  generateText: vi.fn(async (opts: { system: string; user: string }) => {
    prompts.push({ system: opts.system, user: opts.user as string });
    return '山田様\n\nお世話になっております。\n源泉徴収票がお手元にあるか、ご確認いただけますでしょうか。';
  }),
}));

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { clientConfirmContext, draftClientConfirm, sendClientConfirm, confirmInstruction } = await import('../services/clientConfirm.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

let clientId = 0;
let caseId = 0;
let staffConvId = 0;
let questionId = 0;

function addMessage(opts: { conversationId: number; body: string; senderAddress?: string; direction?: string; clientId?: number | null; caseId?: number | null; minutesAgo?: number }) {
  return db()
    .insert(schema.messages)
    .values({
      conversationId: opts.conversationId,
      channel: 'chatwork',
      externalId: `cw-${Math.random().toString(36).slice(2)}`,
      direction: opts.direction ?? 'in',
      senderName: '事務 花子',
      senderAddress: opts.senderAddress ?? '5001',
      body: opts.body,
      sentAt: new Date(Date.now() - (opts.minutesAgo ?? 1) * 60_000).toISOString(),
      clientId: opts.clientId ?? null,
      caseId: opts.caseId ?? null,
    })
    .returning()
    .get();
}

beforeEach(() => {
  sent.length = 0;
  prompts.length = 0;
  chatworkFails = false;
  for (const t of [schema.styleSamples, schema.tasks, schema.drafts, schema.attachments, schema.messages, schema.conversations, schema.cases, schema.clients, schema.staffMembers]) db().delete(t).run();
  db().insert(schema.staffMembers).values({ name: '事務 花子', chatworkAccountId: 5001 }).run();
  const client = db().insert(schema.clients).values({ name: '山田 太郎', emails: ['yamada@example.com'], lineUserId: 'U-yamada', preferredChannel: 'line' }).returning().get();
  clientId = client.id;
  caseId = db().insert(schema.cases).values({ clientId, title: '自己破産申立事件', caseType: 'bankruptcy_personal', status: 'active' }).returning().get().id;
  staffConvId = db().insert(schema.conversations).values({ channel: 'chatwork', externalThreadId: '9100', counterpartName: '事務局ルーム', meta: { staff: true } }).returning().get().id;
  addMessage({ conversationId: staffConvId, body: '山田さんの申立書類を作っています', minutesAgo: 5 });
  questionId = addMessage({ conversationId: staffConvId, body: '[To:1001]先生\n山田さんに、令和6年分の源泉徴収票が手元にあるか確認してもらえますか？', clientId, caseId }).id;
});

describe('事務局の質問から依頼者に確認する', () => {
  it('事務局からの質問だと分かり、依頼者の Gmail と LINE を送り先に出す（いつもの LINE を既定に）', () => {
    const ctx = clientConfirmContext(questionId);
    expect(ctx.fromStaff).toBe(true);
    expect(ctx.staffName).toBe('事務 花子');
    expect(ctx.clientName).toBe('山田 太郎');
    expect(ctx.caseTitle).toBe('自己破産申立事件');
    expect(ctx.channels.map((c) => c.channel).sort()).toEqual(['gmail', 'line']);
    expect(ctx.defaultChannel).toBe('line');
    expect(ctx.blocked).toBeNull();
    // Chatwork の宛先タグは外して見せる
    expect(ctx.question.body).not.toContain('[To:');
    expect(ctx.question.body).toContain('源泉徴収票');
    // 直前のやり取りも参考に渡す
    expect(ctx.earlier.map((m) => m.body)).toEqual(['山田さんの申立書類を作っています']);
    expect(ctx.staffReplyText).toBe('山田さんにLINEで確認しました。回答が来たら共有します。');
  });

  it('依頼者が分からない伝言は、依頼者を選ぶまで送れない', () => {
    const q = addMessage({ conversationId: staffConvId, body: '先日の件、確認をお願いします' });
    expect(clientConfirmContext(q.id).blocked).toContain('どの依頼者への確認かを選んで');
    const picked = clientConfirmContext(q.id, { clientId });
    expect(picked.blocked).toBeNull();
    expect(picked.caseId).toBe(caseId);
  });

  it('メールも LINE も無い依頼者には送れない', () => {
    const other = db().insert(schema.clients).values({ name: '佐藤 次郎' }).returning().get();
    expect(clientConfirmContext(questionId, { clientId: other.id }).blocked).toContain('メールアドレスか LINE');
  });

  it('Chatwork 以外のメッセージや、自分の送信からは作らない', () => {
    const gm = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: 't1', clientId }).returning().get();
    const m = db().insert(schema.messages).values({ conversationId: gm.id, channel: 'gmail', externalId: 'g1', direction: 'in', body: 'x', sentAt: new Date().toISOString() }).returning().get();
    expect(() => clientConfirmContext(m.id)).toThrow('Chatwork');
    const mine = addMessage({ conversationId: staffConvId, body: '了解です', direction: 'out' });
    expect(() => clientConfirmContext(mine.id)).toThrow('自分が送った');
  });

  it('AI には「弁護士本人からの確認」に書き直すよう頼み、事務局の名前を出さないよう指示する', async () => {
    const r = await draftClientConfirm(questionId, { channel: 'gmail', instruction: '今週中に返事がほしい' });
    expect(r.text).toContain('源泉徴収票');
    // 新しいメールになるので件名も用意する
    expect(r.subject).toBe('ご確認のお願い（自己破産申立事件）');
    const user = prompts[0]!.user;
    expect(user).toContain('弁護士本人が依頼者に直接確認するメッセージに書き直して');
    expect(user).toContain('事務局や職員の名前');
    expect(user).toContain('令和6年分の源泉徴収票');
    expect(user).toContain('今週中に返事がほしい');
    // 本人の文体・チャネルの制約（Gmail は署名付き）で書く
    expect(prompts[0]!.system).toContain('本人の文体');
    expect(confirmInstruction({ question: { body: 'Q', senderName: null, sentAt: '' }, earlier: [], staffName: null, caseTitle: null })).not.toContain('その前のやり取り');
  });

  it('LINE で送ると、回答待ちタスクと事務局への返信までまとめて行い、質問に「確認済み」を残す', async () => {
    const r = await sendClientConfirm(questionId, {
      clientId,
      caseId,
      channel: 'line',
      text: '山田様\n源泉徴収票がお手元にあるか、ご確認いただけますでしょうか。',
      createWaitingTask: true,
      notifyStaff: true,
      staffReplyText: '山田さんにLINEで確認しました。',
    });
    expect(sent.map((s) => s.channel)).toEqual(['line', 'chatwork']);
    expect(sent[0]!.thread).toBe('U-yamada');
    // 事務局へは元の質問への返信として送る
    expect(sent[1]!.thread).toBe('9100');
    expect(sent[1]!.text).toContain('[rp aid=5001');
    expect(sent[1]!.text).toContain('山田さんにLINEで確認しました。');
    expect(r.staffNotified).toBe(true);

    // 依頼者との LINE の会話ができ、送った文は事件のやり取りとして残る
    const conv = db().select().from(schema.conversations).where(eq(schema.conversations.id, r.conversationId)).get()!;
    expect(conv.channel).toBe('line');
    expect(conv.clientId).toBe(clientId);
    const out = db().select().from(schema.messages).where(eq(schema.messages.id, r.messageId)).get()!;
    expect(out.caseId).toBe(caseId);

    const task = db().select().from(schema.tasks).where(eq(schema.tasks.id, r.waitingTaskId!)).get()!;
    expect(task.status).toBe('waiting_client');
    expect(task.caseId).toBe(caseId);
    expect(task.title).toContain('山田 太郎さんの回答待ち');
    expect(task.note).toContain('令和6年分の源泉徴収票');

    const ctx = clientConfirmContext(questionId);
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toMatchObject({ channel: 'line', conversationId: r.conversationId });
  });

  it('Gmail で新しいメールにするときは件名を付ける。事務局に返さない選択もできる', async () => {
    const r = await sendClientConfirm(questionId, { clientId, channel: 'gmail', text: '源泉徴収票のご確認をお願いします。', subject: '源泉徴収票のご確認', notifyStaff: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: 'gmail', to: 'yamada@example.com', subject: '源泉徴収票のご確認' });
    expect(r.waitingTaskId).toBeNull();
    // 実際のスレッド ID に置き換わる
    const conv = db().select().from(schema.conversations).where(eq(schema.conversations.id, r.conversationId)).get()!;
    expect(conv.externalThreadId.startsWith('new:')).toBe(false);
    expect(conv.subject).toBe('源泉徴収票のご確認');
  });

  it('既存の Gmail スレッドがあれば、そこへの返信にする（件名は変えない）', async () => {
    const existing = db()
      .insert(schema.conversations)
      .values({ channel: 'gmail', externalThreadId: 'thread-old', clientId, subject: '破産申立ての資料について', counterpartAddress: 'yamada@example.com', lastMessageAt: new Date().toISOString() })
      .returning()
      .get();
    const ctx = clientConfirmContext(questionId);
    expect(ctx.channels.find((c) => c.channel === 'gmail')).toMatchObject({ conversationId: existing.id, subject: '破産申立ての資料について' });
    const r = await sendClientConfirm(questionId, { clientId, channel: 'gmail', text: '確認です', subject: '無視される件名' });
    expect(r.conversationId).toBe(existing.id);
    expect(sent[0]).toMatchObject({ thread: 'thread-old', subject: '破産申立ての資料について' });
  });

  it('事務局への返信に失敗しても、依頼者への送信は取り消さない', async () => {
    chatworkFails = true;
    const r = await sendClientConfirm(questionId, { clientId, channel: 'line', text: '確認です', notifyStaff: true });
    expect(sent.map((s) => s.channel)).toEqual(['line']);
    expect(r.staffNotified).toBe(false);
    expect(r.staffError).toContain('Chatwork に届きません');
    expect(clientConfirmContext(questionId).sent).toHaveLength(1);
  });

  it('依頼者が未紐付けだった伝言は、送った依頼者・事件に紐付ける', async () => {
    const q = addMessage({ conversationId: staffConvId, body: '先日の件、確認をお願いします' });
    await sendClientConfirm(q.id, { clientId, channel: 'line', text: '確認です' });
    const after = db().select().from(schema.messages).where(eq(schema.messages.id, q.id)).get()!;
    expect(after.clientId).toBe(clientId);
    expect(after.caseId).toBe(caseId);
  });
});
