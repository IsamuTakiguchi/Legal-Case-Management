import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-progress-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { addCaseNote, caseTimeline } = await import('../services/cases.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

function seedCase(title: string) {
  const client = db().insert(schema.clients).values({ name: '山田 花子' }).returning().get();
  const kase = db().insert(schema.cases).values({ clientId: client.id, title }).returning().get();
  return { client, kase };
}

const base = { theirSaid: [], ourSaid: [], decisions: [], nextActions: [], attachments: [] };

describe('タイムラインに進捗を登録する', () => {
  it('「依頼者に確認」の進捗を、回答待ちのタスク付きで登録できる', async () => {
    const { client, kase } = seedCase('山田 交通事故');
    const note = await addCaseNote(
      {
        ...base,
        caseId: kase.id,
        kind: 'progress',
        counterpart: '依頼者に確認',
        rawText: '和解案の内容を説明し、受けるかどうか確認を依頼',
        gist: '和解案の内容を説明し、受けるかどうか確認を依頼',
        waitingFor: 'client',
        nextActions: [{ title: '依頼者に確認の回答待ち: 和解案の内容を説明し、受けるかどうか確認を依頼', due: '2027-10-05' }],
      },
      { createTasks: 'single' },
    );
    expect(note.kind).toBe('progress');
    expect(note.waitingFor).toBe('client');
    const taskId = note.nextActions[0]?.taskId;
    expect(taskId).toBeTruthy();
    const task = db().select().from(schema.tasks).where(eq(schema.tasks.id, taskId!)).get();
    // 依頼者待ちは waiting_client。期限は日本時間の 9:00
    expect(task?.status).toBe('waiting_client');
    expect(task?.caseId).toBe(kase.id);
    expect(task?.clientId).toBe(client.id);
    expect(task?.followUpAt).toBe(new Date('2027-10-05T09:00:00+09:00').toISOString());
  });

  it('相手方・裁判所・事務局の待ちは「相手方・裁判所待ち」のタスクになる', async () => {
    const { kase } = seedCase('山田 貸金');
    for (const w of ['counterpart', 'court', 'other'] as const) {
      const note = await addCaseNote(
        { ...base, caseId: kase.id, kind: 'progress', counterpart: '照会', rawText: `${w} 待ち`, gist: `${w} 待ち`, waitingFor: w, nextActions: [{ title: `${w} の回答待ち`, due: null }] },
        { createTasks: 'single' },
      );
      const task = db().select().from(schema.tasks).where(eq(schema.tasks.id, note.nextActions[0]!.taskId!)).get();
      expect(task?.status).toBe('waiting_other');
    }
  });

  it('回答待ちなしの進捗は、タスクを作らずに記録だけ残る', async () => {
    const { kase } = seedCase('山田 相続');
    const before = db().select().from(schema.tasks).where(eq(schema.tasks.caseId, kase.id)).all().length;
    const note = await addCaseNote({ ...base, caseId: kase.id, kind: 'progress', counterpart: '書面提出', rawText: '準備書面（2）を提出', gist: '準備書面（2）を提出', waitingFor: 'none' });
    expect(note.nextActions.length).toBe(0);
    expect(db().select().from(schema.tasks).where(eq(schema.tasks.caseId, kase.id)).all().length).toBe(before);
  });

  it('日時を指定すれば、その時刻でタイムラインに入る', async () => {
    const { kase } = seedCase('山田 労働');
    const at = '2027-09-01T01:00:00.000Z';
    await addCaseNote({ ...base, caseId: kase.id, kind: 'progress', occurredAt: at, counterpart: '資料受領', rawText: '診断書を受領', gist: '診断書を受領', waitingFor: 'none' });
    const hit = caseTimeline(kase.id).find((i) => i.title.includes('資料受領'));
    expect(hit?.at).toBe(at);
  });

  it('タイムラインの行に、誰の回答待ちかが入る', async () => {
    const { kase } = seedCase('山田 離婚');
    await addCaseNote({ ...base, caseId: kase.id, kind: 'progress', counterpart: '担当事務局に確認', rawText: '登記簿の取寄せを依頼', gist: '登記簿の取寄せを依頼', waitingFor: 'other' });
    const hit = caseTimeline(kase.id).find((i) => i.title.includes('担当事務局に確認'));
    expect(hit?.type).toBe('note:progress');
    expect(hit?.title).toBe('進捗 / 担当事務局に確認');
    expect(hit?.ref?.waitingFor).toBe('other');
    expect(hit?.body).toBe('登記簿の取寄せを依頼');
  });
});
