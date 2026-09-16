import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-search-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

/** AI の応答（テストごとに差し替える）。1 回目が検索語、2 回目が回答 */
let replies: Record<string, unknown>[] = [];
const prompts: string[] = [];
vi.mock('../integrations/anthropic.js', () => ({
  generateStructured: async (req: { user: string }) => {
    prompts.push(req.user);
    return replies.shift() ?? {};
  },
}));

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { searchAll, searchTerms } = await import('../services/search.js');
const { askAcrossData } = await import('../services/askSearch.js');

beforeAll(() => {
  openTestDatabase();
  const client = db().insert(schema.clients).values({ name: '山田 花子', kana: 'やまだはなこ', aliases: ['ヤマダ'] }).returning().get();
  const other = db().insert(schema.clients).values({ name: '佐藤 太郎' }).returning().get();
  const kase = db().insert(schema.cases).values({ clientId: client.id, title: '山田 離婚', summary: '査定書の取得待ち' }).returning().get();
  const otherCase = db().insert(schema.cases).values({ clientId: other.id, title: '佐藤 交通事故' }).returning().get();
  db()
    .insert(schema.caseNotes)
    .values({ caseId: kase.id, clientId: client.id, kind: 'phone', counterpart: '山田 花子', occurredAt: '2027-09-01T01:00:00.000Z', gist: '自宅の査定書は 2 社のうち 1 社が届いた', decisions: ['残り 1 社が届き次第、調停に提出する'] })
    .run();
  db().insert(schema.caseNotes).values({ caseId: otherCase.id, clientId: other.id, kind: 'phone', occurredAt: '2027-09-02T01:00:00.000Z', gist: '保険会社は 2 週間以内に回答予定' }).run();
  const conv = db()
    .insert(schema.conversations)
    .values({ channel: 'gmail', externalThreadId: 's-1', clientId: client.id, caseId: kase.id, counterpartName: '山田 花子', lastMessageAt: '2027-09-03T01:00:00.000Z' })
    .returning()
    .get();
  db()
    .insert(schema.messages)
    .values({ conversationId: conv.id, clientId: client.id, caseId: kase.id, channel: 'gmail', externalId: 'sm-1', direction: 'in', senderName: '山田 花子', body: '残りの査定書が届きましたので添付します。', sentAt: '2027-09-03T01:00:00.000Z' })
    .run();
  db().insert(schema.tasks).values({ title: '査定書（2 社目）の受領', clientId: client.id, caseId: kase.id, status: 'waiting_client', createdAt: '2027-09-01T02:00:00.000Z', updatedAt: '2027-09-01T02:00:00.000Z' }).run();
});
afterAll(() => closeDatabase());

describe('横断検索', () => {
  it('質問の言い回しから検索語を切り出す（敬称・助詞は落とす）', () => {
    expect(searchTerms('山田さんの査定書はどうなっている？')).toContain('山田');
    expect(searchTerms('山田さんの査定書はどうなっている？')).toContain('査定書');
    // 1 文字は拾わない
    expect(searchTerms('の は が')).toEqual([]);
  });

  it('記録・やり取り・事件・依頼者・タスクを横断して見つける', () => {
    const hits = searchAll('山田 査定書');
    const kinds = new Set(hits.map((h) => h.kind));
    expect(kinds).toContain('note');
    expect(kinds).toContain('message');
    expect(kinds).toContain('task');
    expect(kinds).toContain('client');
    // 関係ない依頼者は混ざらない
    expect(hits.some((h) => h.clientName === '佐藤 太郎')).toBe(false);
    // どの結果にも開く先が付く
    for (const h of hits) expect(h.link).toMatch(/^\/(cases|inbox|clients|tasks|calendar|forms)/);
    // 記録は該当箇所の抜粋と、その記録へのリンクになる
    const note = hits.find((h) => h.kind === 'note')!;
    expect(note.snippet).toContain('査定書');
    expect(note.link).toMatch(/^\/cases\/\d+#note-\d+$/);
    expect([note.clientName, note.caseTitle]).toEqual(['山田 花子', '山田 離婚']);
  });

  it('当てはまる語が多いものほど上に来る', () => {
    const hits = searchAll('山田 査定書');
    expect(hits.length).toBeGreaterThan(1);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[hits.length - 1]!.score);
  });

  it('種類で絞り込める', () => {
    const hits = searchAll('査定書', { kinds: ['task'] });
    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(hits.map((h) => h.kind))).toEqual(new Set(['task']));
  });

  it('当てはまらない語では何も返さない', () => {
    expect(searchAll('存在しない語句ザザザ')).toEqual([]);
    expect(searchAll('')).toEqual([]);
  });
});

describe('データ全体への質問', () => {
  it('検索語を決めて探し、答えと根拠を返す', async () => {
    prompts.length = 0;
    replies = [
      { terms: ['山田', '査定書'], kinds: [] },
      { answer: '2 社のうち 1 社は 9 月 1 日に届き [1]、残りも 9 月 3 日に届いています [2]。', used: [1, 2], confidence: 'high', missing: '' },
    ];
    const r = await askAcrossData('山田さんの査定書はどうなっている？');
    expect(r.terms).toContain('山田');
    expect(r.answer).toContain('2 社のうち 1 社');
    expect(r.confidence).toBe('high');
    expect(r.citations).toHaveLength(2);
    // 根拠は番号順に、実際の検索結果へ結び付く
    expect(r.citations[0]).toBe(r.hits[0]);
    expect(r.citations[1]).toBe(r.hits[1]);
    // AI には番号付きの資料を渡している
    expect(prompts[1]).toContain('[1]');
    expect(prompts[1]).toContain('山田さんの査定書はどうなっている？');
  });

  it('範囲外・重複の番号は捨てる', async () => {
    replies = [
      { terms: ['山田'], kinds: [] },
      { answer: '…', used: [1, 1, 0, 999, 2], confidence: 'medium', missing: '' },
    ];
    const r = await askAcrossData('山田さんの件');
    expect(r.citations).toHaveLength(2);
    expect(new Set(r.citations).size).toBe(2);
  });

  it('見つからなければ AI に回答させず、その旨を返す', async () => {
    prompts.length = 0;
    replies = [{ terms: ['存在しない語句ザザザ'], kinds: [] }];
    const r = await askAcrossData('存在しない語句ザザザについて教えて');
    expect(r.answer).toBe('');
    expect(r.hits).toEqual([]);
    expect(r.missing).toContain('見つかりませんでした');
    // 2 回目（回答）の呼び出しはしない
    expect(prompts).toHaveLength(1);
  });

  it('検索語を作れなくても、質問そのものから探す', async () => {
    replies = [];
    const boom = { generateStructured: async () => { throw new Error('AI 未設定'); } };
    void boom;
    // 1 回目（検索語）で失敗させ、2 回目（回答）は返す
    let call = 0;
    const mod = await import('../integrations/anthropic.js');
    const spy = vi.spyOn(mod, 'generateStructured').mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error('AI 未設定');
      return { answer: '査定書は届いています。', used: [1], confidence: 'medium', missing: '' } as never;
    });
    const r = await askAcrossData('山田さんの査定書はどうなっている？');
    expect(r.terms).toContain('山田');
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.answer).toBe('査定書は届いています。');
    spy.mockRestore();
  });
});
