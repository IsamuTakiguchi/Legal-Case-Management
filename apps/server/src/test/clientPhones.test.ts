import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-phones-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { phoneDigits, isPhoneLike, splitPhones, normalizePhones, telHref, samePhone } = await import('@lcm/shared');
const { clientRoutes } = await import('../routes/clients.js');
const { mergeClients } = await import('../services/clientMerge.js');
const { searchAll } = await import('../services/search.js');
const { searchClients } = await import('../services/identity.js');
const { findClients } = await import('../services/secretary.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());
beforeEach(() => {
  db().delete(schema.clients).run();
});

const json = (body: unknown, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const client = (id: number) => db().select().from(schema.clients).where(eq(schema.clients.id, id)).get()!;

describe('電話番号の読み方', () => {
  it('数字だけにして、発信リンクを作る', () => {
    expect(phoneDigits('090-1234-5678（携帯）')).toBe('09012345678');
    expect(phoneDigits('０９０－１２３４－５６７８')).toBe('09012345678');
    expect(phoneDigits('+81 90-1234-5678')).toBe('+819012345678');
    expect(telHref('0742-00-0000（自宅）')).toBe('tel:0742000000');
  });

  it('電話番号らしいものだけを番号とみる', () => {
    expect(isPhoneLike('090-1234-5678')).toBe(true);
    expect(isPhoneLike('0742-00-0000')).toBe(true);
    // 短い数字（事件番号の一部など）は番号とみない
    expect(isPhoneLike('123')).toBe(false);
    expect(isPhoneLike('令和8年(家イ)第123号')).toBe(false);
  });

  it('区切りはカンマ・読点・改行・スラッシュ。番号の中のハイフンや空白では切らない', () => {
    expect(splitPhones('090-1234-5678（携帯）, 0742 00 0000、03-0000-0000\n06-0000-0000')).toEqual(['090-1234-5678（携帯）', '0742 00 0000', '03-0000-0000', '06-0000-0000']);
  });

  it('全角を半角にし、書き方が違っても同じ番号は 1 つにする', () => {
    expect(normalizePhones(['  ０９０－１２３４－５６７８ ', '09012345678', '090-1234-5678（携帯）', '', '0742-00-0000'])).toEqual(['090-1234-5678', '0742-00-0000']);
    expect(samePhone('090-1234-5678', '09012345678')).toBe(true);
    // 添え書きの全角かっこやカタカナの長音はそのまま残す
    expect(normalizePhones(['０９０ー１２３４ー５６７８（オーナー）'])).toEqual(['090-1234-5678（オーナー）']);
    expect(samePhone('', '')).toBe(false);
  });
});

describe('依頼者の電話番号の登録', () => {
  it('新規登録で電話番号を保存する（整えてから）', async () => {
    const res = await clientRoutes.request('/clients', json({ name: '山田 花子', phones: ['０９０－１２３４－５６７８（携帯）', '090-1234-5678'] }));
    expect(res.status).toBe(200);
    const row = (await res.json()) as { id: number; phones: string[] };
    expect(row.phones).toEqual(['090-1234-5678（携帯）']);
  });

  it('電話番号を足さなくても登録できる（空の一覧になる）', async () => {
    const res = await clientRoutes.request('/clients', json({ name: '佐藤 太郎' }));
    const row = (await res.json()) as { phones: string[] };
    expect(row.phones).toEqual([]);
  });

  it('変更で電話番号を差し替える。電話番号を送らない変更では消さない', async () => {
    const created = (await (await clientRoutes.request('/clients', json({ name: '山田 花子', phones: ['090-1234-5678'] }))).json()) as { id: number };
    await clientRoutes.request(`/clients/${created.id}`, json({ phones: ['090-1234-5678', '0742-00-0000（自宅）'] }, 'PUT'));
    expect(client(created.id).phones).toEqual(['090-1234-5678', '0742-00-0000（自宅）']);
    // メモだけ直したときは、電話番号はそのまま
    await clientRoutes.request(`/clients/${created.id}`, json({ notes: 'メモ' }, 'PUT'));
    expect(client(created.id).phones).toEqual(['090-1234-5678', '0742-00-0000（自宅）']);
  });

  it('一部だけの変更で、送っていない別名・メールも消さない', async () => {
    const created = (await (await clientRoutes.request('/clients', json({ name: '山田 花子', aliases: ['山田'], emails: ['h.yamada@example.com'], phones: ['090-1234-5678'] }))).json()) as { id: number };
    await clientRoutes.request(`/clients/${created.id}`, json({ preferredChannel: 'gmail' }, 'PUT'));
    const after = client(created.id);
    expect(after.aliases).toEqual(['山田']);
    expect(after.emails).toEqual(['h.yamada@example.com']);
    expect(after.phones).toEqual(['090-1234-5678']);
    expect(after.preferredChannel).toBe('gmail');
    // 空の一覧を送ったときは、意図して消したものとして空にする
    await clientRoutes.request(`/clients/${created.id}`, json({ phones: [] }, 'PUT'));
    expect(client(created.id).phones).toEqual([]);
    expect(client(created.id).emails).toEqual(['h.yamada@example.com']);
  });

  it('長すぎる入力は受け付けない', async () => {
    const res = await clientRoutes.request('/clients', json({ name: '山田 花子', phones: ['0'.repeat(80)] }));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('電話番号で探す・まとめる', () => {
  it('横断検索で、書き方が違っても電話番号から依頼者が見つかる', () => {
    const c = db().insert(schema.clients).values({ name: '山田 花子', phones: ['090-1234-5678'] }).returning().get();
    for (const q of ['090-1234-5678', '09012345678']) {
      const hits = searchAll(q, { kinds: ['client'] });
      expect(hits.map((h) => h.id)).toContain(c.id);
    }
    // 番号の一部だけ違うものは当たらない
    expect(searchAll('090-9999-9999', { kinds: ['client'] }).map((h) => h.id)).not.toContain(c.id);
  });

  it('依頼者の絞り込み（/clients?q=）と AI 秘書も電話番号で当てる', () => {
    const c = db().insert(schema.clients).values({ name: '山田 花子', phones: ['090-1234-5678（携帯）'] }).returning().get();
    db().insert(schema.clients).values({ name: '佐藤 太郎', phones: ['080-0000-0000'] }).run();
    expect(searchClients('09012345678').map((x) => x.id)).toEqual([c.id]);
    expect(findClients('090 1234 5678').map((x) => x.id)).toEqual([c.id]);
    // 名前での検索はこれまでどおり
    expect(searchClients('山田').map((x) => x.id)).toEqual([c.id]);
  });

  it('同じ依頼者を 1 件にまとめるとき、電話番号も引き継ぐ（同じ番号は 1 つに）', () => {
    const keep = db().insert(schema.clients).values({ name: '山田 花子', phones: ['090-1234-5678'] }).returning().get();
    const src = db().insert(schema.clients).values({ name: '山田 花子', phones: ['09012345678', '0742-00-0000'] }).returning().get();
    mergeClients(keep.id, [src.id]);
    expect(client(keep.id).phones).toEqual(['090-1234-5678', '0742-00-0000']);
  });
});
