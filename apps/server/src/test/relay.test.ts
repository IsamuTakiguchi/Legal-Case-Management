import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-relay-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = 'test-key';

/** AI に渡した指示と宛名（下書きはそれを返す） */
const drafted: { instruction: string; contactName?: string | null; counterpartName?: string | null }[] = [];
vi.mock('../services/style.js', async (orig) => ({
  ...(await orig<typeof import('../services/style.js')>()),
  draftReply: vi.fn(async (req: { instruction: string }, ctx: { contactName?: string | null; counterpartName?: string | null }) => {
    drafted.push({ instruction: req.instruction, contactName: ctx.contactName, counterpartName: ctx.counterpartName });
    return '下書きの本文';
  }),
}));

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { setAdapter } = await import('../channels/registry.js');
const { relayContext, draftRelay, sendRelay } = await import('../services/relay.js');
const { getConversation } = await import('../services/inbox.js');
const { eq } = await import('drizzle-orm');

/** Gmail に送ったもの（実際には送らない） */
const sent: { to: string | null | undefined; subject: string | null | undefined; text: string }[] = [];
let seq = 0;
setAdapter('gmail', {
  channel: 'gmail',
  isConfigured: () => true,
  fetchAttachment: async () => Buffer.alloc(0),
  send: async (o) => {
    sent.push({ to: o.to, subject: o.subject, text: o.text });
    seq++;
    // 既存のスレッドへの返信はそのスレッド、新しいメールは新しいスレッド
    return { externalId: `g-${seq}`, externalThreadId: o.externalThreadId.startsWith('new:') ? `thread-${seq}` : o.externalThreadId, sentAt: new Date().toISOString() };
  },
});

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());
beforeEach(() => {
  sent.length = 0;
  drafted.length = 0;
});

let n = 0;
/** 依頼者・事件・相手方代理人と、それぞれとの会話・受信メッセージ */
function seed(opts: { counselEmail?: string | null } = {}) {
  n++;
  const client = db().insert(schema.clients).values({ name: `山田 太郎${n}`, emails: [`yamada${n}@example.com`] }).returning().get();
  const kase = db().insert(schema.cases).values({ clientId: client.id, title: `山田 離婚${n}` }).returning().get();
  const counsel = db()
    .insert(schema.caseContacts)
    .values({ caseId: kase.id, role: 'opponent_counsel', name: '鈴木 一郎', organization: '鈴木法律事務所', emails: opts.counselEmail === null ? [] : [opts.counselEmail ?? `suzuki${n}@law.example.com`], fax: '03-1111-2222' })
    .returning()
    .get();
  const clientConv = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: `c-${n}`, clientId: client.id, counterpartName: client.name, counterpartAddress: client.emails[0] }).returning().get();
  const fromClient = db()
    .insert(schema.messages)
    .values({ conversationId: clientConv.id, channel: 'gmail', externalId: `cm-${n}`, direction: 'in', senderName: client.name, body: '面会交流は月2回を希望すると伝えてください。正直、相手の顔も見たくないです。', sentAt: '2026-10-29T01:00:00.000Z' })
    .returning()
    .get();
  const counselConv = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: `k-${n}`, clientId: client.id, caseId: kase.id, contactId: counsel.id, counterpartName: '鈴木 一郎', counterpartAddress: counsel.emails[0] ?? null, subject: '面会交流の件' }).returning().get();
  const fromCounsel = db()
    .insert(schema.messages)
    .values({ conversationId: counselConv.id, channel: 'gmail', externalId: `km-${n}`, direction: 'in', senderName: '鈴木 一郎', body: '養育費の算定のため、ご依頼者の源泉徴収票の写しを11月10日までにご送付ください。', sentAt: '2026-10-29T02:00:00.000Z' })
    .returning()
    .get();
  return { client, kase, counsel, clientConv, fromClient, counselConv, fromCounsel };
}

