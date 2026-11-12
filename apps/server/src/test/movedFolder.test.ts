import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-movedfolder-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.STORAGE_BACKEND = 'local';
process.env.LOCAL_CLIENT_ROOT = path.join(tmp, 'clients');
process.env.DATA_DIR = tmp;

/** OneDrive 上のフォルダ（ID → 名前と親） */
const drive = new Map<string, { id: string; name: string; folder: { childCount: number }; parentReference: { path: string } }>();
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
    moveItem: async () => undefined,
  };
});

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { setStorageBackend } = await import('../integrations/storage.js');
const cf = await import('../services/clientFolders.js');
const { clientFolder, caseFolder } = await import('../services/attachments.js');
const { setSetting } = await import('../services/settings.js');
const { eq } = await import('drizzle-orm');

const fakeOneDrive = {
  kind: 'onedrive' as const,
  clientRoot: () => '/依頼者',
  ensureFolder: async () => undefined,
  put: async () => ({ path: '', size: 0 }),
  get: async () => Buffer.alloc(0),
  move: async () => ({ path: '', size: 0 }),
  list: async () => [],
  remove: async () => undefined,
};

beforeAll(() => {
  openTestDatabase();
  setStorageBackend(fakeOneDrive);
  cf.saveStatusFolderMap({ consultation: '0.相談', active: '1.進行事件', wrapup: '2.残務処理', closed: '3.終了事件' }, ['4.顧問等']);
  setSetting('client_folder_name_format', '{kana} {name}');
});
afterAll(() => {
  setStorageBackend(null);
  closeDatabase();
});

const at = (id: string, name: string, parent: string) => drive.set(id, { id, name, folder: { childCount: 1 }, parentReference: { path: `/drive/root:/依頼者/${parent}` } });
const clientRow = (id: number) => db().select().from(schema.clients).where(eq(schema.clients.id, id)).get()!;

describe('OneDrive で別の区分フォルダへ移された依頼者フォルダ', () => {
  it('ID を控える前に移されていても、保存の前に移し先を見つけ、元の区分に作り直さない（事件の区分もフォルダに合わせる）', async () => {
    const client = db().insert(schema.clients).values({ name: '山田 太郎', kana: 'や', onedriveFolderPath: '1.進行事件/や 山田太郎' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '貸金', status: 'active' }).returning().get();
    // 弁護士が OneDrive で 1.進行事件 → 2.残務処理 へ移した（アプリは ID をまだ控えていない）
    at('f-yamada', 'や 山田太郎', '2.残務処理');
    await cf.syncClientFolderName(client.id);
    const c = clientRow(client.id);
    expect(c.onedriveFolderPath).toBe('2.残務処理/や 山田太郎');
    expect(c.onedriveItemId).toBe('f-yamada');
    expect(clientFolder(c)).toBe('/依頼者/2.残務処理/や 山田太郎');
    expect(caseFolder(c, db().select().from(schema.cases).where(eq(schema.cases.id, kase.id)).get())).toBe('/依頼者/2.残務処理/や 山田太郎');
    // フォルダの区分に合わせて、事件も残務処理になる（次にアプリが進行事件へ戻そうとしないように）
    expect(db().select().from(schema.cases).where(eq(schema.cases.id, kase.id)).get()!.status).toBe('wrapup');
  });

  it('依頼者フォルダの場所をまだ控えていなくても、既定の場所に無ければほかの区分から探す', async () => {
    const client = db().insert(schema.clients).values({ name: '佐藤 花子', kana: 'さ' }).returning().get();
    db().insert(schema.cases).values({ clientId: client.id, title: '離婚', status: 'active' }).run();
    // 既定なら 1.進行事件/さ 佐藤花子 に作るところ、顧問等のフォルダに置いてある
    at('f-sato', 'さ 佐藤 花子', '4.顧問等');
    expect(clientFolder(clientRow(client.id))).toBe('/依頼者/1.進行事件/さ 佐藤 花子');
    await cf.syncClientFolderName(client.id);
    expect(clientRow(client.id).onedriveFolderPath).toBe('4.顧問等/さ 佐藤 花子');
    expect(clientFolder(clientRow(client.id))).toBe('/依頼者/4.顧問等/さ 佐藤 花子');
  });

  it('元の場所にあればそのまま。どこにも無い・同じ名前が 2 つあるときは付け替えない（新しく作る）', async () => {
    const here = db().insert(schema.clients).values({ name: '田中 一郎', kana: 'た', onedriveFolderPath: '1.進行事件/た 田中一郎' }).returning().get();
    at('f-tanaka', 'た 田中一郎', '1.進行事件');
    at('f-tanaka2', 'た 田中一郎', '3.終了事件');
    await cf.syncClientFolderName(here.id);
    expect(clientRow(here.id).onedriveFolderPath).toBe('1.進行事件/た 田中一郎');

    const nowhere = db().insert(schema.clients).values({ name: '鈴木 次郎', kana: 'す', onedriveFolderPath: '1.進行事件/す 鈴木次郎' }).returning().get();
    await cf.syncClientFolderName(nowhere.id);
    expect(clientRow(nowhere.id).onedriveFolderPath).toBe('1.進行事件/す 鈴木次郎');

    const twice = db().insert(schema.clients).values({ name: '伊藤 誠', kana: 'い', onedriveFolderPath: '1.進行事件/い 伊藤誠' }).returning().get();
    at('f-ito1', 'い 伊藤誠', '2.残務処理');
    at('f-ito2', 'い 伊藤誠', '3.終了事件');
    await cf.syncClientFolderName(twice.id);
    expect(clientRow(twice.id).onedriveFolderPath).toBe('1.進行事件/い 伊藤誠');
  });

  it('事件ごとのフォルダも、移し先を見つけて付け直す', async () => {
    const client = db().insert(schema.clients).values({ name: '高橋 三郎', kana: 'た', onedriveFolderPath: '1.進行事件/た 高橋三郎' }).returning().get();
    at('f-takahashi', 'た 高橋三郎', '1.進行事件');
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '交通事故', status: 'active', onedriveFolderPath: '1.進行事件/た 高橋三郎　交通事故' }).returning().get();
    at('f-takahashi-jiko', 'た 高橋三郎　交通事故', '2.残務処理');
    await cf.syncClientFolderName(client.id);
    const k = db().select().from(schema.cases).where(eq(schema.cases.id, kase.id)).get()!;
    expect(k.onedriveFolderPath).toBe('2.残務処理/た 高橋三郎　交通事故');
    expect(k.onedriveItemId).toBe('f-takahashi-jiko');
    expect(clientRow(client.id).onedriveFolderPath).toBe('1.進行事件/た 高橋三郎');
  });
});
