import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-casefolders-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.STORAGE_BACKEND = 'local';
process.env.LOCAL_CLIENT_ROOT = path.join(tmp, 'clients');
process.env.DATA_DIR = tmp;

/** OneDrive 上のフォルダ（ID → 今の名前と親） */
const drive = new Map<string, { id: string; name: string; parentReference: { path: string } }>();
const moves: { id: string; to: string }[] = [];

vi.mock('../integrations/onedrive.js', async (importActual) => {
  const actual = await importActual<typeof import('../integrations/onedrive.js')>();
  const fullOf = (item: { name: string; parentReference: { path: string } }) => `${item.parentReference.path.replace(/^\/drive\/root:/, '')}/${item.name}`;
  return {
    ...actual,
    isMsConnected: async () => true,
    getItem: async (id: string) => {
      const item = drive.get(id);
      if (!item) throw new Error('Graph エラー 404');
      return item;
    },
    getItemByPath: async (p: string) => [...drive.values()].find((item) => fullOf(item) === p) ?? null,
    moveItem: async (id: string, to: string) => {
      moves.push({ id, to });
      const item = drive.get(id)!;
      drive.set(id, { ...item, parentReference: { path: `/drive/root:${to}` } });
    },
  };
});

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { setStorageBackend } = await import('../integrations/storage.js');
const cf = await import('../services/clientFolders.js');
const { caseFolder, messageCase } = await import('../services/attachments.js');
const { listCourtDocs } = await import('../services/court.js');
const { applyImport } = await import('../services/clientImport.js');
const { setSetting } = await import('../services/settings.js');
const { eq, sql } = await import('drizzle-orm');

/** 区分フォルダの中身（list で返す） */
const listing = new Map<string, { name: string; path: string; isFolder: boolean; itemId?: string }[]>();
const listed: string[] = [];
const fakeOneDrive = {
  kind: 'onedrive' as const,
  clientRoot: () => '/依頼者',
  ensureFolder: async () => undefined,
  put: async () => ({ path: '', size: 0 }),
  get: async () => Buffer.alloc(0),
  move: async () => ({ path: '', size: 0 }),
  list: async (p: string) => {
    listed.push(p);
    return listing.get(p) ?? [];
  },
  remove: async () => undefined,
};

beforeAll(() => {
  openTestDatabase();
  setStorageBackend(fakeOneDrive);
  cf.saveStatusFolderMap({ consultation: '0.相談', active: '1.進行事件', wrapup: '2.残務処理', closed: '3.終了事件' }, []);
  setSetting('client_folder_name_format', '{kana} {name}　{case}');
});
afterAll(() => {
  setStorageBackend(null);
  closeDatabase();
});

const at = (id: string, name: string, parent: string) => drive.set(id, { id, name, parentReference: { path: `/drive/root:/依頼者/${parent}` } });
const caseRow = (id: number) => db().select().from(schema.cases).where(eq(schema.cases.id, id)).get()!;

/** 事件ごとにフォルダがある依頼者（離婚・婚姻費用） */
function seedTwoFolders(name: string, ids: [string, string]) {
  const compact = name.replace(/\s/g, '');
  const client = db().insert(schema.clients).values({ name, kana: 'や', onedriveFolderPath: `1.進行事件/や ${compact}　離婚`, onedriveItemId: ids[0] }).returning().get();
  const a = db().insert(schema.cases).values({ clientId: client.id, title: `${name} 離婚`, status: 'active', onedriveFolderPath: `1.進行事件/や ${compact}　離婚`, onedriveItemId: ids[0] }).returning().get();
  const b = db().insert(schema.cases).values({ clientId: client.id, title: `${name} 婚姻費用`, status: 'active', onedriveFolderPath: `1.進行事件/や ${compact}　婚姻費用`, onedriveItemId: ids[1] }).returning().get();
  at(ids[0], `や ${compact}　離婚`, '1.進行事件');
  at(ids[1], `や ${compact}　婚姻費用`, '1.進行事件');
  return { client, a, b };
}

