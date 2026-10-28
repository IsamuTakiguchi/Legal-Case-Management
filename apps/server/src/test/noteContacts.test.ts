import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-notecontacts-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { noteContactSuggestions } = await import('../services/noteContacts.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

describe('記録の相手・電話番号の候補', () => {
  it('この事件の記録 → 事件の関係者 → 依頼者・担当者 → 同じ依頼者の記録 → ほかの事件の記録 の順に出す', () => {
    const client = db().insert(schema.clients).values({ name: '山田 太郎', phones: ['090-1111-2222'] }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '山田 離婚' }).returning().get();
    const other = db().insert(schema.cases).values({ clientId: client.id, title: '山田 貸金' }).returning().get();
    const otherClient = db().insert(schema.clients).values({ name: '佐藤 花子' }).returning().get();
    const otherCase = db().insert(schema.cases).values({ clientId: otherClient.id, title: '佐藤 相続' }).returning().get();
    db().insert(schema.clientPersons).values({ clientId: client.id, name: '山田 花子', title: '妻', phones: ['080-3333-4444'] }).run();
    db().insert(schema.caseContacts).values({ caseId: kase.id, role: 'opponent_counsel', name: '鈴木 一郎', organization: '鈴木法律事務所', phone: '03-1234-5678' }).run();
    const note = (caseId: number, clientId: number, counterpart: string | null, phone: string | null, occurredAt: string, kind = 'phone') =>
      db().insert(schema.caseNotes).values({ caseId, clientId, kind, counterpart, phone, occurredAt }).run();
    note(kase.id, client.id, '鈴木 一郎', '03-1234-5678', '2026-10-01T00:00:00.000Z');
    note(kase.id, client.id, '鈴木 一郎', '03-1234-5678', '2026-10-05T00:00:00.000Z');
    note(kase.id, client.id, '家裁 書記官', '03-0000-1111', '2026-09-01T00:00:00.000Z', 'court');
    // 進捗の「依頼者に確認」は相手ではないので候補にしない
    note(kase.id, client.id, '依頼者に確認', null, '2026-10-06T00:00:00.000Z', 'progress');
    note(other.id, client.id, '貸金の相手', '06-2222-3333', '2026-08-01T00:00:00.000Z');
    note(otherCase.id, otherClient.id, '損保ジャパン 担当', '0120-000-000', '2026-07-01T00:00:00.000Z');

    const r = noteContactSuggestions(kase.id);
    expect(r.map((s) => [s.name, s.phone])).toEqual([
      ['鈴木 一郎', '03-1234-5678'],
      ['家裁 書記官', '03-0000-1111'],
      ['山田 太郎', '090-1111-2222'],
      ['山田 花子', '080-3333-4444'],
      ['貸金の相手', '06-2222-3333'],
      ['損保ジャパン 担当', '0120-000-000'],
    ]);
    expect(r[0]!.hint).toBe('この事件の記録 2 回');
    expect(r[3]!.hint).toBe('依頼者の担当者（妻）');
    expect(r.some((s) => s.name === '依頼者に確認')).toBe(false);
  });

  it('名前だけの記録は、同じ名前で電話番号の分かる候補にまとめる', () => {
    const client = db().insert(schema.clients).values({ name: '高橋 健' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '高橋 労働' }).returning().get();
    db().insert(schema.caseNotes).values({ caseId: kase.id, clientId: client.id, kind: 'meeting', counterpart: '会社の人事部長', occurredAt: '2026-10-10T00:00:00.000Z' }).run();
    db().insert(schema.caseContacts).values({ caseId: kase.id, role: 'opponent', name: '会社の人事部長', phone: '045-111-2222' }).run();
    const r = noteContactSuggestions(kase.id).filter((s) => s.name === '会社の人事部長');
    expect(r).toEqual([{ name: '会社の人事部長', phone: '045-111-2222', hint: 'この事件の記録' }]);
  });

  it('事件が分からないとき（折り返しで事件未選択など）は、記録の履歴だけから出す', () => {
    const r = noteContactSuggestions(null);
    expect(r.some((s) => s.name === '損保ジャパン 担当')).toBe(true);
    expect(r.some((s) => s.hint === '依頼者')).toBe(false);
  });
});
