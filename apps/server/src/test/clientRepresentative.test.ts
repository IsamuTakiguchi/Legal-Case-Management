import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-clientrep-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

/** AI に渡した指示を控える */
const prompts: string[] = [];
vi.mock('../integrations/anthropic.js', async (orig) => ({
  ...(await orig<typeof import('../integrations/anthropic.js')>()),
  generateText: vi.fn(async (opts: { user: string }) => {
    prompts.push(opts.user);
    return '下書き';
  }),
}));

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { createApp } = await import('../index.js');
const { setPassword } = await import('../auth/index.js');
const { backfillClientEntityTypes } = await import('../services/clientEntity.js');
const { searchClients } = await import('../services/identity.js');
const { findClients } = await import('../services/secretary.js');
const { searchAll } = await import('../services/search.js');
const { mergeClients } = await import('../services/clientMerge.js');
const { draftReply } = await import('../services/style.js');
const { looksLikeCorporation, representativeLabel } = await import('@lcm/shared');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());
beforeEach(() => {
  prompts.length = 0;
  db().delete(schema.clients).run();
  db().delete(schema.syncState).run();
});

async function api() {
  const app = createApp();
  setPassword('client-rep-test');
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'client-rep-test' }) });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  const call = async (method: string, url: string, body?: unknown) => {
    const r = await app.request(url, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return (await r.json()) as Record<string, unknown>;
  };
  return call;
}

describe('法人の依頼者と代表者', () => {
  it('名前から法人らしいかを見分ける', () => {
    for (const n of ['株式会社のぼり', 'のぼり株式会社', '合同会社ABC', '㈱テスト', '（株）テスト', '一般社団法人奈良', '医療法人社団健康会', '特定非営利活動法人まち']) expect(looksLikeCorporation(n)).toBe(true);
    for (const n of ['山田 太郎', '株田 花子', '']) expect(looksLikeCorporation(n)).toBe(false);
    expect(representativeLabel({ entityType: 'corporation', representativeTitle: '代表取締役', representativeName: '山田 太郎' })).toBe('代表取締役 山田 太郎');
    // 個人や、代表者の名前が無いときは出さない
    expect(representativeLabel({ entityType: 'individual', representativeName: '山田 太郎' })).toBeNull();
    expect(representativeLabel({ entityType: 'corporation', representativeTitle: '代表取締役', representativeName: '' })).toBeNull();
  });

  it('登録で区分を選ばなければ名前から決め、代表者も保存できる。一部だけ直しても代表者は消えない', async () => {
    const call = await api();
    const corp = await call('POST', '/api/clients', { name: '株式会社のぼり', representativeTitle: '代表取締役', representativeName: '山田 太郎', representativeKana: 'やまだ たろう' });
    expect(corp).toMatchObject({ entityType: 'corporation', representativeTitle: '代表取締役', representativeName: '山田 太郎', representativeKana: 'やまだ たろう' });
    const person = await call('POST', '/api/clients', { name: '佐藤 花子' });
    expect(person.entityType).toBe('individual');
    // 画面で選んだ区分が優先
    expect((await call('POST', '/api/clients', { name: '株式会社ではない屋', entityType: 'individual' })).entityType).toBe('individual');

    const updated = await call('PUT', `/api/clients/${corp.id}`, { notes: 'メモだけ直す' });
    expect(updated).toMatchObject({ entityType: 'corporation', representativeName: '山田 太郎', notes: 'メモだけ直す' });
    const changed = await call('PUT', `/api/clients/${corp.id}`, { representativeName: '  鈴木 次郎  ' });
    expect(changed.representativeName).toBe('鈴木 次郎');
  });

  it('前からいる依頼者は、名前が法人らしければ一度だけ法人にする（あとで個人に戻したものは戻さない）', () => {
    const a = db().insert(schema.clients).values({ name: '有限会社まほろば' }).returning().get();
    const b = db().insert(schema.clients).values({ name: '田中 一郎' }).returning().get();
    expect(backfillClientEntityTypes()).toBe(1);
    const get = (id: number) => db().select().from(schema.clients).where(eq(schema.clients.id, id)).get()!;
    expect(get(a.id).entityType).toBe('corporation');
    expect(get(b.id).entityType).toBe('individual');
    db().update(schema.clients).set({ entityType: 'individual' }).where(eq(schema.clients.id, a.id)).run();
    expect(backfillClientEntityTypes()).toBe(0);
    expect(get(a.id).entityType).toBe('individual');
  });

  it('代表者の名前・かなでも依頼者が見つかる', () => {
    const c = db().insert(schema.clients).values({ name: '株式会社のぼり', entityType: 'corporation', representativeTitle: '代表取締役', representativeName: '山田 太郎', representativeKana: 'やまだ たろう' }).returning().get();
    expect(searchClients('山田').map((x) => x.id)).toEqual([c.id]);
    expect(searchClients('やまだ').map((x) => x.id)).toEqual([c.id]);
    const found = findClients('山田');
    expect(found.map((x) => x.id)).toEqual([c.id]);
    expect(found[0]!.representative).toBe('代表取締役 山田 太郎');
    expect(searchAll('山田 太郎').some((h) => h.kind === 'client' && h.id === c.id)).toBe(true);
  });

  it('同じ依頼者をまとめるとき、残す側に代表者が無ければ引き継ぐ', () => {
    const keep = db().insert(schema.clients).values({ name: '株式会社のぼり' }).returning().get();
    const dup = db().insert(schema.clients).values({ name: '株式会社のぼり', entityType: 'corporation', representativeTitle: '代表社員', representativeName: '山田 太郎' }).returning().get();
    mergeClients(keep.id, [dup.id]);
    const after = db().select().from(schema.clients).where(eq(schema.clients.id, keep.id)).get()!;
    expect(after).toMatchObject({ entityType: 'corporation', representativeTitle: '代表社員', representativeName: '山田 太郎' });
  });

  it('返信の下書きでは、法人なら代表者で宛名を書くよう AI に伝える', async () => {
    const c = db().insert(schema.clients).values({ name: '株式会社のぼり', entityType: 'corporation', representativeTitle: '代表取締役', representativeName: '山田 太郎' }).returning().get();
    await draftReply({ conversationId: 0, instruction: '資料の受領をお礼する', templateKey: null, extra: {} }, { channel: 'gmail', clientName: c.name, thread: [] }, c.id);
    expect(prompts[0]).toContain('法人の依頼者。代表者は代表取締役 山田 太郎');
    expect(prompts[0]).toContain('「山田様」');
    // 個人は今までどおり
    const p = db().insert(schema.clients).values({ name: '佐藤 花子' }).returning().get();
    await draftReply({ conversationId: 0, instruction: 'お礼', templateKey: null, extra: {} }, { channel: 'line', clientName: p.name, thread: [] }, p.id);
    expect(prompts[1]).toContain('宛名は「佐藤様」');
    expect(prompts[1]).not.toContain('代表者');
  });
});
