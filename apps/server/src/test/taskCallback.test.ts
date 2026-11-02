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
const { extractCaller } = await import('../services/phoneMessage.js');
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

describe('伝言から折り返し先を読み取る', () => {
  const memo = 'R8.10.19　9：37\n東京海上日動　ひめのさん\n0742-35-8061\n奥戸正勝さんの件\n進捗状況をお伺いしたいです。\n\n→折り返しお願いします。';

  it('「会社　名前さん」の行と、その下の番号を折り返し先にする（「◯◯さんの件」は用件なので名前にしない）', () => {
    expect(extractCaller(memo)).toEqual({ name: '東京海上日動　ひめの', phone: '0742-35-8061' });
  });

  it('いろいろな書き方', () => {
    expect(extractCaller('山田様よりお電話がありました。\n和解の件で、折り返しをお願いしたいとのことです。\nTEL 090-1234-5678')).toEqual({ name: '山田', phone: '090-1234-5678' });
    expect(extractCaller('東京海上日動のひめのさんから電話（0742-35-8061）。奥戸さんの件')).toEqual({ name: '東京海上日動のひめの', phone: '0742-35-8061' });
    expect(extractCaller('相手方代理人 佐藤先生\n06-1111-2222\n山田さんの件で折り返し希望')).toEqual({ name: '相手方代理人 佐藤', phone: '06-1111-2222' });
    // 番号が 2 つあれば、その人の近くの番号
    expect(extractCaller('奥戸さんの件\n事務所 03-0000-1111\n\nあいおい　田中さん\n携帯 090-2222-3333')).toEqual({ name: 'あいおい　田中', phone: '090-2222-3333' });
    expect(extractCaller('書類の確認をお願いします')).toBeNull();
  });

  it('折り返し電話の画面に、伝言の折り返し先（名前・番号）を最初から入れる。事件は用件の依頼者', () => {
    const client = db().insert(schema.clients).values({ name: '奥戸 正勝' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '奥戸 交通事故', status: 'active' }).returning().get();
    const task = db().insert(schema.tasks).values({ title: 'R8.10.19　9：37', note: memo, status: 'open', chatworkAssignedByName: '中村 事務' }).returning().get();
    const ctx = callbackContext(task.id);
    expect(ctx.callerName).toBe('東京海上日動　ひめの');
    expect(ctx.callerPhone).toBe('0742-35-8061');
    expect(ctx.clientName).toBe('奥戸 正勝');
    expect(ctx.defaultCaseId).toBe(kase.id);
    // 番号が複数あれば、折り返し先の人の近くの番号（最初の番号とは限らない）
    const t2 = db().insert(schema.tasks).values({ title: '伝言', note: '奥戸正勝さんの件\n事務所 03-0000-1111\n\nあいおい　田中さん\n携帯 090-2222-3333', status: 'open' }).returning().get();
    const c2 = callbackContext(t2.id);
    expect(c2.phones.map((p) => p.number)).toEqual(['03-0000-1111', '090-2222-3333']);
    expect(c2).toMatchObject({ callerName: 'あいおい　田中', callerPhone: '090-2222-3333' });
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

  it('誰の事件か未確定なら「氏名未確認」の相談者と相談の事件を作って記録し、番号も覚える', async () => {
    const task = db()
      .insert(schema.tasks)
      .values({ title: '鈴木様よりTEL', note: '鈴木様より電話。090-5555-6666 に折り返しお願いします', status: 'open' })
      .returning()
      .get();
    const base = { theirSaid: [], ourSaid: [], decisions: [], nextActions: [], attachments: [] };
    // 事件も仮の呼び名も無ければ断る（何も作らない）
    const before = db().select().from(schema.clients).all().length;
    await expect(saveCallbackNote(task.id, { ...base, rawText: '相続の相談' })).rejects.toThrow('事件を選んでください');
    // 内容が空なら、仮の依頼者・事件も作らない
    await expect(saveCallbackNote(task.id, { ...base, rawText: ' ' }, { provisional: { label: null } })).rejects.toThrow('通話の内容を入力してください');
    expect(db().select().from(schema.clients).all().length).toBe(before);

    const r = await saveCallbackNote(task.id, { ...base, caseId: null, counterpart: '鈴木様', rawText: '相続の相談。来週面談' }, { provisional: { label: '（氏名未確認）鈴木さん' }, completeTask: true });
    const kase = db().select().from(schema.cases).where(eq(schema.cases.id, r.caseId)).get()!;
    expect(kase).toMatchObject({ status: 'consultation' });
    expect(kase.title).toMatch(/^電話相談（\d+\/\d+）$/);
    const client = db().select().from(schema.clients).where(eq(schema.clients.id, kase.clientId)).get()!;
    expect(client).toMatchObject({ name: '（氏名未確認）鈴木さん', provisional: true, phones: ['090-5555-6666'] });
    expect(r.note.caseId).toBe(kase.id);
    expect(r.note.rawText).toContain('相続の相談。来週面談');
    expect(db().select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).get()).toMatchObject({ status: 'done', caseId: kase.id, clientId: client.id });
  });

  it('仮の呼び名が空なら「（氏名未確認）相談者」にする', async () => {
    const task = db().insert(schema.tasks).values({ title: '電話あり', note: '折り返し希望', status: 'open' }).returning().get();
    const r = await saveCallbackNote(task.id, { theirSaid: [], ourSaid: [], decisions: [], nextActions: [], attachments: [], rawText: '留守電' }, { provisional: { label: null } });
    const kase = db().select().from(schema.cases).where(eq(schema.cases.id, r.caseId)).get()!;
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, kase.clientId)).get()).toMatchObject({ name: '（氏名未確認）相談者', provisional: true, phones: [] });
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
