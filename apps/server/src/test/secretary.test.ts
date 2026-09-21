import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-secretary-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

// 記録の AI 整理と、道具の往復は本物を呼ばない（ここで見たいのは、案の検査と登録）
vi.mock('../integrations/anthropic.js', async (orig) => {
  const actual = await orig<typeof import('../integrations/anthropic.js')>();
  return {
    ...actual,
    generateStructured: vi.fn(async () => ({
      gist: '査定書は今週中に送付',
      decisions: ['今週中に送る'],
      nextActions: [{ title: '査定書の到着を確認する', due: null }],
      waitingFor: 'client',
      counterpart: '依頼者',
      phone: null,
      theirSaid: ['今週中に送る'],
      ourSaid: [],
    })),
  };
});

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { findClients, findCases, calendarInRange, describeAction, applySecretaryActions, secretaryActionSchema } = await import('../services/secretary.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

let clientId = 0;
let caseId = 0;

beforeEach(() => {
  db().delete(schema.caseNotes).run();
  db().delete(schema.tasks).run();
  db().delete(schema.calendarEvents).run();
  db().delete(schema.cases).run();
  db().delete(schema.clients).run();
  clientId = db().insert(schema.clients).values({ name: '山田 花子', kana: 'やまだ はなこ', aliases: ['山田(旧姓 田中)'] }).returning().get().id;
  caseId = db().insert(schema.cases).values({ clientId, title: '離婚調停申立事件', caseType: 'divorce', status: 'active' }).returning().get().id;
});

describe('秘書が調べるための道具', () => {
  it('名前の一部・かな・別名から依頼者を見つける', () => {
    expect(findClients('山田').map((c) => c.id)).toEqual([clientId]);
    expect(findClients('やまだ').map((c) => c.id)).toEqual([clientId]);
    expect(findClients('旧姓').map((c) => c.id)).toEqual([clientId]);
    expect(findClients('存在しない人')).toEqual([]);
    // 空文字で全件返さない（誤って別人に紐付けないため）
    expect(findClients('  ')).toEqual([]);
  });

  it('終わった依頼者は候補に出さない', () => {
    db().update(schema.clients).set({ archived: true }).where(eq(schema.clients.id, clientId)).run();
    expect(findClients('山田')).toEqual([]);
  });

  it('事件は依頼者で絞れ、進行中が先に出る', () => {
    const closed = db().insert(schema.cases).values({ clientId, title: '終わった事件', caseType: 'other', status: 'closed' }).returning().get();
    const other = db().insert(schema.clients).values({ name: '佐藤 太郎' }).returning().get();
    db().insert(schema.cases).values({ clientId: other.id, title: '交通事故', caseType: 'traffic', status: 'active' }).run();

    const mine = findCases({ clientId });
    expect(mine.map((c) => c.id)).toEqual([caseId, closed.id]);
    expect(mine[0]!.clientName).toBe('山田 花子');
    // 語でも絞れる
    expect(findCases({ query: '交通事故' }).map((c) => c.title)).toEqual(['交通事故']);
  });

  it('期間の予定だけを返す', () => {
    const at = (iso: string) => db().insert(schema.calendarEvents).values({ googleEventId: `g-${iso}`, kind: 'meeting', title: `打合せ ${iso}`, startAt: iso, endAt: iso, status: 'confirmed' }).run();
    at('2026-10-02T01:00:00.000Z');
    at('2026-10-03T05:00:00.000Z');
    at('2026-11-01T01:00:00.000Z');
    const r = calendarInRange('2026-10-01T00:00:00.000Z', '2026-10-31T23:59:59.000Z');
    expect(r.length).toBe(2);
    expect(r[0]!.startAt < r[1]!.startAt).toBe(true);
  });
});

describe('案の検査', () => {
  it('記録は事件が要る。日時は時差付きで受ける', () => {
    expect(secretaryActionSchema.safeParse({ type: 'note', summary: 'x', kind: 'phone', rawText: 'メモ' }).success).toBe(false);
    const ok = secretaryActionSchema.safeParse({ type: 'note', summary: 'x', caseId, kind: 'phone', occurredAt: '2026-10-03T14:00:00+09:00', rawText: 'メモ' });
    expect(ok.success).toBe(true);
  });

  it('知らない種類・知らない状態は受け付けない', () => {
    expect(secretaryActionSchema.safeParse({ type: 'mail', summary: 'x' }).success).toBe(false);
    expect(secretaryActionSchema.safeParse({ type: 'task', summary: 'x', title: 't', status: 'unknown' }).success).toBe(false);
    expect(secretaryActionSchema.safeParse({ type: 'event', summary: 'x', title: 't', startAt: '2026-10-03T14:00:00+09:00', endAt: '2026-10-03T15:00:00+09:00', kind: 'party' }).success).toBe(false);
  });

  it('一行の説明を作る', () => {
    expect(describeAction({ type: 'task', summary: '', title: '回答書を送る', status: 'open' })).toContain('回答書を送る');
    expect(describeAction({ type: 'event', summary: '', title: '山田　打合せ', startAt: '2026-10-03T05:00:00.000Z', endAt: '2026-10-03T06:00:00.000Z', kind: 'meeting' })).toContain('山田　打合せ');
  });
});

describe('確認したあとの登録', () => {
  it('記録・予定・タスクをまとめて登録する', async () => {
    const r = await applySecretaryActions([
      { type: 'note', summary: '電話記録', caseId, kind: 'phone', counterpart: '依頼者', rawText: '査定書は今週中に送るとのこと' },
      { type: 'event', summary: '打合せ', title: '山田　打合せ', startAt: '2026-10-03T14:00:00+09:00', endAt: '2026-10-03T15:00:00+09:00', kind: 'meeting', clientId, caseId, location: '事務所' },
      { type: 'task', summary: 'タスク', title: '査定書の到着を確認する', status: 'waiting_client', clientId, caseId },
    ]);
    expect(r.applied.every((a) => a.ok)).toBe(true);

    const note = db().select().from(schema.caseNotes).all()[0]!;
    expect(note.caseId).toBe(caseId);
    expect(note.rawText).toContain('査定書');
    // AI の整理も保存する（電話メモと同じ扱い）
    expect(note.gist).toBe('査定書は今週中に送付');

    const ev = db().select().from(schema.calendarEvents).all()[0]!;
    expect(ev.title).toBe('山田　打合せ');
    expect(ev.clientId).toBe(clientId);
    expect(new Date(ev.startAt).toISOString()).toBe('2026-10-03T05:00:00.000Z');

    const task = db().select().from(schema.tasks).all()[0]!;
    expect(task.status).toBe('waiting_client');
    // 返事待ちは催促日が自動で入る
    expect(task.followUpAt).toBeTruthy();
    expect(task.clientId).toBe(clientId);
  });

  it('1 件が失敗しても、残りは登録する', async () => {
    const r = await applySecretaryActions([
      { type: 'note', summary: '無い事件', caseId: 999999, kind: 'memo', rawText: 'メモ' },
      { type: 'task', summary: 'タスク', title: '書面を作る', status: 'open' },
    ]);
    expect(r.applied[0]!.ok).toBe(false);
    expect(r.applied[0]!.error).toContain('事件');
    expect(r.applied[1]!.ok).toBe(true);
    expect(db().select().from(schema.tasks).all().length).toBe(1);
  });

  it('AI の整理ができなくても、記録の本文は残す', async () => {
    const anthropic = await import('../integrations/anthropic.js');
    vi.mocked(anthropic.generateStructured).mockRejectedValueOnce(new Error('ANTHROPIC_API_KEY が設定されていません'));

    const r = await applySecretaryActions([{ type: 'note', summary: '電話記録', caseId, kind: 'phone', rawText: '査定書は今週中に送るとのこと' }]);
    expect(r.applied[0]!.ok).toBe(true);
    expect(r.applied[0]!.label).toContain('整理はできませんでした');
    const note = db().select().from(schema.caseNotes).all()[0]!;
    expect(note.rawText).toContain('査定書');
    expect(note.gist).toBeNull();
  });

  it('事件だけ指定したタスクは、その事件の依頼者に紐付く', async () => {
    await applySecretaryActions([{ type: 'task', summary: 'タスク', title: '答弁書を出す', status: 'open', caseId }]);
    expect(db().select().from(schema.tasks).all()[0]!.clientId).toBe(clientId);
  });
});
