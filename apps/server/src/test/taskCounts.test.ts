import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-taskcounts-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { createApp } = await import('../index.js');
const { setPassword } = await import('../auth/index.js');
const { countTasks, taskDeadline } = await import('@lcm/shared');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

const past = new Date(Date.now() - 2 * 86400_000).toISOString();
const future = new Date(Date.now() + 2 * 86400_000).toISOString();

describe('タスクの件数を「対応中」と「連絡待ち」に分ける', () => {
  it('状態ごとに数え、期限切れも別に数える（完了は数えない）', () => {
    const c = countTasks([
      { status: 'open', dueAt: past },
      { status: 'open', dueAt: future },
      { status: 'open' },
      { status: 'waiting_client', followUpAt: past },
      { status: 'waiting_client', followUpAt: future },
      { status: 'waiting_other', followUpAt: future },
      { status: 'done', dueAt: past },
    ]);
    expect(c).toEqual({ open: 3, waiting: 3, waitingClient: 2, waitingOther: 1, openOverdue: 1, waitingOverdue: 1 });
  });

  it('期限は、連絡待ちなら「いつまで待つか」、対応中なら期日を先に見る', () => {
    expect(taskDeadline({ status: 'waiting_client', followUpAt: 'A', dueAt: 'B' })).toBe('A');
    expect(taskDeadline({ status: 'open', followUpAt: 'A', dueAt: 'B' })).toBe('B');
    expect(taskDeadline({ status: 'open', followUpAt: 'A' })).toBe('A');
    expect(taskDeadline({ status: 'open' })).toBeNull();
  });

  it('ダッシュボードが内訳を返し、一覧は「連絡待ち」だけに絞れる', async () => {
    const values = [
      { title: '準備書面を書く', status: 'open', dueAt: past },
      { title: '証拠の整理', status: 'open' },
      { title: '依頼者から資料', status: 'waiting_client', followUpAt: past, waitingSince: past },
      { title: '相手方の回答', status: 'waiting_other', followUpAt: future, waitingSince: past },
      { title: '終わったこと', status: 'done' },
    ];
    for (const v of values) db().insert(schema.tasks).values(v).run();

    const app = createApp();
    setPassword('task-counts-test');
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'task-counts-test' }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';

    const dash = (await (await app.request('/api/dashboard', { headers: { cookie } })).json()) as { openTasks: number; taskCounts: Record<string, number> };
    expect(dash.taskCounts).toEqual({ open: 2, waiting: 2, waitingClient: 1, waitingOther: 1, openOverdue: 1, waitingOverdue: 1 });
    expect(dash.openTasks).toBe(2);

    const waiting = (await (await app.request('/api/tasks?status=waiting', { headers: { cookie } })).json()) as { title: string }[];
    expect(waiting.map((t) => t.title).sort()).toEqual(['依頼者から資料', '相手方の回答']);
    const open = (await (await app.request('/api/tasks?status=open', { headers: { cookie } })).json()) as { title: string }[];
    expect(open.map((t) => t.title).sort()).toEqual(['準備書面を書く', '証拠の整理']);
  });
});
