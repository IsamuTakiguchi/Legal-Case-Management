import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-dueyear-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

// AI が「11/10」を去年と読んだ場合を再現する（今日から 1 か月先の月日を、去年の日付で返す）
const prompts: string[] = [];
const ahead = new Date(Date.now() + 35 * 86400_000);
const pad = (n: number) => String(n).padStart(2, '0');
const jst = new Date(ahead.getTime() + 9 * 3600_000);
const md = `${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())}`;
const thisYear = jst.getUTCFullYear();
vi.mock('../integrations/anthropic.js', async (orig) => ({
  ...(await orig<typeof import('../integrations/anthropic.js')>()),
  generateStructured: vi.fn(async (opts: { user: string; purpose?: string }) => {
    prompts.push(opts.user);
    if (opts.purpose === '記録からのタスク案') return { tasks: [{ title: '答弁書を提出', due: `${thisYear - 1}-${md}`, status: 'open', note: '' }], comment: '' };
    return { gist: '要旨', theirSaid: [], ourSaid: [], phone: null, decisions: [], nextActions: [{ title: '答弁書を提出', due: `${thisYear - 1}-${md}`, owner: 'self' }], waitingFor: 'none', counterpart: null };
  }),
}));

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { structureNote, suggestNoteTasks } = await import('../services/cases.js');
const { fixDueYear, dateOnlyDeadline, isDateOnlyDeadline, taskDeadline } = await import('@lcm/shared');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

describe('記録の期限の年', () => {
  it('年の無い日付を去年と読んでも、今年（来るほう）の日付に直す。AI には年まで渡す', async () => {
    const r = await structureNote('11/10 までに答弁書', { kind: 'phone' });
    expect(r.nextActions[0]!.due).toBe(`${thisYear}-${md}`);
    expect(prompts[0]).toMatch(new RegExp(`今日: ${new Date(Date.now() + 9 * 3600_000).getUTCFullYear()}年`));

    const client = db().insert(schema.clients).values({ name: '年 太郎' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '答弁書事件', caseType: 'civil', status: 'active' }).returning().get();
    const note = db().insert(schema.caseNotes).values({ caseId: kase.id, clientId: client.id, kind: 'phone', occurredAt: new Date().toISOString(), rawText: '11/10 までに答弁書' }).returning().get();
    const s = await suggestNoteTasks(note.id);
    expect(s.tasks[0]!.due).toBe(`${thisYear}-${md}`);
  });

  it('直近に過ぎた期限はそのまま。90 日より前なら翌年にする', () => {
    const now = new Date('2026-10-06T03:00:00Z');
    expect(fixDueYear('2025-11-10', now)).toBe('2026-11-10');
    expect(fixDueYear('2026-09-30', now)).toBe('2026-09-30');
    expect(fixDueYear('2025-10-01', now)).toBe('2026-10-01');
    expect(fixDueYear('2027-01-05', now)).toBe('2027-01-05');
    expect(fixDueYear(null, now)).toBeNull();
  });
});

describe('日付だけの期限と、返信待ちの期限', () => {
  it('日付だけの期限はその日の終わり。時刻を決めた期限とは見分けられる', () => {
    const d = dateOnlyDeadline('2026-11-10');
    expect(d).toBe(new Date('2026-11-10T23:59:59.999+09:00').toISOString());
    expect(isDateOnlyDeadline(d)).toBe(true);
    expect(isDateOnlyDeadline(new Date('2026-11-10T10:00:00+09:00').toISOString())).toBe(false);
  });

  it('返信待ちは返信期限と締切の早いほうを期限とし、対応中は締切だけを見る', () => {
    const reply = dateOnlyDeadline('2026-10-10');
    const due = dateOnlyDeadline('2026-10-15');
    expect(taskDeadline({ status: 'waiting_client', followUpAt: reply, dueAt: due })).toBe(reply);
    // 締切のほうが先なら締切
    expect(taskDeadline({ status: 'waiting_client', followUpAt: dateOnlyDeadline('2026-10-20'), dueAt: due })).toBe(due);
    expect(taskDeadline({ status: 'open', followUpAt: reply, dueAt: due })).toBe(due);
  });
});
