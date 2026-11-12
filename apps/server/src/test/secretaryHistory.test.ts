import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-sechist-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase } = await import('../db/index.js');
const h = await import('../services/secretaryHistory.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

describe('AI 秘書のやり取りの履歴', () => {
  it('頼みごとと返事・案・登録結果を残し、ひと続きの会話ごとに見返せる。消すこともできる', async () => {
    const t1 = h.newThreadId();
    const a = h.recordTurn({ threadId: t1, request: '山田さんの電話を記録して', reply: '記録の案を作りました', context: { caseId: 3 }, actions: [{ type: 'note' }], previews: [{ label: '記録' }], questions: [] });
    await new Promise((r) => setTimeout(r, 5));
    h.recordTurn({ threadId: t1, request: 'やっぱり打合せにして', reply: '直しました', actions: [{ type: 'note' }], previews: [], questions: ['日時は？'] });
    h.recordApplied(a.id, [{ type: 'note', ok: true, label: '記録' }, { type: 'task', ok: false, label: 'x' }]);
    await new Promise((r) => setTimeout(r, 5));
    const t2 = h.newThreadId();
    h.recordTurn({ threadId: t2, request: '吉堂さんの担当を藤田さんに', reply: '案です', actions: [], previews: [], questions: [] });

    const list = h.listThreads();
    expect(list.map((x) => x.threadId)).toEqual([t2, t1]);
    expect(list[1]).toMatchObject({ first: '山田さんの電話を記録して', last: 'やっぱり打合せにして', turns: 2, appliedOk: 1 });
    expect(h.listThreads({ q: '藤田' }).map((x) => x.threadId)).toEqual([t2]);

    const turns = h.getThread(t1);
    expect(turns.map((t) => t.request)).toEqual(['山田さんの電話を記録して', 'やっぱり打合せにして']);
    expect(turns[0]).toMatchObject({ context: { caseId: 3 }, applied: [{ type: 'note', ok: true, label: '記録' }, { type: 'task', ok: false, label: 'x' }] });
    expect(turns[0]!.appliedAt).toBeTruthy();
    expect(turns[1]!.questions).toEqual(['日時は？']);

    expect(h.deleteThread(t1)).toEqual({ deleted: 2 });
    expect(h.listThreads().map((x) => x.threadId)).toEqual([t2]);
  });
});
