import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-restruct-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

/** AI に渡された中身を見たいので、生成は差し替える */
const calls: { user: string }[] = [];
vi.mock('../integrations/anthropic.js', () => ({
  generateStructured: vi.fn(async (o: { user: string }) => {
    calls.push({ user: o.user });
    return {
      gist: '整理した要旨',
      theirSaid: ['相手が言ったこと'],
      ourSaid: ['こちらが言ったこと'],
      phone: '0742-23-8710',
      decisions: ['決まったこと'],
      nextActions: [{ title: '書面を送る', due: '2027-10-05', owner: 'self' }],
      waitingFor: 'client',
      counterpart: '山田 花子',
    };
  }),
  generateText: vi.fn(async () => ''),
}));

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { addCaseNote, restructureNote } = await import('../services/cases.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

const base = { theirSaid: [], ourSaid: [], decisions: [], nextActions: [], attachments: [] };

async function seedNote(rawText: string) {
  const client = db().insert(schema.clients).values({ name: '山田 花子' }).returning().get();
  const kase = db().insert(schema.cases).values({ clientId: client.id, title: '山田 交通事故' }).returning().get();
  const note = await addCaseNote({ ...base, caseId: kase.id, kind: 'phone', rawText, gist: null, waitingFor: null });
  return { client, kase, note };
}

describe('保存済みの記録を AI で整理し直す', () => {
  it('画面で直したメモを渡すと、その内容で整理される', async () => {
    calls.length = 0;
    const { note } = await seedNote('もとのメモ');
    const r = await restructureNote(note.id, { rawText: '直したメモ。和解案の説明をした。', kind: 'meeting', counterpart: '山田', phone: null });
    expect(r.gist).toBe('整理した要旨');
    expect(r.nextActions[0]!.title).toBe('書面を送る');
    // 保存済みの古いメモではなく、渡したメモが AI に行く
    expect(calls[0]!.user).toContain('直したメモ。和解案の説明をした。');
    expect(calls[0]!.user).not.toContain('もとのメモ');
    // 事件・依頼者・種別・相手も文脈として渡す
    expect(calls[0]!.user).toContain('山田 交通事故');
    expect(calls[0]!.user).toContain('山田 花子');
    expect(calls[0]!.user).toContain('meeting');
  });

  it('メモを渡さなければ、保存済みのメモを使う', async () => {
    calls.length = 0;
    const { note } = await seedNote('保存済みのメモです');
    await restructureNote(note.id, {});
    expect(calls[0]!.user).toContain('保存済みのメモです');
  });

  it('整理しただけでは、記録は書き換わらない（保存は別）', async () => {
    const { note } = await seedNote('もとのメモ');
    await restructureNote(note.id, { rawText: '直したメモ' });
    const after = db().select().from(schema.caseNotes).where(eq(schema.caseNotes.id, note.id)).get();
    expect(after?.rawText).toBe('もとのメモ');
    expect(after?.gist).toBeNull();
    expect(after?.decisions.length).toBe(0);
  });

  it('メモが空なら、そのまま伝える', async () => {
    const { note } = await seedNote('');
    await expect(restructureNote(note.id, { rawText: '   ' })).rejects.toThrow(/メモがありません/);
  });

  it('無い記録を指定したらエラーになる', async () => {
    await expect(restructureNote(99999, { rawText: 'x' })).rejects.toThrow(/記録が見つかりません/);
  });
});

const { eq } = await import('drizzle-orm');
