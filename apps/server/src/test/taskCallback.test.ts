import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-callback-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

/** AI に渡した本文（伝言が参考として渡っているかを見る） */
let lastUser = '';
vi.mock('../integrations/anthropic.js', async (orig) => ({
  ...(await orig<typeof import('../integrations/anthropic.js')>()),
  generateStructured: vi.fn(async (opts: { user: string }) => {
    lastUser = opts.user;
    return { gist: '和解の件で折り返し', theirSaid: [], ourSaid: [], decisions: [], nextActions: [], waitingFor: 'none', counterpart: null, phone: null };
  }),
}));

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { looksLikePhoneMessage, extractPhones, callbackContext, saveCallbackNote } = await import('../services/taskCallback.js');
const { structureNote } = await import('../services/cases.js');
const { listTasks } = await import('../services/tasks.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

describe('電話の伝言を読み取る', () => {
  it('電話の伝言らしいタスクを見分ける', () => {
    expect(looksLikePhoneMessage({ title: '山田様よりTEL', note: '折り返し希望とのこと' })).toBe(true);
    expect(looksLikePhoneMessage({ title: '伝言', note: null })).toBe(true);
    expect(looksLikePhoneMessage({ title: '連絡先', note: '０９０－１２３４－５６７８' })).toBe(true);
    expect(looksLikePhoneMessage({ title: '準備書面の提出', note: '2027-10-18 締切' })).toBe(false);
  });

  it('電話番号を取り出す（全角・括弧・+81 も。日付は拾わない）', () => {
    expect(extractPhones('TEL0742-26-1234 携帯：０９０－１２３４－５６７８ / 03(1234)5678 / +81 90 1111 2222 / 2027-10-18 / 090-1234-5678')).toEqual([
      '0742-26-1234',
      '090-1234-5678',
      '03(1234)5678',
      '+81 90 1111 2222',
    ]);
  });
});

describe('折り返し電話', () => {
  function seed() {
    const client = db().insert(schema.clients).values({ name: '山田 花子', phones: ['09012345678'] }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '山田 離婚', status: 'active' }).returning().get();
    const other = db().insert(schema.clients).values({ name: '鈴木 一郎' }).returning().get();
    const otherCase = db().insert(schema.cases).values({ clientId: other.id, title: '鈴木 交通事故', status: 'active' }).returning().get();
    db().insert(schema.caseContacts).values({ caseId: otherCase.id, role: 'insurer', name: '佐藤', organization: '東京海上日動', phone: '03-1111-2222' }).run();
    // Chatwork で事務局から振られた伝言（依頼者は分からない）
    const task = db()
      .insert(schema.tasks)
      .values({ title: '山田様よりお電話がありました', note: '山田様よりお電話がありました。\n和解の件で、折り返しをお願いしたいとのことです。\nTEL 090-1234-5678\n東京海上 佐藤様からも 03-1111-2222', status: 'open', chatworkAssignedByName: '中村 事務' })
      .returning()
      .get();
    return { client, kase, otherCase, task };
  }

  it('伝言・番号の持ち主・記録する事件の候補を出す', () => {
    const { client, kase, otherCase, task } = seed();
    const ctx = callbackContext(task.id);
    expect(ctx.message).toContain('和解の件で、折り返しをお願いしたい');
    expect(ctx.from).toBe('中村 事務');
    expect(ctx.phones).toEqual([
      { number: '090-1234-5678', who: '山田 花子（依頼者）', clientId: client.id, caseId: null },
      { number: '03-1111-2222', who: '東京海上日動 佐藤（鈴木 交通事故の関係者）', clientId: otherCase.clientId, caseId: otherCase.id },
    ]);
    expect(ctx.callerName).toBe('山田 花子');
    expect(ctx.clientName).toBe('山田 花子');
    // 番号の持ち主の事件が先、次に依頼者の進行中の事件
    expect(ctx.cases.map((c) => c.id)).toEqual([otherCase.id, kase.id]);
    // ただし、タスクに事件が付いていればそれを既定にする
    db().update(schema.tasks).set({ caseId: kase.id }).where(eq(schema.tasks.id, task.id)).run();
    expect(callbackContext(task.id).defaultCaseId).toBe(kase.id);
  });

  it('一覧では、電話の伝言らしい未完了のタスクに印が付く', () => {
    const { task } = seed();
    const plain = db().insert(schema.tasks).values({ title: '準備書面の提出', status: 'open' }).returning().get();
    const rows = listTasks({});
    expect(rows.find((r) => r.id === task.id)?.phoneMessage).toBe(true);
    expect(rows.find((r) => r.id === plain.id)?.phoneMessage).toBe(false);
  });

  it('通話の内容を電話の記録に残し、伝言を添える。タスクを事件に付け、完了にもできる', async () => {
    const { client, kase, task } = seed();
    const r = await saveCallbackNote(task.id, { caseId: kase.id, counterpart: '山田 花子', phone: '090-1234-5678', rawText: '和解案は 300 万なら応じる。来週金曜までに回答と伝えた', theirSaid: ['300 万なら応じる'], ourSaid: ['来週金曜までに回答する'], decisions: [], nextActions: [], attachments: [] }, { completeTask: true });
    expect(r.note).toMatchObject({ kind: 'phone', caseId: kase.id, clientId: client.id, counterpart: '山田 花子', phone: '090-1234-5678', theirSaid: ['300 万なら応じる'] });
    expect(r.note.rawText).toBe('和解案は 300 万なら応じる。来週金曜までに回答と伝えた\n\n――中村 事務さんからの伝言――\n' + task.note);
    expect(r.taskStatus).toBe('done');
    const after = db().select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).get()!;
    expect(after).toMatchObject({ status: 'done', caseId: kase.id, clientId: client.id });
  });

  it('完了にしなければタスクは残る。通話の内容が空・事件なしは断る', async () => {
    const { kase, task } = seed();
    const base = { caseId: kase.id, theirSaid: [], ourSaid: [], decisions: [], nextActions: [], attachments: [] };
    const r = await saveCallbackNote(task.id, { ...base, rawText: '留守電。また掛け直す' });
    expect(r.taskStatus).toBe('open');
    await expect(saveCallbackNote(task.id, { ...base, rawText: '  ' })).rejects.toThrow('通話の内容を入力してください');
    await expect(saveCallbackNote(task.id, { ...base, caseId: 99999, rawText: 'x' })).rejects.toThrow('事件を選んでください');
  });

  it('AI で整理するとき、伝言は参考として渡し、今回の発言とは分ける', async () => {
    await structureNote('300 万なら応じるとのこと', { kind: 'phone', context: '和解の件で折り返しをお願いしたい' });
    expect(lastUser).toContain('メモ:\n300 万なら応じるとのこと');
    expect(lastUser).toContain('次の伝言への折り返しです');
    expect(lastUser).toContain('和解の件で折り返しをお願いしたい');
    await structureNote('普通のメモ', { kind: 'phone' });
    expect(lastUser).not.toContain('伝言');
  });
});
