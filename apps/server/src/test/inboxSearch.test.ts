import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-inboxsearch-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { listConversations } = await import('../services/inbox.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

let n = 0;
function conv(values: Partial<typeof schema.conversations.$inferInsert>, body: string, opts: { senderName?: string; minutesAgo?: number } = {}) {
  n++;
  const at = new Date(Date.now() - (opts.minutesAgo ?? n) * 60_000).toISOString();
  const c = db()
    .insert(schema.conversations)
    .values({ channel: 'gmail', externalThreadId: `t-${n}`, lastMessageAt: at, lastInboundAt: at, ...values })
    .returning()
    .get();
  db()
    .insert(schema.messages)
    .values({ conversationId: c.id, channel: 'gmail', externalId: `m-${n}`, direction: 'in', senderName: opts.senderName ?? null, body, sentAt: at })
    .run();
  return c;
}
const found = (q: string, limit?: number) => listConversations({ q, limit }).map((c) => c.id);

describe('受信箱の検索（名前・本文）', () => {
  it('依頼者名・関係者名と所属・担当者名・相手の表示名とアドレス・送信者名で探せる（2 文字・空白なしでも）', () => {
    const yamada = db().insert(schema.clients).values({ name: '山田 太郎', kana: 'やまだ たろう' }).returning().get();
    const corp = db().insert(schema.clients).values({ name: '株式会社のぼり', entityType: 'corporation' }).returning().get();
    const person = db().insert(schema.clientPersons).values({ clientId: corp.id, name: '鈴木 一郎' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: yamada.id, title: '交通事故', caseType: 'civil', status: 'active' }).returning().get();
    const contact = db().insert(schema.caseContacts).values({ caseId: kase.id, role: 'other', name: '岡田彬弘', organization: '東京海上日動火災保険株式会社', emails: [] }).returning().get();

    const a = conv({ clientId: yamada.id, counterpartName: 'taro', counterpartAddress: 'taro@example.com' }, 'よろしくお願いします。');
    const b = conv({ clientId: yamada.id, contactId: contact.id, counterpartName: 'Okada', counterpartAddress: 'okada@tokiomarine.example' }, '資料をお送りします。');
    const c = conv({ clientId: corp.id, clientPersonId: person.id, counterpartName: 'suzuki' }, '請求書の件です。');
    const d = conv({ counterpartName: '佐藤 花子', counterpartAddress: 'hanako@example.com' }, 'はじめまして。');
    const e = conv({ counterpartName: 'グループ' }, '連絡です。', { senderName: '高橋 次郎' });

    // 依頼者名（2 文字、空白なし、ふりがな）
    expect(found('山田')).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(found('山田太郎')).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(found('やまだ')).toEqual(expect.arrayContaining([a.id, b.id]));
    // 関係者名・所属
    expect(found('岡田')).toEqual([b.id]);
    expect(found('東京海上')).toEqual([b.id]);
    // 担当者名
    expect(found('鈴木')).toEqual([c.id]);
    // 相手の表示名・アドレス（未紐付けの相手も）
    expect(found('佐藤花子')).toEqual([d.id]);
    expect(found('hanako@')).toEqual([d.id]);
    // メッセージの送信者名（グループなど）
    expect(found('高橋')).toEqual([e.id]);
  });

  it('本文も探せる（2 文字の語も）。空白で区切った語は、名前と本文をまたいですべて含むものだけ', () => {
    const client = db().insert(schema.clients).values({ name: '中村 三郎' }).returning().get();
    const x = conv({ clientId: client.id, counterpartName: '中村' }, '和解案について検討しました');
    const y = conv({ clientId: client.id, counterpartName: '中村' }, '期日の件です');
    expect(found('和解')).toContain(x.id);
    expect(found('和解案について')).toEqual([x.id]);
    expect(found('中村 和解')).toEqual([x.id]);
    expect(found('中村 存在しない語')).toEqual([]);
    expect(found('中村')).toEqual(expect.arrayContaining([x.id, y.id]));
    // % や _ は文字として探す（すべてに当たらない）
    expect(found('100%')).toEqual([]);
    expect(found('_')).toEqual([]);
  });

  it('件数で切る前に絞るので、古い会話も見つかる', () => {
    const old = conv({ counterpartName: '古川 健' }, '昔の連絡', { minutesAgo: 60 * 24 * 400 });
    expect(found('古川', 1)).toEqual([old.id]);
  });
});
