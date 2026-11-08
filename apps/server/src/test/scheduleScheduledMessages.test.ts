import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-schedsched-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

/** AI に渡した指示と本文 */
const prompts: { system: string; user: string }[] = [];
vi.mock('../integrations/anthropic.js', async (orig) => ({
  ...(await orig<typeof import('../integrations/anthropic.js')>()),
  generateStructured: vi.fn(async (opts: { system: string; user: string; purpose: string }) => {
    prompts.push({ system: opts.system, user: opts.user });
    if (opts.purpose === '日程の希望の読み取り') {
      return { status: 'confirmed', content: '打合せ', kind: 'meeting', web: false, durationMinutes: 60, location: null, slots: [{ startAt: '2026-11-20T14:00:00+09:00', timeKnown: true, quote: '20日14時でお願いします', by: 'us' }], note: '', reschedule: { isReschedule: false, originalIndex: null, quote: '' } };
    }
    return { found: false, earliest: null, latest: null, weekdays: [], timeRanges: [], avoid: [], requested: [], web: null, durationMinutes: null, note: '' };
  }),
}));

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { scheduleTranscript, extractScheduleFromConversation, extractSchedulePreferences } = await import('../services/scheduleExtract.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

function seed(n: number) {
  const client = db().insert(schema.clients).values({ name: `山田 太郎${n}` }).returning().get();
  const conv = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: `t-${n}`, clientId: client.id, counterpartName: client.name }).returning().get();
  return { client, conv };
}

describe('会話から予定を登録: 送信予約も踏まえる', () => {
  it('まだ送っていない送信予約を、送る時刻の位置に「送信予約」として入れる（取り消した・送った予約は入れない）', () => {
    const { conv } = seed(1);
    db().insert(schema.messages).values({ conversationId: conv.id, channel: 'gmail', externalId: 'm1', direction: 'in', senderName: '山田', body: '20日14時か21日10時はいかがでしょうか', sentAt: '2026-11-07T01:00:00.000Z' }).run();
    db().insert(schema.scheduledMessages).values({ conversationId: conv.id, payload: {}, text: '20日14時でお願いします', scheduledAt: '2026-11-09T00:00:00.000Z', status: 'pending' }).run();
    db().insert(schema.scheduledMessages).values({ conversationId: conv.id, payload: {}, text: '取り消した文', scheduledAt: '2026-11-09T01:00:00.000Z', status: 'cancelled' }).run();
    db().insert(schema.scheduledMessages).values({ conversationId: conv.id, payload: {}, text: '送り終えた予約', scheduledAt: '2026-11-08T01:00:00.000Z', status: 'sent' }).run();
    const r = scheduleTranscript(conv.id, { me: '瀧口', who: '山田' });
    expect(r).toMatchObject({ count: 2, scheduled: 1 });
    expect(r.transcript.indexOf('20日14時か21日10時')).toBeLessThan(r.transcript.indexOf('20日14時でお願いします'));
    expect(r.transcript).toContain('[2026/11/9(月) 09:00 送信予約（まだ送っていないが、この時刻に送る）] 瀧口（自分）:\n20日14時でお願いします');
    expect(r.transcript).not.toContain('取り消した文');
    expect(r.transcript).not.toContain('送り終えた予約');
  });

  it('予定の読み取りと相手の希望の読み取りの両方に、送信予約と、その読み方を渡す', async () => {
    const { conv } = seed(2);
    db().insert(schema.messages).values({ conversationId: conv.id, channel: 'gmail', externalId: 'm2', direction: 'in', senderName: '山田', body: '20日14時はいかがでしょうか', sentAt: '2026-11-07T01:00:00.000Z' }).run();
    db().insert(schema.scheduledMessages).values({ conversationId: conv.id, payload: {}, text: '20日14時でお願いします', scheduledAt: '2026-11-09T00:00:00.000Z', status: 'pending' }).run();
    prompts.length = 0;
    const r = await extractScheduleFromConversation(conv.id);
    expect(r.status).toBe('confirmed');
    await extractSchedulePreferences(conv.id);
    expect(prompts).toHaveLength(2);
    for (const p of prompts) {
      expect(p.user).toContain('送信予約');
      expect(p.user).toContain('20日14時でお願いします');
      expect(p.system).toContain('送ったものとして読んでください');
    }
  });

  it('送信予約しかない会話でも読み取れる', async () => {
    const { conv } = seed(3);
    db().insert(schema.scheduledMessages).values({ conversationId: conv.id, payload: {}, text: '11月20日14時からの打合せでいかがでしょうか', scheduledAt: '2026-11-09T00:00:00.000Z', status: 'pending' }).run();
    await expect(extractScheduleFromConversation(conv.id)).resolves.toBeTruthy();
  });
});