describe('事件ごとの OneDrive フォルダ', () => {
  it('事件が 1 件だけの依頼者は、移行で依頼者フォルダが事件のフォルダになる（複数の事件がある依頼者はそのまま）', () => {
    const one = db().insert(schema.clients).values({ name: '一件 太郎', onedriveFolderPath: '1.進行事件/い 一件太郎', onedriveItemId: 'X1' }).returning().get();
    const k1 = db().insert(schema.cases).values({ clientId: one.id, title: '一件 交通事故' }).returning().get();
    const two = db().insert(schema.clients).values({ name: '二件 花子', onedriveFolderPath: '1.進行事件/に 二件花子' }).returning().get();
    const k2 = db().insert(schema.cases).values({ clientId: two.id, title: '二件 離婚' }).returning().get();
    db().insert(schema.cases).values({ clientId: two.id, title: '二件 相続' }).run();
    const migration = fs.readFileSync(path.join(import.meta.dirname, '../../drizzle/0024_serious_speed_demon.sql'), 'utf8');
    const update = migration.split('--> statement-breakpoint').find((x) => x.includes('UPDATE `cases`'))!;
    db().run(sql.raw(update.replace(/^--.*$/gm, '')));
    expect(caseRow(k1.id)).toMatchObject({ onedriveFolderPath: '1.進行事件/い 一件太郎', onedriveItemId: 'X1' });
    expect(caseRow(k2.id).onedriveFolderPath).toBeNull();
  });

  it('事件のフォルダが無ければ依頼者フォルダを使う。受信の事件はメッセージ → 会話の順に見て、別の依頼者の事件は使わない', () => {
    const { client, a, b } = seedTwoFolders('山田 花子', ['Y1', 'Y2']);
    const none = db().insert(schema.cases).values({ clientId: client.id, title: '山田 相続', status: 'consultation' }).returning().get();
    expect(caseFolder(client, b)).toBe('/依頼者/1.進行事件/や 山田花子　婚姻費用');
    expect(caseFolder(client, none)).toBe('/依頼者/1.進行事件/や 山田花子　離婚');
    expect(cf.caseFolderRel(none, client)).toBe('1.進行事件/や 山田花子　離婚');
    const conv = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: 'cf-1', clientId: client.id, caseId: a.id }).returning().get();
    expect(messageCase({ caseId: b.id, conversationId: conv.id }, client.id)?.id).toBe(b.id);
    expect(messageCase({ caseId: null, conversationId: conv.id }, client.id)?.id).toBe(a.id);
    const other = db().insert(schema.clients).values({ name: '別人' }).returning().get();
    expect(messageCase({ caseId: b.id, conversationId: conv.id }, other.id)).toBeNull();
  });

  it('期日連絡などの書面候補は、事件を指定すればその事件のフォルダだけ、指定しなければ事件のフォルダすべてを見る', async () => {
    const { client, b } = seedTwoFolders('佐藤 一郎', ['S1', 'S2']);
    listed.length = 0;
    await listCourtDocs(client.id, { caseId: b.id });
    expect(listed).toEqual(['/依頼者/1.進行事件/や 佐藤一郎　婚姻費用/提出書面', '/依頼者/1.進行事件/や 佐藤一郎　婚姻費用']);
    listed.length = 0;
    await listCourtDocs(client.id);
    expect(listed).toContain('/依頼者/1.進行事件/や 佐藤一郎　離婚');
    expect(listed).toContain('/依頼者/1.進行事件/や 佐藤一郎　婚姻費用');
  });

  it('事件の区分を変えると、その事件のフォルダだけを区分フォルダ間で移す', async () => {
    const { client, a, b } = seedTwoFolders('移動 次郎', ['M1', 'M2']);
    db().update(schema.cases).set({ status: 'closed' }).where(eq(schema.cases.id, b.id)).run();
    moves.length = 0;
    const r = await cf.syncClientFolderWithStatus(client.id, b.id);
    expect(r).toEqual({ moved: true, from: '1.進行事件', to: '3.終了事件' });
    expect(moves).toEqual([{ id: 'M2', to: '/依頼者/3.終了事件' }]);
    expect(caseRow(b.id).onedriveFolderPath).toBe('3.終了事件/や 移動次郎　婚姻費用');
    expect(caseRow(a.id).onedriveFolderPath).toBe('1.進行事件/や 移動次郎　離婚');
    const note = db().select().from(schema.caseNotes).where(eq(schema.caseNotes.caseId, b.id)).all().at(-1)!;
    expect(note.gist).toContain('事件フォルダ「や 移動次郎　婚姻費用」を「1.進行事件」から「3.終了事件」へ移動');
    // 依頼者フォルダと同じフォルダの事件を動かしたら、依頼者フォルダのパスも付け替える
    db().update(schema.cases).set({ status: 'wrapup' }).where(eq(schema.cases.id, a.id)).run();
    await cf.syncClientFolderWithStatus(client.id, a.id);
    expect(caseRow(a.id).onedriveFolderPath).toBe('2.残務処理/や 移動次郎　離婚');
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, client.id)).get()!.onedriveFolderPath).toBe('2.残務処理/や 移動次郎　離婚');
  });

  it('フォルダの区分と食い違っていれば、そのフォルダの事件だけを合わせる', () => {
    const { client, a, b } = seedTwoFolders('食違 三郎', ['D1', 'D2']);
    db().update(schema.cases).set({ onedriveFolderPath: '3.終了事件/や 食違三郎　婚姻費用' }).where(eq(schema.cases.id, b.id)).run();
    const list = cf.folderStatusMismatches().filter((m) => m.clientId === client.id);
    expect(list).toEqual([expect.objectContaining({ folder: '3.終了事件/や 食違三郎　婚姻費用', folderStatus: 'closed', appStatus: 'active', caseIds: [b.id], caseTitles: ['食違 三郎 婚姻費用'] })]);
    cf.applyFolderStatuses([client.id]);
    expect(caseRow(b.id).status).toBe('closed');
    expect(caseRow(a.id).status).toBe('active');
  });

  it('OneDrive で事件のフォルダを別の区分へ移すと、その事件の区分だけを合わせ、パスも付け直す', async () => {
    const { client, a, b } = seedTwoFolders('追従 四郎', ['T1', 'T2']);
    at('T2', 'や 追従四郎　婚姻費用（済）', '2.残務処理');
    const r = await cf.syncClientFolderNames();
    const mine = r.renames.filter((x) => x.clientId === client.id);
    expect(mine).toEqual([expect.objectContaining({ from: '1.進行事件/や 追従四郎　婚姻費用', to: '2.残務処理/や 追従四郎　婚姻費用（済）', caseTitle: '追従 四郎 婚姻費用', status: expect.objectContaining({ to: 'wrapup' }) })]);
    expect(caseRow(b.id)).toMatchObject({ status: 'wrapup', onedriveFolderPath: '2.残務処理/や 追従四郎　婚姻費用（済）' });
    expect(caseRow(a.id)).toMatchObject({ status: 'active', onedriveFolderPath: '1.進行事件/や 追従四郎　離婚' });
  });

  it('フォルダを走査したとき、同じ人のフォルダが複数あれば事件名で照合して事件のフォルダにする', async () => {
    const client = db().insert(schema.clients).values({ name: '照合 五郎' }).returning().get();
    const a = db().insert(schema.cases).values({ clientId: client.id, title: '照合 五郎 離婚', status: 'active' }).returning().get();
    const b = db().insert(schema.cases).values({ clientId: client.id, title: '婚姻費用分担', status: 'active' }).returning().get();
    const c = db().insert(schema.cases).values({ clientId: client.id, title: '相続', status: 'consultation' }).returning().get();
    listing.set('/依頼者/1.進行事件', [
      { name: 'し 照合五郎　離婚', path: '/依頼者/1.進行事件/し 照合五郎　離婚', isFolder: true, itemId: 'R1' },
      { name: 'し 照合五郎　婚姻費用', path: '/依頼者/1.進行事件/し 照合五郎　婚姻費用', isFolder: true, itemId: 'R2' },
    ]);
    await cf.resolveAllClientFolders();
    expect(caseRow(a.id)).toMatchObject({ onedriveFolderPath: '1.進行事件/し 照合五郎　離婚', onedriveItemId: 'R1' });
    expect(caseRow(b.id).onedriveFolderPath).toBe('1.進行事件/し 照合五郎　婚姻費用');
    expect(caseRow(c.id).onedriveFolderPath).toBeNull();
    listing.clear();
  });

  it('新しい事件フォルダは「かな 氏名　事件名」で事件の区分のフォルダに作る', async () => {
    const client = db().insert(schema.clients).values({ name: '新規 六郎', kana: 'しんき' }).returning().get();
    const k = db().insert(schema.cases).values({ clientId: client.id, title: '新規 六郎 交通事故', status: 'consultation' }).returning().get();
    expect(cf.defaultCaseFolderRel(client, k)).toBe('0.相談/し 新規 六郎　交通事故');
    const r = await cf.createCaseFolder(k.id, null);
    expect(r.path).toBe('0.相談/し 新規 六郎　交通事故');
    expect(caseRow(k.id).onedriveFolderPath).toBe('0.相談/し 新規 六郎　交通事故');
    // 依頼者フォルダがまだ無ければ、それも同じにする
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, client.id)).get()!.onedriveFolderPath).toBe('0.相談/し 新規 六郎　交通事故');
    // 指定し直し・依頼者フォルダに戻す
    await cf.setCaseFolder(k.id, '0.相談/別フォルダ/');
    expect(caseRow(k.id).onedriveFolderPath).toBe('0.相談/別フォルダ');
    await cf.setCaseFolder(k.id, null);
    expect(caseRow(k.id).onedriveFolderPath).toBeNull();
    await expect(cf.setCaseFolder(k.id, '../外')).rejects.toThrow('正しくありません');
  });

  it('OneDrive から取り込むとき、同じ人の別のフォルダは別の事件にする（依頼者フォルダは上書きしない）', () => {
    const r = applyImport([
      { name: '取込 七子', folderPath: '1.進行事件/と 取込七子　離婚', caseStatus: 'active', caseTitle: '離婚', kana: 'と' },
      { name: '取込 七子', folderPath: '3.終了事件/と 取込七子　破産', caseStatus: 'closed', caseTitle: '破産', kana: 'と' },
    ]);
    expect(r).toMatchObject({ created: 1, casesCreated: 2 });
    const client = db().select().from(schema.clients).where(eq(schema.clients.name, '取込 七子')).get()!;
    expect(client.onedriveFolderPath).toBe('1.進行事件/と 取込七子　離婚');
    const cases = db().select().from(schema.cases).where(eq(schema.cases.clientId, client.id)).all();
    expect(cases.map((k) => [k.title, k.status, k.onedriveFolderPath])).toEqual([
      ['離婚', 'active', '1.進行事件/と 取込七子　離婚'],
      ['破産', 'closed', '3.終了事件/と 取込七子　破産'],
    ]);
    // もう一度取り込んでも増えない。事件名の合う既存の事件には、フォルダを付けるだけ
    const k3 = db().insert(schema.cases).values({ clientId: client.id, title: '取込 七子 相続', status: 'consultation' }).returning().get();
    const r2 = applyImport([
      { name: '取込 七子', existingClientId: client.id, folderPath: '1.進行事件/と 取込七子　離婚', caseStatus: 'active', caseTitle: '離婚' },
      { name: '取込 七子', existingClientId: client.id, folderPath: '0.相談/と 取込七子　相続', caseStatus: 'consultation', caseTitle: '相続' },
    ]);
    expect(r2.casesCreated).toBe(0);
    expect(caseRow(k3.id).onedriveFolderPath).toBe('0.相談/と 取込七子　相続');
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, client.id)).get()!.onedriveFolderPath).toBe('1.進行事件/と 取込七子　離婚');
  });
});
