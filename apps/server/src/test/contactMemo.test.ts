import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-contactmemo-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = 'test-key';

/** 規則で読めないメモだけ AI に回ることを確かめる */
const aiCalls: string[] = [];
vi.mock('../integrations/anthropic.js', async (importActual) => {
  const actual = await importActual<typeof import('../integrations/anthropic.js')>();
  return {
    ...actual,
    generateStructured: vi.fn(async (opts: { user: string }) => {
      aiCalls.push(opts.user);
      return { accidentDateText: '令和6年1月5日', accidentDate: null, contacts: [{ role: 'opponent_insurer', organization: '損保ジャパン', department: null, name: '田中', phone: '03-1234-5678', fax: null, emails: ['x-not-mail', 'tanaka@example.com'] }] };
    }),
  };
});

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { parseContactMemo, parseJaDate, formatWareki, addYearsIso } = await import('@lcm/shared');
const { createApp } = await import('../index.js');
const { setPassword } = await import('../auth/index.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

const MEMO = `事故日：R5.9.10

依頼者側保険会社
東京海上日動　岡田
TEL:06-6910-6265
FAX:050-3385-7581
mail:

相手方側保険会社
JA共済
物損担当　青木
TEL:0742-27-4435
FAX:0742-27-5234
人損担当   森西
TEL:0742-27-4148
FAX:0742-27-5234`;

describe('和暦の日付', () => {
  it('R5.9.10・令和・平成・元年・西暦を読み、ありえない日付は読まない', () => {
    expect(parseJaDate('R5.9.10')).toBe('2023-09-10');
    expect(parseJaDate('令和５年９月１０日')).toBe('2023-09-10');
    expect(parseJaDate('令和元年5月1日')).toBe('2019-05-01');
    expect(parseJaDate('H31.4.30')).toBe('2019-04-30');
    expect(parseJaDate('S64.1.7')).toBe('1989-01-07');
    expect(parseJaDate('2023/9/10')).toBe('2023-09-10');
    expect(parseJaDate('2023年9月10日(日)')).toBe('2023-09-10');
    expect(parseJaDate('R5.2.30')).toBeNull();
    expect(parseJaDate('9月10日')).toBeNull();
    expect(parseJaDate('')).toBeNull();
  });

  it('和暦で表示し、年をまたいだ日付も数える', () => {
    expect(formatWareki('2023-09-10')).toBe('令和5年9月10日');
    expect(formatWareki('2023-09-10', 'short')).toBe('R5.9.10');
    expect(formatWareki('2019-05-01')).toBe('令和元年5月1日');
    expect(formatWareki('2019-04-30')).toBe('平成31年4月30日');
    expect(formatWareki(null)).toBe('');
    expect(addYearsIso('2023-09-10', 3)).toBe('2026-09-10');
    expect(addYearsIso('2024-02-29', 3)).toBe('2027-02-28');
  });
});

describe('連絡先メモの読み取り', () => {
  it('事故日と、依頼者側・相手方の保険会社の担当者（物損・人損）・TEL・FAX を読む。空の mail: は無視', () => {
    expect(parseContactMemo(MEMO)).toEqual({
      accidentDate: '2023-09-10',
      accidentDateText: 'R5.9.10',
      contacts: [
        { role: 'client_insurer', organization: '東京海上日動', department: null, name: '岡田', phone: '06-6910-6265', fax: '050-3385-7581', emails: [] },
        { role: 'opponent_insurer', organization: 'JA共済', department: '物損', name: '青木', phone: '0742-27-4435', fax: '0742-27-5234', emails: [] },
        { role: 'opponent_insurer', organization: 'JA共済', department: '人損', name: '森西', phone: '0742-27-4148', fax: '0742-27-5234', emails: [] },
      ],
    });
  });

  it('メール・担当者のいない代表番号・区分の見出しが無い保険会社も読む', () => {
    const r = parseContactMemo('相手方保険\nあいおいニッセイ同和損保 佐藤\nTEL：03-1111-2222\nmail: sato@example.com\n\n三井住友海上\nTEL 0120-000-000');
    expect(r.contacts).toEqual([
      { role: 'opponent_insurer', organization: 'あいおいニッセイ同和損保', department: null, name: '佐藤', phone: '03-1111-2222', fax: null, emails: ['sato@example.com'] },
      { role: 'opponent_insurer', organization: '三井住友海上', department: null, name: '三井住友海上', phone: '0120-000-000', fax: null, emails: [] },
    ]);
    expect(parseContactMemo('三井住友海上 鈴木\nTEL:03-0000-0000').contacts[0]!.role).toBe('insurer');
  });
});

describe('メモから事件に登録', () => {
  it('読み取って登録し、2 回目は同じ担当者を増やさず空欄だけ補う。事故日も和暦で入れられる', async () => {
    const app = createApp();
    setPassword('memo-test');
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'memo-test' }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const call = (method: string, url: string, body?: unknown) => app.request(`/api${url}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });

    const client = db().insert(schema.clients).values({ name: '事故 太郎' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, caseType: 'traffic', title: '交通事故' }).returning().get();

    const parsed = await (await call('POST', `/cases/${kase.id}/contacts/parse`, { text: MEMO })).json();
    expect(parsed.by).toBe('rule');
    expect(parsed.contacts).toHaveLength(3);
    expect(aiCalls).toHaveLength(0);

    const r1 = await (await call('POST', `/cases/${kase.id}/contacts/import`, { accidentDate: parsed.accidentDate, contacts: parsed.contacts })).json();
    expect(r1).toEqual({ created: 3, updated: 0, accidentDate: '2023-09-10' });
    const saved = db().select().from(schema.caseContacts).where(eq(schema.caseContacts.caseId, kase.id)).all();
    expect(saved.find((x) => x.name === '森西')).toMatchObject({ role: 'opponent_insurer', organization: 'JA共済', department: '人損', phone: '0742-27-4148', fax: '0742-27-5234' });

    // 岡田さんの FAX を消しておき、同じメモをもう一度 → 増えずに FAX だけ戻る
    const okada = saved.find((x) => x.name === '岡田')!;
    db().update(schema.caseContacts).set({ fax: null }).where(eq(schema.caseContacts.id, okada.id)).run();
    const r2 = await (await call('POST', `/cases/${kase.id}/contacts/import`, { contacts: parsed.contacts })).json();
    expect(r2).toMatchObject({ created: 0, updated: 1 });
    expect(db().select().from(schema.caseContacts).where(eq(schema.caseContacts.caseId, kase.id)).all()).toHaveLength(3);
    expect(db().select().from(schema.caseContacts).where(eq(schema.caseContacts.id, okada.id)).get()!.fax).toBe('050-3385-7581');

    // 事件情報の事故日: 和暦で入れて西暦で持つ。読めない字は断る。空なら消す
    expect((await (await call('PUT', `/cases/${kase.id}`, { accidentDate: '令和5年10月1日' })).json()).accidentDate).toBe('2023-10-01');
    const bad = await call('PUT', `/cases/${kase.id}`, { accidentDate: '去年の秋' });
    expect(bad.ok).toBe(false);
    expect((await bad.json()).error).toContain('事故日「去年の秋」を日付として読めません');
    expect((await (await call('PUT', `/cases/${kase.id}`, { accidentDate: '' })).json()).accidentDate).toBeNull();

    // 決まった書き方でないメモは AI で読み取る（メールらしくないものは捨てる）
    const ai = await (await call('POST', `/cases/${kase.id}/contacts/parse`, { text: '先方の保険は損保ジャパンの田中さん（03-1234-5678）、事故は令和6年1月5日' })).json();
    expect(aiCalls).toHaveLength(1);
    expect(ai).toMatchObject({ by: 'ai', accidentDate: '2024-01-05', contacts: [{ organization: '損保ジャパン', name: '田中', emails: ['tanaka@example.com'] }] });
  });
});