describe('依頼者からの連絡を、相手方代理人に伝える', () => {
  it('依頼者との会話のメッセージなら、事件の相手方代理人が宛先になる', () => {
    const s = seed();
    const ctx = relayContext(s.fromClient.id);
    expect(ctx.direction).toBe('to_counterparty');
    expect(ctx.caseId).toBe(s.kase.id);
    expect(ctx.targets[0]).toMatchObject({ kind: 'contact', contactId: s.counsel.id, channel: 'gmail', recipient: '鈴木 一郎', roleLabel: '相手方代理人', subject: '面会交流の件' });
    expect(ctx.defaultTargetKey).toBe(`contact:${s.counsel.id}:gmail`);
    expect(ctx.blocked).toBeNull();
  });

  it('AI には代理人間の連絡に書き直すよう指示し、依頼者の内心などは書かないよう伝える。宛名は相手方代理人', async () => {
    const s = seed();
    await draftRelay(s.fromClient.id, { targetKey: `contact:${s.counsel.id}:gmail`, instruction: '丁寧に' });
    expect(drafted[0]!.instruction).toContain('相手方代理人（鈴木 一郎）に伝えるべきこと');
    expect(drafted[0]!.instruction).toContain('内心');
    expect(drafted[0]!.instruction).toContain('面会交流は月2回');
    expect(drafted[0]!.instruction).toContain('【弁護士からの追加の指示（最優先）】\n丁寧に');
    expect(drafted[0]!.contactName).toBe('鈴木法律事務所 鈴木 一郎');
  });

  it('相手方代理人とのメールに返信として送り、元のメッセージに伝えた記録を残す。回答待ちタスクも作れる', async () => {
    const s = seed();
    const r = await sendRelay(s.fromClient.id, { targetKey: `contact:${s.counsel.id}:gmail`, text: '当方依頼者は面会交流を月2回希望しております。', createWaitingTask: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: s.counsel.emails[0], subject: '面会交流の件' });
    expect(r).toMatchObject({ direction: 'to_counterparty', conversationId: s.counselConv.id, recipient: '鈴木 一郎' });
    const out = db().select().from(schema.messages).where(eq(schema.messages.id, r.messageId!)).get()!;
    expect(out).toMatchObject({ direction: 'out', caseId: s.kase.id, clientId: s.client.id });
    const src = getConversation(s.clientConv.id)!.messages.find((m) => m.id === s.fromClient.id)!;
    expect(src.relays).toEqual([expect.objectContaining({ direction: 'to_counterparty', recipient: '鈴木 一郎', channel: 'gmail', conversationId: s.counselConv.id })]);
    // 元のメッセージにも事件が付く
    expect(src.caseId).toBe(s.kase.id);
    const task = db().select().from(schema.tasks).where(eq(schema.tasks.id, r.waitingTaskId!)).get()!;
    expect(task).toMatchObject({ status: 'waiting_other', caseId: s.kase.id });
    expect(task.title).toContain('相手方代理人（鈴木）の回答待ち');
  });

  it('相手方代理人とまだメールしていなければ、新しいメールで送る（件名つき）', async () => {
    const s = seed();
    db().delete(schema.messages).where(eq(schema.messages.conversationId, s.counselConv.id)).run();
    db().delete(schema.conversations).where(eq(schema.conversations.id, s.counselConv.id)).run();
    const r = await sendRelay(s.fromClient.id, { targetKey: `contact:${s.counsel.id}:gmail`, text: 'ご連絡です。', subject: null });
    expect(sent[0]).toMatchObject({ to: s.counsel.emails[0], subject: `ご連絡（${s.kase.title}）` });
    const conv = db().select().from(schema.conversations).where(eq(schema.conversations.id, r.conversationId!)).get()!;
    expect(conv).toMatchObject({ contactId: s.counsel.id, caseId: s.kase.id, clientId: s.client.id });
  });

  it('メールの無い代理人（FAX・郵送）は送れないが、文面を作り、送ったことを記録できる', async () => {
    const s = seed({ counselEmail: null });
    const ctx = relayContext(s.fromClient.id);
    expect(ctx.targets[0]).toMatchObject({ key: `contact:${s.counsel.id}:manual`, channel: null, to: 'FAX 03-1111-2222' });
    await draftRelay(s.fromClient.id, { targetKey: `contact:${s.counsel.id}:manual` });
    expect(drafted).toHaveLength(1);
    await expect(sendRelay(s.fromClient.id, { targetKey: `contact:${s.counsel.id}:manual`, text: 'x' })).rejects.toThrow('アプリから送れません');
    const r = await sendRelay(s.fromClient.id, { targetKey: `contact:${s.counsel.id}:manual`, text: 'FAX で送った文', manual: true });
    expect(r).toMatchObject({ channel: 'manual', conversationId: null });
    expect(sent).toHaveLength(0);
    expect(getConversation(s.clientConv.id)!.messages.find((m) => m.id === s.fromClient.id)!.relays[0]).toMatchObject({ channel: 'manual' });
  });

  it('関係者が登録されていなければ、その旨を返す', () => {
    const s = seed();
    db().update(schema.conversations).set({ contactId: null }).where(eq(schema.conversations.contactId, s.counsel.id)).run();
    db().delete(schema.caseContacts).where(eq(schema.caseContacts.id, s.counsel.id)).run();
    expect(relayContext(s.fromClient.id).blocked).toContain('関係者が登録されていません');
  });
});

