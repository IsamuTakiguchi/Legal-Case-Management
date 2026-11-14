import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-clientdups-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { findDuplicateClients, mergeClients, ignoreDuplicate, oneCharApart } = await import('../services/clientMerge.js');
const { clientNameCore } = await import('@lcm/shared');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

const add = (name: string, extra: Partial<typeof schema.clients.$inferInsert> = {}) => db().insert(schema.clients).values({ name, ...extra }).returning().get();
const groupOf = (id: number) => findDuplicateClients().find((g) => g.clients.some((c) => c.id === id));

describe('依頼者の名前の芯（重複の照合用）', () => {
  it('法人格・括弧書き・「様」・空白・全角半角の違いを除く', () => {
    expect(clientNameCore('宗教法人正行寺')).toBe(clientNameCore('正行寺'));
    expect(clientNameCore('宗教法人　正行寺')).toBe('正行寺');
    expect(clientNameCore('株式会社ミクニ管材（代表取締役　三國敦子）')).toBe('ミクニ管材');
    expect(clientNameCore('㈱ミクニ管材')).toBe('ミクニ管材');
    expect(clientNameCore('ミクニ管材株式会社')).toBe('ミクニ管材');
    expect(clientNameCore('医療法人社団 青葉会')).toBe('青葉会');
    expect(clientNameCore('山田 花子様')).toBe('山田花子');
    expect(clientNameCore('ＡＢＣ合同会社')).toBe('abc');
  });
});

