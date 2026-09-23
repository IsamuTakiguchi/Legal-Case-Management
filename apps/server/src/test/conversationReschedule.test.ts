import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-convresched-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

/** AI の読み取り結果をこちらで決める */
const aiResult: { current: Record<string, unknown> } = { current: {} };
const sentPrompts: string[] = [];
vi.mock('../integrations/anthropic.js', async (orig) => {
  const actual = await orig<typeof import('../integrations/anthropic.js')>();
  return {
    ...actual,
    generateStructured: vi.fn(async (opts: { user: string }) => {
      sentPrompts.push(opts.user);
      return aiResult.current;
    }),
  };
});

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { extractScheduleFromConversation, registerScheduleFromConversation, existingEventsForReschedule } = await import('../services/scheduleExtract.js');
const { confirmHold } = await import('../services/court.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

let clientId = 0;
let otherClientId = 0;
let caseId = 0;
let convId = 0;

const future = (days: number, hour = 5) => {
  const d = new Date(Date.now() + days * 86400_000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

function addEvent(opts: { clientId: number | null; startAt: string; kind?: string; title?: string; caseId?: number | null }) {
  return db()
    .insert(schema.calendarEvents)
    .values({
      googleEventId: `local-${Math.random().toString(36).slice(2)}`,
      clientId: opts.clientId,
      caseId: opts.caseId ?? null,
      kind: opts.kind ?? 'meeting',
      title: opts.title ?? '山田　打合せ',
      startAt: opts.startAt,
      endAt: new Date(new Date(opts.startAt).getTime() + 3600_000).toISOString(),
      location: '事務所',
      status: opts.kind === 'hold' ? 'tentative' : 'confirmed',
    })
    .returning()
    .get();
}

const events = () => db().select().from(schema.calendarEvents).all();

beforeEach(() => {
  sentPrompts.length = 0;
  db().delete(schema.schedulingSessions).run();
  db().delete(schema.calendarEvents).run();
  db().delete(schema.messages).run();
  db().delete(schema.conversations).run();
  db().delete(schema.cases).run();
  db().delete(schema.clients).run();
  clientId = db().insert(schema.clients).values({ name: '山田 花子' }).returning().get().id;
  otherClientId = db().insert(schema.clients).values({ name: '佐藤 太郎' }).returning().get().id;
  caseId = db().insert(schema.cases).values({ clientId, title: '離婚調停申立事件', caseType: 'divorce', status: 'active' }).returning().get().id;
  convId = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'U1', clientId }).returning().get().id;
  db()
    .insert(schema.messages)
    .values({ conversationId: convId, channel: 'line', externalId: 'm1', direction: 'in', senderName: '山田 花子', body: '10/3 の打合せですが、都合が悪くなったので 10/7 の 14 時に変えていただけますか', sentAt: new Date().toISOString() })
    .run();
});

const baseAi = (over: Record<string, unknown> = {}) => ({
  status: 'confirmed',
  content: '打合せ',
  kind: 'meeting',
  web: false,
  durationMinutes: 60,
  location: null,
  slots: [{ startAt: future(14), timeKnown: true, quote: '10/7 の 14 時', by: 'counterpart' }],
  note: '',
  reschedule: { isReschedule: false, originalIndex: null, quote: '' },
  ...over,
});

describe('会話から予定を登録するときの日程変更（リスケ）', () => {
  it('日程変更の元になりうるのは、同じ依頼者の仮押さえでない予定だけ', () => {
    const mine = addEvent({ clientId, startAt: future(10) });
    addEvent({ clientId, startAt: future(11), kind: 'hold', title: '山田　打合せ 仮' });
    addEvent({ clientId: otherClientId, startAt: future(12), title: '佐藤　打合せ' });
    // ずっと前の予定は入れない
    addEvent({ clientId, startAt: new Date(Date.now() - 60 * 86400_000).toISOString() });
    expect(existingEventsForReschedule(clientId).map((e) => e.id)).toEqual([mine.id]);
    expect(existingEventsForReschedule(null)).toEqual([]);
  });

  it('やり取りが日程変更なら、変更前の予定を読み取って返す', async () => {
    const a = addEvent({ clientId, startAt: future(10) });
    const b = addEvent({ clientId, startAt: future(20), title: '山田　第2回打合せ' });
    aiResult.current = baseAi({ reschedule: { isReschedule: true, originalIndex: 1, quote: '都合が悪くなったので' } });
    const r = await extractScheduleFromConversation(convId);
    expect(r.reschedule).toEqual({ eventId: a.id, quote: '都合が悪くなったので' });
    // 画面で選び直せるように、候補は全部返す
    expect(r.existingEvents.map((e) => e.id)).toEqual([a.id, b.id]);
    // AI にはすでに入っている予定を番号付きで渡している
    expect(sentPrompts[0]).toContain('[1]');
    expect(sentPrompts[0]).toContain('山田　第2回打合せ');
  });

  it('番号が範囲外なら、日程変更だがどれかは分からない扱いにする', async () => {
    addEvent({ clientId, startAt: future(10) });
    aiResult.current = baseAi({ reschedule: { isReschedule: true, originalIndex: 9, quote: '変えたい' } });
    const r = await extractScheduleFromConversation(convId);
    expect(r.reschedule).toEqual({ eventId: null, quote: '変えたい' });
  });

  it('新しく決める話なら、日程変更にしない', async () => {
    addEvent({ clientId, startAt: future(10) });
    aiResult.current = baseAi();
    expect((await extractScheduleFromConversation(convId)).reschedule).toBeNull();
  });

  it('確定で登録すると、新しい予定を入れてから元の予定を取り消す', async () => {
    const original = addEvent({ clientId, caseId, startAt: future(10) });
    const newStart = future(14);
    const r = await registerScheduleFromConversation(convId, {
      mode: 'confirmed',
      title: '山田　打合せ',
      kind: 'meeting',
      slots: [{ startAt: newStart, endAt: new Date(new Date(newStart).getTime() + 3600_000).toISOString() }],
      replaceEventId: original.id,
    });
    expect(r.mode).toBe('confirmed');
    expect(r.replaced?.id).toBe(original.id);
    const now = events();
    expect(now.some((e) => e.id === original.id)).toBe(false);
    expect(now.length).toBe(1);
    expect(now[0]!.startAt).toBe(newStart);
    // 事件を選ばなかったときは、元の予定の事件を引き継ぐ
    expect(now[0]!.caseId).toBe(caseId);
  });

  it('日程変更で途中まで作っていた仮押さえがあれば、それも片付ける', async () => {
    const original = addEvent({ clientId, startAt: future(10) });
    // 前に「候補を仮押さえ」で日程変更を始めていた
    const holds = await registerScheduleFromConversation(convId, {
      mode: 'holds',
      title: '打合せ',
      kind: 'meeting',
      slots: [{ startAt: future(15), endAt: future(15, 6) }],
      replaceEventId: original.id,
    });
    expect(holds.mode).toBe('holds');
    // やっぱり別の日時で確定した
    await registerScheduleFromConversation(convId, { mode: 'confirmed', title: '山田　打合せ', kind: 'meeting', slots: [{ startAt: future(14), endAt: future(14, 6) }], replaceEventId: original.id });
    const now = events();
    expect(now.length).toBe(1);
    expect(now.every((e) => e.kind !== 'hold')).toBe(true);
    const session = db().select().from(schema.schedulingSessions).all()[0]!;
    expect(session.state).toBe('cancelled');
  });

  it('候補を仮押さえにしたときは、確定した時点で元の予定を取り消す', async () => {
    const original = addEvent({ clientId, startAt: future(10), title: '山田　打合せ' });
    const r = await registerScheduleFromConversation(convId, {
      mode: 'holds',
      title: '打合せ',
      kind: 'meeting',
      slots: [
        { startAt: future(14), endAt: future(14, 6) },
        { startAt: future(15), endAt: future(15, 6) },
      ],
      replaceEventId: original.id,
    });
    expect(r.mode).toBe('holds');
    if (r.mode !== 'holds') throw new Error('unreachable');
    expect(r.replaces?.id).toBe(original.id);
    // 仮押さえの段階では元の予定は残る
    expect(events().some((e) => e.id === original.id)).toBe(true);
    // 件名は元の予定のものを引き継ぐ
    expect(r.events.every((e) => e.title === '山田　打合せ 仮')).toBe(true);

    await confirmHold(r.sessionId, r.events[0]!.id);
    const now = events();
    expect(now.some((e) => e.id === original.id)).toBe(false);
    expect(now.length).toBe(1);
    expect(now[0]!.title).toBe('山田　打合せ');
  });

  it('同じ予定の日程変更を、仮押さえで二重に始めない', async () => {
    const original = addEvent({ clientId, startAt: future(10) });
    const input = { mode: 'holds' as const, title: '打合せ', kind: 'meeting' as const, slots: [{ startAt: future(14), endAt: future(14, 6) }], replaceEventId: original.id };
    await registerScheduleFromConversation(convId, input);
    await expect(registerScheduleFromConversation(convId, input)).rejects.toThrow('すでに日程変更の調整中');
  });

  it('別の依頼者の予定や、仮押さえそのものは取り消さない', async () => {
    const others = addEvent({ clientId: otherClientId, startAt: future(10), title: '佐藤　打合せ' });
    const hold = addEvent({ clientId, startAt: future(11), kind: 'hold', title: '山田　打合せ 仮' });
    const slot = [{ startAt: future(14), endAt: future(14, 6) }];
    await expect(registerScheduleFromConversation(convId, { mode: 'confirmed', title: 't', kind: 'meeting', slots: slot, replaceEventId: others.id })).rejects.toThrow('別の依頼者');
    await expect(registerScheduleFromConversation(convId, { mode: 'confirmed', title: 't', kind: 'meeting', slots: slot, replaceEventId: hold.id })).rejects.toThrow('仮押さえ');
    await expect(registerScheduleFromConversation(convId, { mode: 'confirmed', title: 't', kind: 'meeting', slots: slot, replaceEventId: 999999 })).rejects.toThrow('見つかりません');
    // どれも失敗なので、新しい予定も入っていない（元の予定だけ消える、も起きない）
    expect(events().length).toBe(2);
  });

  it('日程変更でなければ、これまでどおり新しく入れるだけ', async () => {
    const original = addEvent({ clientId, startAt: future(10) });
    await registerScheduleFromConversation(convId, { mode: 'confirmed', title: '山田　打合せ', kind: 'meeting', slots: [{ startAt: future(14), endAt: future(14, 6) }] });
    expect(events().length).toBe(2);
    expect(events().some((e) => e.id === original.id)).toBe(true);
  });

  it('元の予定の取り消しに失敗しない限り、登録の失敗で元の予定を消さない', async () => {
    const original = addEvent({ clientId, startAt: future(10) });
    // 終わりが始まりより前 → 登録で失敗する
    await expect(
      registerScheduleFromConversation(convId, { mode: 'confirmed', title: '山田　打合せ', kind: 'meeting', slots: [{ startAt: future(14, 6), endAt: future(14, 5) }], replaceEventId: original.id }),
    ).rejects.toThrow();
    expect(db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, original.id)).get()).toBeTruthy();
  });
});
