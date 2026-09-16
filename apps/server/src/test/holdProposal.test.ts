import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-holdprop-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.CHATWORK_API_TOKEN = 'cw-token';

/** 送信した本文を控える（実際には送らない） */
const sent: { roomId: number; text: string }[] = [];
vi.mock('../channels/chatwork.js', async (importActual) => {
  const actual = await importActual<typeof import('../channels/chatwork.js')>();
  return {
    ...actual,
    chatworkAdapter: {
      ...actual.chatworkAdapter,
      async send(opts: { externalThreadId: string; text: string }) {
        sent.push({ roomId: Number(opts.externalThreadId), text: opts.text });
        return { externalId: `cw-${sent.length}`, externalThreadId: opts.externalThreadId, sentAt: '2027-09-01T02:00:00.000Z' };
      },
    },
  };
});

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { holdProposalContext, sendHoldProposal, buildProposalText, formatSlotLine } = await import('../services/holdProposal.js');
const { setSetting } = await import('../services/settings.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

/** 仮押さえ 2 件ぶんのセッションと、その候補の予定を作る */
function seed(opts: { withConversation?: boolean; clientId?: number | null } = {}) {
  const client =
    opts.clientId === null
      ? null
      : db().insert(schema.clients).values({ name: '山田 花子', preferredChannel: 'chatwork', chatworkRoomId: 300 }).returning().get();
  const kase = client ? db().insert(schema.cases).values({ clientId: client.id, title: '山田 離婚' }).returning().get() : null;
  const slots = [
    { startAt: '2027-10-05T01:00:00.000Z', endAt: '2027-10-05T02:00:00.000Z' }, // JST 10:00〜11:00（月）
    { startAt: '2027-10-06T01:00:00.000Z', endAt: '2027-10-06T02:00:00.000Z' }, // JST 10:00〜11:00（火）
  ];
  const session = db()
    .insert(schema.schedulingSessions)
    .values({ clientId: client?.id ?? null, conversationId: null, kind: '打合せ', state: 'proposing', candidates: [], proposedAt: null })
    .returning()
    .get();
  const candidates = slots.map((sl, i) => {
    db()
      .insert(schema.calendarEvents)
      .values({ googleEventId: `hold-${session.id}-${i}`, clientId: client?.id ?? null, caseId: kase?.id ?? null, kind: 'hold', title: '山田 打合せ 仮', startAt: sl.startAt, endAt: sl.endAt })
      .run();
    return { ...sl, eventId: `hold-${session.id}-${i}` };
  });
  db().update(schema.schedulingSessions).set({ candidates }).where(eq(schema.schedulingSessions.id, session.id)).run();

  let conv = null;
  if (client && opts.withConversation !== false) {
    conv = db()
      .insert(schema.conversations)
      .values({ channel: 'chatwork', externalThreadId: `${300 + session.id}`, clientId: client.id, caseId: kase!.id, counterpartName: '山田 花子', lastMessageAt: '2027-09-01T01:00:00.000Z' })
      .returning()
      .get();
  }
  return { client, kase, session, conv, candidates };
}

describe('仮押さえた候補日の打診', () => {
  it('既定の書き方は「10/5 10:00-」を並べた文になる', () => {
    const { session } = seed();
    const ctx = holdProposalContext(session.id);
    expect(ctx.text).toBe('打合せの候補日ですが、\n10/5 10:00-\n10/6 10:00-\nでいかがでしょうか？');
    expect(ctx.candidates).toHaveLength(2);
    expect(ctx.blocked).toBeNull();
  });

  it('書き方は設定で変えられる（曜日・終了時刻も入れられる）', () => {
    expect(formatSlotLine('2027-10-05T01:00:00.000Z', '2027-10-05T02:30:00.000Z', '{M}月{D}日({wd}) {start}〜{end}')).toBe('10月5日(火) 10:00〜11:30');
    setSetting('hold_proposal_slot_format', '{M}/{D}({wd}) {start}〜{end}');
    setSetting('hold_proposal_template', '{client}様\n\n{kind}の候補です。\n{slots}\nご都合はいかがでしょうか。');
    const { session } = seed();
    expect(holdProposalContext(session.id).text).toBe('山田 花子様\n\n打合せの候補です。\n10/5(火) 10:00〜11:00\n10/6(水) 10:00〜11:00\nご都合はいかがでしょうか。');
    // 既定に戻す
    setSetting('hold_proposal_slot_format', '');
    setSetting('hold_proposal_template', '');
    expect(buildProposalText({ kind: '面談', clientName: null, candidates: [{ startAt: '2027-10-05T01:00:00.000Z', endAt: '2027-10-05T02:00:00.000Z' }] })).toBe(
      '面談の候補日ですが、\n10/5 10:00-\nでいかがでしょうか？',
    );
  });

  it('取り消した候補は打診に出さない', () => {
    const { session, candidates } = seed();
    db().delete(schema.calendarEvents).where(eq(schema.calendarEvents.googleEventId, candidates[1]!.eventId)).run();
    const ctx = holdProposalContext(session.id);
    expect(ctx.candidates).toHaveLength(1);
    expect(ctx.text).toBe('打合せの候補日ですが、\n10/5 10:00-\nでいかがでしょうか？');
  });

  it('依頼者との会話に送り、返事待ちのタスクも作れる', async () => {
    sent.length = 0;
    const { session, conv, client, kase } = seed();
    const ctx = holdProposalContext(session.id);
    expect(ctx.defaultConversationId).toBe(conv!.id);
    const r = await sendHoldProposal(session.id, { conversationId: conv!.id, text: ctx.text, createWaitingTask: true });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe('打合せの候補日ですが、\n10/5 10:00-\n10/6 10:00-\nでいかがでしょうか？');
    // 打診した会話がセッションに残り、あとから会話をたどれる
    const after = db().select().from(schema.schedulingSessions).where(eq(schema.schedulingSessions.id, session.id)).get()!;
    expect(after.conversationId).toBe(conv!.id);
    expect(after.proposedAt).toBeTruthy();
    // 返事待ちは依頼者待ちで、事件にも紐付く
    const task = db().select().from(schema.tasks).where(eq(schema.tasks.id, r.waitingTaskId!)).get()!;
    expect([task.status, task.clientId, task.caseId, task.conversationId]).toEqual(['waiting_client', client!.id, kase!.id, conv!.id]);
    expect(task.title).toContain('候補日の返事待ち');
  });

  it('依頼者が未紐付け・会話が無いときは、その理由を出す', () => {
    const a = seed({ clientId: null });
    expect(holdProposalContext(a.session.id).blocked).toContain('依頼者が紐付いていません');
    const b = seed({ withConversation: false });
    expect(holdProposalContext(b.session.id).blocked).toContain('会話がありません');
  });

  it('この会話のものでない送り先には送れない', async () => {
    const { session } = seed();
    const other = seed();
    await expect(sendHoldProposal(session.id, { conversationId: other.conv!.id, text: 'こんにちは' })).rejects.toThrow(/送り先の会話が選ばれていません/);
    // 本文が空でも送らない
    await expect(sendHoldProposal(session.id, { conversationId: 99999, text: '   ' })).rejects.toThrow(/本文を入力してください/);
  });

  it('確定・取消済みの日程調整は打診できない', () => {
    const { session } = seed();
    db().update(schema.schedulingSessions).set({ state: 'confirmed' }).where(eq(schema.schedulingSessions.id, session.id)).run();
    expect(() => holdProposalContext(session.id)).toThrow(/確定または取消/);
  });
});
