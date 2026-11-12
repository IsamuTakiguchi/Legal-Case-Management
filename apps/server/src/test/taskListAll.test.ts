import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-taskall-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { listTasks } = await import('../services/tasks.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

describe('タスクの一覧の「完了以外すべて」', () => {
  it('完了だけを除き、時期未定の備忘も含めて出す', () => {
    for (const status of ['open', 'drafted', 'waiting_client', 'memo', 'done'] as const) db().insert(schema.tasks).values({ title: `t-${status}`, status }).run();
    const notDone = listTasks({ status: 'notdone' }).map((t) => t.status).sort();
    expect(notDone).toEqual(['drafted', 'memo', 'open', 'waiting_client']);
    expect(listTasks({ status: 'active' }).map((t) => t.status).sort()).toEqual(['drafted', 'open', 'waiting_client']);
  });
});
