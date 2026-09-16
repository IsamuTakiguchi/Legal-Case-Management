import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-activity-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { recentActivity } = await import('../services/activity.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

describe('直前の行動（最近の動き）', () => {
  it('記録・送受信・タスクを新しい順にまとめ、飛び先を付ける', () => {
    const client = db().insert(schema.clients).values({ name: '山田 花子' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '山田 離婚' }).returning().get();
    const conv = db()
      .insert(schema.conversations)
      .values({ channel: 'gmail', externalThreadId: 'a-1', clientId: client.id, caseId: kase.id, counterpartName: '山田 花子', lastMessageAt: '2027-09-01T01:00:00.000Z' })
      .returning()
      .get();
    db()
      .insert(schema.messages)
      .values({ conversationId: conv.id, channel: 'gmail', externalId: 'am-1', direction: 'in', senderName: '山田 花子', body: '  \n査定書をお送りしました。\n二枚目もあります', sentAt: '2027-09-01T01:00:00.000Z' })
      .run();
    const note = db()
      .insert(schema.caseNotes)
      .values({ caseId: kase.id, clientId: client.id, kind: 'phone', counterpart: '山田 花子', occurredAt: '2027-09-01T02:00:00.000Z', createdAt: '2027-09-01T02:05:00.000Z', gist: '査定書の受領を確認した' })
      .returning()
      .get();
    // 事件に紐付かない方針メモは「行動」に出さない
    db().insert(schema.caseNotes).values({ caseId: kase.id, kind: 'policy', occurredAt: '2027-09-01T03:00:00.000Z', createdAt: '2027-09-01T03:00:00.000Z', rawText: '方針' }).run();
    db()
      .insert(schema.tasks)
      .values({ title: '査定書の受領', clientId: client.id, caseId: kase.id, status: 'open', createdAt: '2027-09-01T02:06:00.000Z', updatedAt: '2027-09-01T02:06:00.000Z' })
      .run();

    const items = recentActivity(10);
    expect(items.map((i) => [i.kind, i.to])).toEqual([
      ['task', `/cases/${kase.id}`],
      ['note', `/cases/${kase.id}#note-${note.id}`],
      ['received', `/inbox/${conv.id}`],
    ]);
    expect(items[1]).toMatchObject({ label: '電話の記録（山田 花子）', title: '査定書の受領を確認した', clientName: '山田 花子', caseTitle: '山田 離婚' });
    // 会話から依頼者・事件をたどれる。本文は空行を飛ばして 1 行目を出す
    expect(items[2]).toMatchObject({ label: 'Gmail を受信（山田 花子）', title: '査定書をお送りしました。', clientName: '山田 花子', caseTitle: '山田 離婚' });
  });

  it('完了したタスクは完了した時刻で出す。作ってすぐ完了にしたものは二重に出さない', () => {
    db()
      .insert(schema.tasks)
      .values({ title: '証拠の整理', status: 'done', createdAt: '2027-09-02T01:00:00.000Z', updatedAt: '2027-09-02T05:00:00.000Z' })
      .run();
    db()
      .insert(schema.tasks)
      .values({ title: '一括で完了にしたもの', status: 'done', createdAt: '2027-09-02T06:00:00.000Z', updatedAt: '2027-09-02T06:00:00.000Z' })
      .run();
    const items = recentActivity(10);
    const done = items.filter((i) => i.kind === 'task_done');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ at: '2027-09-02T05:00:00.000Z', label: 'タスクを完了', title: '証拠の整理', to: '/tasks' });
    // 作成としては両方出る（行き先が無いものはタスク一覧へ）
    expect(items.filter((i) => i.kind === 'task' && i.title === '一括で完了にしたもの')).toHaveLength(1);
  });

  it('一度に作ったタスクで埋まらないよう、タスクの数を抑えて記録・やり取りを残す', () => {
    // 一括登録のように、記録やメッセージより新しいタスクをまとめて作る
    for (let i = 0; i < 20; i++) {
      db()
        .insert(schema.tasks)
        .values({ title: `一括タスク ${i}`, status: 'open', createdAt: `2027-09-03T0${i % 10}:00:00.000Z`, updatedAt: `2027-09-03T0${i % 10}:00:00.000Z` })
        .run();
    }
    const items = recentActivity(12);
    // タスクより古くても、記録とやり取りは押し出されない
    expect(items.some((i) => i.kind === 'note')).toBe(true);
    expect(items.some((i) => i.kind === 'received')).toBe(true);
    // 席が余れば残りのタスクで埋めるので、一覧は短くならない
    expect(items).toHaveLength(12);
    expect(items.map((i) => i.at)).toEqual([...items.map((i) => i.at)].sort().reverse());
  });

  it('件数を絞ると新しいものだけ残る', () => {
    const items = recentActivity(2);
    expect(items).toHaveLength(2);
    expect(items[0]!.at >= items[1]!.at).toBe(true);
  });
});