describe('重複の候補', () => {
  it('「正行寺」と「宗教法人正行寺」を、法人格の違いとして組にする（正式な名前を統合後の名前に勧める）', () => {
    const a = add('正行寺', { emails: ['info@shogyoji.jp'] });
    const b = add('宗教法人正行寺');
    const g = groupOf(a.id)!;
    expect(g.clients.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(g.exact).toBe(false);
    expect(g.reasons).toContain('法人格の有無・違い');
    expect(g.suggestedName).toBe('宗教法人正行寺');
  });

  it('名前が同じものは「名前が同じ」として先に出す', () => {
    const a = add('鈴木 一郎');
    add('鈴木一郎');
    const list = findDuplicateClients();
    const g = groupOf(a.id)!;
    expect(g.exact).toBe(true);
    expect(list.findIndex((x) => x.exact === false)).toBeGreaterThan(list.indexOf(g));
  });

  it('括弧書きや別名でもつながる', () => {
    const a = add('株式会社ミクニ管材（代表取締役　三國敦子）');
    const b = add('ミクニ管材');
    const c = add('三國管材', { aliases: ['ミクニ管材株式会社'] });
    expect(groupOf(a.id)!.clients.map((x) => x.id).sort()).toEqual([a.id, b.id, c.id].sort());
    // 統合後の名前は、括弧書きを外した正式な名前を勧める
    expect(groupOf(a.id)!.suggestedName).toBe('株式会社ミクニ管材');
    expect(groupOf(a.id)!.names).toContain('株式会社ミクニ管材（代表取締役　三國敦子）');
  });

  it('1 文字の名前や、まったく違う名前は組にしない', () => {
    const a = add('株式会社A');
    add('A');
    expect(groupOf(a.id)).toBeUndefined();
  });

  it('「別の依頼者」にした組は、もう候補に出さない', () => {
    const a = add('合同会社ひかり');
    const b = add('株式会社ひかり');
    expect(groupOf(a.id)).toBeDefined();
    ignoreDuplicate([a.id, b.id]);
    expect(groupOf(a.id)).toBeUndefined();
    expect(() => ignoreDuplicate([a.id])).toThrow();
  });
});

describe('1 文字違いの名前', () => {
  const fuzzyOf = (id: number) => findDuplicateClients().find((g) => g.fuzzy && g.clients.some((c) => c.id === id));

  it('1 文字の置き換え・抜け・余分を見分ける', () => {
    expect(oneCharApart('山田花子', '山田華子')).toBe(true);
    expect(oneCharApart('青葉会', '青葉会館')).toBe(true);
    expect(oneCharApart('青葉会館', '青葉館')).toBe(true);
    expect(oneCharApart('山田花子', '山田花子')).toBe(false);
    expect(oneCharApart('山田花子', '山本華子')).toBe(false);
    expect(oneCharApart('青葉', '青葉会館')).toBe(false);
  });

  it('「山田花子」と「山田華子」、「光明寺」と「宗教法人光照寺」を、1 文字違いの組として最後に出す', () => {
    const a = add('山田 花子X');
    const b = add('山田華子X');
    const g = fuzzyOf(a.id)!;
    expect(g.clients.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(g).toMatchObject({ exact: false, fuzzy: true });
    expect(g.reasons).toContain('1 文字違い');
    const list = findDuplicateClients();
    expect(list.findIndex((x) => x.fuzzy)).toBeGreaterThan(list.findIndex((x) => !x.fuzzy));

    // 法人格の違いと 1 文字違いが重なっていても拾う
    const c = add('光明寺');
    const d = add('宗教法人光照寺');
    expect(fuzzyOf(c.id)!.clients.map((x) => x.id).sort()).toEqual([c.id, d.id].sort());
    expect(fuzzyOf(c.id)!.reasons).toEqual(expect.arrayContaining(['1 文字違い', '法人格の有無・違い']));
  });

  it('2 文字の名前どうしは、1 文字違いでも出さない', () => {
    const a = add('山中');
    add('山内');
    expect(fuzzyOf(a.id)).toBeUndefined();
  });

  it('「別の依頼者」にすると 1 文字違いのつながりだけ外し、名前が同じ組は残す', () => {
    const x1 = add('鈴木 太郎Q');
    const x2 = add('鈴木太郎Q');
    const y = add('鈴木大郎Q');
    const g = fuzzyOf(y.id)!;
    expect(g.clients.map((c) => c.id).sort()).toEqual([x1.id, x2.id, y.id].sort());
    ignoreDuplicate(g.clients.map((c) => c.id), { fuzzy: true });
    expect(fuzzyOf(y.id)).toBeUndefined();
    // 鈴木太郎どうし（名前が同じ）はまだ候補にある
    const same = findDuplicateClients().find((x) => !x.fuzzy && x.clients.some((c) => c.id === x1.id))!;
    expect(same.clients.map((c) => c.id).sort()).toEqual([x1.id, x2.id].sort());
  });
});

describe('統合', () => {
  it('統合後の名前を選べる。前の名前は別名に残り、法人なら法人にする', () => {
    const keep = add('正福寺', { emails: ['a@shofukuji.jp'] });
    const src = add('宗教法人正福寺', { emails: ['b@shofukuji.jp'] });
    const kase = db().insert(schema.cases).values({ clientId: src.id, title: '境内地の明渡し' }).returning().get();
    mergeClients(keep.id, [src.id], { name: '宗教法人正福寺' });
    const after = db().select().from(schema.clients).where(eq(schema.clients.id, keep.id)).get()!;
    expect(after.name).toBe('宗教法人正福寺');
    expect(after.aliases).toContain('正福寺');
    expect(after.aliases).not.toContain('宗教法人正福寺');
    expect(after.entityType).toBe('corporation');
    expect(after.emails).toEqual(['a@shofukuji.jp', 'b@shofukuji.jp']);
    expect(db().select().from(schema.cases).where(eq(schema.cases.id, kase.id)).get()!.clientId).toBe(keep.id);
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, src.id)).get()).toBeUndefined();
  });

  it('名前を選ばなければ、残す側の名前のまま', () => {
    const keep = add('高橋 次郎');
    const src = add('高橋次郎様');
    mergeClients(keep.id, [src.id]);
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, keep.id)).get()!.name).toBe('高橋 次郎');
  });
});
