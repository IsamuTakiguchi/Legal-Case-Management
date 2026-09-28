import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-waitingstaff-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { createTask, updateTask, checkOverdueWaitingTasks, listTasks, bulkUpdateTasks } = await import('../services/tasks.js');
const { createTasksFromNote } = await import('../services/cases.js');
const { openAlerts } = await import('../services/alerts.js');
const { taskStatusForWaiting, TASK_STATUS_LABEL, isWaitingStatus } = await import('@lcm/shared');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());
beforeEach(() => {
  db().delete(schema.alerts).run();
  db().delete(schema.tasks).run();
});

describe('「事務局の回答・作業待ち」', () => {
  it('状態の名前と、待ちとしての扱い', () => {
    expect(TASK_STATUS_LABEL.waiting_staff).toBe('事務局の回答・作業待ち');
    expect(isWaitingStatus('waiting_staff')).toBe(true);
    expect(isWaitingStatus('open')).toBe(false);
    // 記録の「誰の回答待ちか」から決める
    expect(taskStatusForWaiting('staff')).toBe('waiting_staff');
    expect(taskStatusForWaiting('client')).toBe('waiting_client');
    expect(taskStatusForWaiting('court')).toBe('waiting_other');
    expect(taskStatusForWaiting('none')).toBe('open');
    expect(taskStatusForWaiting(null)).toBe('open');
  });

  it('作るとき・変えるときに待ち開始といつまで待つかが入り、未完了の一覧に出る', async () => {
    const t = await createTask({ title: '登記簿の取寄せ', status: 'waiting_staff', syncToChatwork: false });
    expect(t.waitingSince).toBeTruthy();
    expect(t.followUpAt).toBeTruthy();
    const u = await createTask({ title: '書面の清書', status: 'open', syncToChatwork: false });
    const changed = updateTask(u.id, { status: 'waiting_staff' });
    expect(changed.waitingSince).toBeTruthy();
    expect(changed.followUpAt).toBeTruthy();
    expect(listTasks({ status: 'active' }).map((x) => x.id).sort()).toEqual([t.id, u.id].sort());
    expect(listTasks({ status: 'waiting' }).length).toBe(2);
    expect(listTasks({ status: 'waiting_staff' }).length).toBe(2);
  });

  it('いつまで待つかを過ぎたら、要確認に催促のお知らせを出す', async () => {
    const t = await createTask({ title: '登記簿の取寄せ', status: 'waiting_staff', followUpAt: new Date(Date.now() - 86400_000).toISOString(), syncToChatwork: false });
    expect(checkOverdueWaitingTasks()).toBe(1);
    const a = openAlerts().find((x) => x.type === 'waiting_overdue')!;
    expect(a.title).toContain('事務局の回答・作業待ちが期限超過');
    expect(a.payload.taskId).toBe(t.id);
  });

  it('一覧でまとめて「事務局待ち」にできる', async () => {
    const a = await createTask({ title: 'A', status: 'open', syncToChatwork: false });
    const b = await createTask({ title: 'B', status: 'waiting_client', syncToChatwork: false });
    expect(bulkUpdateTasks([a.id, b.id], 'waiting_staff')).toEqual({ updated: 2 });
    expect(db().select().from(schema.tasks).all().every((x) => x.status === 'waiting_staff')).toBe(true);
  });

  it('記録で「事務局の回答待ち」にしたら、タスクも事務局待ちで作る', async () => {
    const client = db().insert(schema.clients).values({ name: '山田 花子' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '離婚調停' }).returning().get();
    const note = db()
      .insert(schema.caseNotes)
      .values({ caseId: kase.id, clientId: client.id, kind: 'progress', occurredAt: new Date().toISOString(), rawText: '登記簿の取寄せを事務局に依頼', waitingFor: 'staff', nextActions: [{ title: '登記簿を受け取る', due: null }] })
      .returning()
      .get();
    const r = await createTasksFromNote(note.id, { mode: 'each' });
    const task = db().select().from(schema.tasks).where(eq(schema.tasks.id, r.tasks[0]!.id)).get()!;
    expect(task.status).toBe('waiting_staff');
  });
});
