import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-taskdl-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase } = await import('../db/index.js');
const { createTask } = await import('../services/tasks.js');
const { taskInputSchema } = await import('@lcm/shared');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

const base = { clientId: null, caseId: null, conversationId: null, note: null, syncToChatwork: false };
const DUE = '2027-10-05T01:00:00.000Z';

describe('タスクを追加するときの期限', () => {
  it('対応中のタスクは、入れた期日がそのまま入る', async () => {
    const t = await createTask({ ...base, title: '準備書面を作る', status: 'open', dueAt: DUE, followUpAt: null });
    expect(t.dueAt).toBe(DUE);
    expect(t.followUpAt).toBeNull();
  });

  it('期日を入れなければ未設定のまま（対応中）', async () => {
    const t = await createTask({ ...base, title: '資料を読む', status: 'open', dueAt: null, followUpAt: null });
    expect(t.dueAt).toBeNull();
    expect(t.followUpAt).toBeNull();
  });

  it('返信待ちのタスクは、入れた期限がそのまま入る', async () => {
    const t = await createTask({ ...base, title: '委任状の返送待ち', status: 'waiting_client', followUpAt: DUE, dueAt: null });
    expect(t.followUpAt).toBe(DUE);
    expect(t.waitingSince).toBeTruthy();
  });

  it('返信待ちで期限を入れなければ、設定の営業日数から決まる', async () => {
    const t = await createTask({ ...base, title: '回答待ち', status: 'waiting_other', followUpAt: null, dueAt: null });
    expect(t.followUpAt).toBeTruthy();
    expect(new Date(t.followUpAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('画面が送る形（末尾 Z の ISO）を受け取れる', () => {
    const parsed = taskInputSchema.parse({ title: 'x', status: 'open', dueAt: DUE, followUpAt: null });
    expect(parsed.dueAt).toBe(DUE);
  });
});

describe('事件ページからタスクを追加する', () => {
  it('事件だけ指定すれば、その事件の依頼者にも紐付く', async () => {
    const { db, schema } = await import('../db/index.js');
    const client = db().insert(schema.clients).values({ name: '山田 花子' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '山田 離婚' }).returning().get();
    const t = await createTask({ ...base, title: '陳述書の案を作る', status: 'open', caseId: kase.id, dueAt: DUE, followUpAt: null });
    expect(t.caseId).toBe(kase.id);
    expect(t.clientId).toBe(client.id);
    expect(t.dueAt).toBe(DUE);
  });

  it('依頼者を明に指定したときは、そちらを優先する', async () => {
    const { db, schema } = await import('../db/index.js');
    const a = db().insert(schema.clients).values({ name: '佐藤 太郎' }).returning().get();
    const b = db().insert(schema.clients).values({ name: '鈴木 一郎' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: a.id, title: '佐藤 交通事故' }).returning().get();
    const t = await createTask({ ...base, title: '照会', status: 'open', caseId: kase.id, clientId: b.id, dueAt: null, followUpAt: null });
    expect(t.clientId).toBe(b.id);
  });
});

describe('対応中から連絡待ちにしても期日は消えない', () => {
  it('依頼者の返信待ちにすると「いつまで待つか」が入り、期日はそのまま。対応中に戻すと元の期日に戻る', async () => {
    const { updateTask } = await import('../services/tasks.js');
    const { taskDeadline } = await import('@lcm/shared');
    const t = await createTask({ ...base, title: '準備書面の提出', status: 'open', dueAt: DUE, followUpAt: null });
    const w = updateTask(t.id, { status: 'waiting_client' });
    expect(w.dueAt).toBe(DUE);
    expect(w.followUpAt).toBeTruthy();
    expect(w.followUpAt).not.toBe(DUE);
    // 返信待ちの間は「いつまで待つか」が期限
    expect(taskDeadline(w)).toBe(w.followUpAt);
    const back = updateTask(t.id, { status: 'open' });
    expect(back.dueAt).toBe(DUE);
    expect(taskDeadline(back)).toBe(DUE);
  });

  it('期日を古い欄（返信待ちの期限）に持っていたタスクも、返信待ちにする前に期日へ移して残す', async () => {
    const { updateTask } = await import('../services/tasks.js');
    const { db, schema } = await import('../db/index.js');
    const old = db().insert(schema.tasks).values({ title: '古いタスク', status: 'open', followUpAt: DUE }).returning().get();
    const w = updateTask(old.id, { status: 'waiting_client' });
    expect(w.dueAt).toBe(DUE);
    expect(w.followUpAt).not.toBe(DUE);
  });

  it('連絡待ちにするときに「いつまで待つか」を指定でき、期日は別に直せる', async () => {
    const { updateTask } = await import('../services/tasks.js');
    const t = await createTask({ ...base, title: '和解案の検討', status: 'open', dueAt: DUE, followUpAt: null });
    const until = '2027-10-01T01:00:00.000Z';
    const w = updateTask(t.id, { status: 'waiting_client', followUpAt: until });
    expect([w.followUpAt, w.dueAt]).toEqual([until, DUE]);
    const moved = updateTask(t.id, { dueAt: '2027-10-10T01:00:00.000Z' });
    expect([moved.followUpAt, moved.dueAt]).toEqual([until, '2027-10-10T01:00:00.000Z']);
  });

  it('対応中で追加するとき、期日を「いつまで待つか」の欄で渡されても期日に入れる', async () => {
    const t = await createTask({ ...base, title: '記録から', status: 'open', dueAt: null, followUpAt: DUE });
    expect([t.dueAt, t.followUpAt]).toEqual([DUE, null]);
  });
});
