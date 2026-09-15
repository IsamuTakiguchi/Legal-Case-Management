import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-notetask-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { createTasksFromNote } = await import('../services/cases.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

function seedNote(over: Partial<typeof schema.caseNotes.$inferInsert> = {}) {
  const client = db().insert(schema.clients).values({ name: '山田 花子' }).returning().get();
  const kase = db().insert(schema.cases).values({ clientId: client.id, title: '山田 離婚' }).returning().get();
  const note = db()
    .insert(schema.caseNotes)
    .values({
      caseId: kase.id,
      clientId: client.id,
      kind: 'phone',
      occurredAt: '2027-08-01T01:00:00.000Z',
      rawText: '相手方代理人から電話。和解案 300 万円の提示。',
      gist: '相手方から和解案 300 万円の提示',
      nextActions: [
        { title: '依頼者に和解案を伝える', due: '2027-08-05', taskId: null },
        { title: '回答期限を相手方に連絡', due: '2027-08-08', taskId: null },
      ],
      waitingFor: 'client',
      ...over,
    })
    .returning()
    .get();
  return { client, kase, note };
}

describe('記録をタスクにする', () => {
  it('次のアクションごとにタスクを作り、記録にタスク化済みとして残す', async () => {
    const { kase, client, note } = seedNote();
    const r = await createTasksFromNote(note.id, { mode: 'each' });
    expect(r.tasks).toHaveLength(2);
    const tasks = db().select().from(schema.tasks).where(eq(schema.tasks.caseId, kase.id)).all();
    expect(tasks.map((t) => t.title).sort()).toEqual(['依頼者に和解案を伝える', '回答期限を相手方に連絡'].sort());
    // 記録の待ち（依頼者待ち）を引き継ぎ、期限はアクションの期限
    expect(tasks[0]!.status).toBe('waiting_client');
    expect(tasks[0]!.clientId).toBe(client.id);
    expect(tasks.find((t) => t.title === '依頼者に和解案を伝える')!.followUpAt).toBe(new Date('2027-08-05T09:00:00+09:00').toISOString());
    expect(r.note.nextActions.every((a) => a.taskId)).toBe(true);

    // 同じ記録をもう一度タスク化しても、二重に作らない
    await expect(createTasksFromNote(note.id, { mode: 'each' })).rejects.toThrow(/次のアクション/);
  });

  it('選んだ分だけ 1 つのタスクにまとめられる', async () => {
    const { note } = seedNote();
    const r = await createTasksFromNote(note.id, { mode: 'single', indexes: [0, 1], status: 'open', due: '2027-09-01' });
    expect(r.tasks).toHaveLength(1);
    const t = db().select().from(schema.tasks).where(eq(schema.tasks.id, r.tasks[0]!.id)).get()!;
    expect(t.title).toBe('依頼者に和解案を伝える ほか 1 件');
    expect(t.status).toBe('open');
    expect(t.followUpAt).toBe(new Date('2027-09-01T09:00:00+09:00').toISOString());
    // まとめたときは、どちらのアクションも同じタスクに紐付く
    expect(new Set(r.note.nextActions.map((a) => a.taskId))).toEqual(new Set([r.tasks[0]!.id]));
    expect(t.note).toContain('依頼者に和解案を伝える（期限 2027-08-05）');
  });

  it('次のアクションが無い記録でも、題名を書いてタスクにできる', async () => {
    const { note } = seedNote({ nextActions: [], waitingFor: null, gist: '事務所で打合せ。方針を確認' });
    const r = await createTasksFromNote(note.id, { mode: 'custom', title: '打合せの結果を書面にまとめる', due: '2027-08-20' });
    expect(r.tasks).toHaveLength(1);
    const t = db().select().from(schema.tasks).where(eq(schema.tasks.id, r.tasks[0]!.id)).get()!;
    expect(t.title).toBe('打合せの結果を書面にまとめる');
    expect(t.status).toBe('open');
    expect(t.note).toBe('事務所で打合せ。方針を確認');
    // 記録にも控えるので、画面で「タスク化済」と分かる
    expect(r.note.nextActions).toEqual([{ title: '打合せの結果を書面にまとめる', due: '2027-08-20', taskId: t.id }]);
  });

  it('古い記録の ISO 形式の期限でも、その日の朝を期限にする', async () => {
    const { note } = seedNote({ nextActions: [{ title: '査定書の受領確認', due: '2027-08-05T01:00:00.000Z', taskId: null }] });
    const r = await createTasksFromNote(note.id, { mode: 'each' });
    const t = db().select().from(schema.tasks).where(eq(schema.tasks.id, r.tasks[0]!.id)).get()!;
    expect(t.followUpAt).toBe(new Date('2027-08-05T09:00:00+09:00').toISOString());
  });

  it('題名を省いたときは記録の要旨の 1 行目を使う', async () => {
    const { note } = seedNote({ nextActions: [], gist: '保険会社に資料を請求する\n担当は田中さん' });
    const r = await createTasksFromNote(note.id, { mode: 'custom' });
    expect(r.tasks[0]!.title).toBe('保険会社に資料を請求する');
  });
});

describe('AI の案を直して登録する', () => {
  it('画面で直した案をそのまま登録し、記録にも控える', async () => {
    const { note, kase } = seedNote({ nextActions: [], gist: '相手方代理人と電話。和解案の提示あり' });
    const r = await createTasksFromNote(note.id, {
      mode: 'list',
      tasks: [
        { title: '依頼者に和解案を説明して意向を確認', due: '2027-08-06', status: 'open', note: '相手方は 300 万円を提示' },
        { title: '相手方代理人へ回答', due: '2027-08-09', status: 'waiting_other', note: null },
      ],
    });
    expect(r.tasks).toHaveLength(2);
    const tasks = db().select().from(schema.tasks).where(eq(schema.tasks.caseId, kase.id)).all();
    expect(tasks.map((t) => [t.title, t.status, (t.followUpAt ?? '').slice(0, 10)])).toEqual([
      ['依頼者に和解案を説明して意向を確認', 'open', new Date('2027-08-06T09:00:00+09:00').toISOString().slice(0, 10)],
      ['相手方代理人へ回答', 'waiting_other', new Date('2027-08-09T09:00:00+09:00').toISOString().slice(0, 10)],
    ]);
    // メモを空にした案は記録の要旨を使う
    expect(tasks[1]!.note).toBe('相手方代理人と電話。和解案の提示あり');
    // 記録にはタスク化済みとして残る
    expect(r.note.nextActions.map((a) => a.title)).toEqual(['依頼者に和解案を説明して意向を確認', '相手方代理人へ回答']);
    expect(r.note.nextActions.every((a) => a.taskId)).toBe(true);
  });

  it('題名が空の案だけなら登録しない', async () => {
    const { note } = seedNote({ nextActions: [] });
    await expect(createTasksFromNote(note.id, { mode: 'list', tasks: [{ title: '  ' }] })).rejects.toThrow(/登録するタスクがありません/);
  });
});