describe('相手方代理人からの連絡を、依頼者に伝える', () => {
  it('関係者との会話のメッセージなら、その事件の依頼者が宛先になる', () => {
    const s = seed();
    const ctx = relayContext(s.fromCounsel.id);
    expect(ctx.direction).toBe('to_client');
    expect(ctx.from).toMatchObject({ contactId: s.counsel.id, name: '鈴木 一郎', roleLabel: '相手方代理人' });
    expect(ctx.targets[0]).toMatchObject({ kind: 'client', channel: 'gmail', recipient: s.client.name, conversationId: s.clientConv.id });
  });

  it('AI には依頼者に分かる言葉で伝え、答えてほしいことを並べるよう指示する', async () => {
    const s = seed();
    await draftRelay(s.fromCounsel.id, { targetKey: `client:0:gmail` });
    expect(drafted[0]!.instruction).toContain('相手方代理人（鈴木 一郎）から届いた連絡・質問を、弁護士から依頼者');
    expect(drafted[0]!.instruction).toContain('平易な言葉');
    expect(drafted[0]!.instruction).toContain('源泉徴収票');
    expect(drafted[0]!.contactName).toBeUndefined();
  });

  it('依頼者に送り、依頼者の回答待ちタスクを作る', async () => {
    const s = seed();
    const r = await sendRelay(s.fromCounsel.id, { targetKey: 'client:0:gmail', text: '相手方代理人から、源泉徴収票の写しを送るよう依頼がありました。', createWaitingTask: true });
    expect(sent[0]!.to).toBe(s.client.emails[0]);
    expect(r).toMatchObject({ direction: 'to_client', conversationId: s.clientConv.id });
    expect(db().select().from(schema.tasks).where(eq(schema.tasks.id, r.waitingTaskId!)).get()).toMatchObject({ status: 'waiting_client', clientId: s.client.id, caseId: s.kase.id });
  });

  it('自分が送ったメッセージ・未紐付けの会話からは作れない', () => {
    const s = seed();
    const out = db().insert(schema.messages).values({ conversationId: s.clientConv.id, channel: 'gmail', externalId: `o-${n}`, direction: 'out', body: 'x', sentAt: '2026-10-29T03:00:00.000Z' }).returning().get();
    expect(() => relayContext(out.id)).toThrow('自分が送った');
    const loose = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: `loose-${n}` }).returning().get();
    const m = db().insert(schema.messages).values({ conversationId: loose.id, channel: 'gmail', externalId: `l-${n}`, direction: 'in', body: 'x', sentAt: '2026-10-29T03:00:00.000Z' }).returning().get();
    expect(() => relayContext(m.id)).toThrow('紐付いた会話');
  });
});
