import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-folders-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.STORAGE_BACKEND = 'local';
process.env.LOCAL_CLIENT_ROOT = path.join(tmp, 'clients');
process.env.DATA_DIR = tmp;

/** OneDrive 上のフォルダ（ID → 今の名前と親） */
const drive = new Map<string, { id: string; name: string; parentReference: { path: string } }>();

vi.mock('../integrations/onedrive.js', async (importActual) => {
  const actual = await importActual<typeof import('../integrations/onedrive.js')>();
  return {
    ...actual,
    isMsConnected: async () => true,
    getItem: async (id: string) => {
      const item = drive.get(id);
      if (!item) throw new Error('Graph エラー 404');
      return item;
    },
    getItemByPath: async (p: string) => {
      for (const item of drive.values()) {
        const full = `${item.parentReference.path.replace(/^\/drive\/root:/, '')}/${item.name}`;
        if (full === p) return item;
      }
      return null;
    },
  };
});

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { setStorageBackend } = await import('../integrations/storage.js');
const { relPathFromItem, syncClientFolderName, syncClientFolderNames, rememberClientFolderId } = await import('../services/clientFolders.js');
const { eq } = await import('drizzle-orm');

/** OneDrive バックエンドのふり（読み書きはしない） */
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
});
afterAll(() => {
  setStorageBackend(null);
  closeDatabase();
});

describe('OneDrive のフォルダ名の変更の取り込み', () => {
  it('親パスから依頼者ルートからの相対パスを求める', () => {
    const item = { name: '山田 花子', parentReference: { path: '/drive/root:/依頼者/1.進行事件' } };
    expect(relPathFromItem(item, '/依頼者')).toBe('1.進行事件/山田 花子');
    // URL エンコードされていても読める
    expect(relPathFromItem({ name: '山田 花子', parentReference: { path: '/drive/root:/%E4%BE%9D%E9%A0%BC%E8%80%85' } }, '/依頼者')).toBe('山田 花子');
    // ルートの外に出されたものは対象にしない
    expect(relPathFromItem({ name: '山田 花子', parentReference: { path: '/drive/root:/別のところ' } }, '/依頼者')).toBeNull();
  });

  it('フォルダ名を変えると依頼者のパスと保存済みファイルの表示パスが付け替わる', async () => {
    drive.set('id-yamada', { id: 'id-yamada', name: '山田花子', parentReference: { path: '/drive/root:/依頼者/1.進行事件' } });
    const client = db().insert(schema.clients).values({ name: '山田 花子', onedriveFolderPath: '1.進行事件/山田花子', onedriveItemId: 'id-yamada' }).returning().get();
    const conv = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: 't-1', clientId: client.id, lastMessageAt: new Date().toISOString() }).returning().get();
    const msg = db().insert(schema.messages).values({ conversationId: conv.id, channel: 'gmail', externalId: 'm-1', direction: 'in', body: '資料です', sentAt: new Date().toISOString() }).returning().get();
    const att = db()
      .insert(schema.attachments)
      .values({ messageId: msg.id, clientId: client.id, filename: '査定書.pdf', status: 'stored', storedPath: '/依頼者/1.進行事件/山田花子/受領資料/20260912_gmail_査定書.pdf' })
      .returning()
      .get();

    // 事務所で OneDrive のフォルダ名を「や 山田花子　離婚」に変えた
    drive.set('id-yamada', { id: 'id-yamada', name: 'や 山田花子　離婚', parentReference: { path: '/drive/root:/依頼者/1.進行事件' } });
    const renamed = await syncClientFolderName(client.id);
    expect(renamed).toMatchObject({ from: '1.進行事件/山田花子', to: '1.進行事件/や 山田花子　離婚' });
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, client.id)).get()?.onedriveFolderPath).toBe('1.進行事件/や 山田花子　離婚');
    expect(db().select().from(schema.attachments).where(eq(schema.attachments.id, att.id)).get()?.storedPath).toBe(
      '/依頼者/1.進行事件/や 山田花子　離婚/受領資料/20260912_gmail_査定書.pdf',
    );

    // 続けて別の区分フォルダへ移されたときも追いかける
    drive.set('id-yamada', { id: 'id-yamada', name: 'や 山田花子　離婚', parentReference: { path: '/drive/root:/依頼者/3.終了事件' } });
    await syncClientFolderName(client.id);
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, client.id)).get()?.onedriveFolderPath).toBe('3.終了事件/や 山田花子　離婚');

    // 変更が無ければ何もしない
    expect(await syncClientFolderName(client.id)).toBeNull();
  });

  it('ID を控えていない依頼者は、今のパスから引いて覚える', async () => {
    drive.set('id-sato', { id: 'id-sato', name: '佐藤太郎', parentReference: { path: '/drive/root:/依頼者/1.進行事件' } });
    const client = db().insert(schema.clients).values({ name: '佐藤 太郎', onedriveFolderPath: '1.進行事件/佐藤太郎' }).returning().get();
    const r = await syncClientFolderNames();
    expect(r.adopted).toBeGreaterThanOrEqual(1);
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, client.id)).get()?.onedriveItemId).toBe('id-sato');

    // 覚えたあとなら、名前を変えても取り込める
    drive.set('id-sato', { id: 'id-sato', name: 'さ 佐藤太郎　交通事故', parentReference: { path: '/drive/root:/依頼者/1.進行事件' } });
    const r2 = await syncClientFolderNames();
    expect(r2.renamed).toBeGreaterThanOrEqual(1);
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, client.id)).get()?.onedriveFolderPath).toBe('1.進行事件/さ 佐藤太郎　交通事故');
  });

  it('フォルダが消えていてもパスは残す（勝手に壊さない）', async () => {
    const client = db().insert(schema.clients).values({ name: '田中 一郎', onedriveFolderPath: '1.進行事件/田中一郎' }).returning().get();
    rememberClientFolderId(client.id, 'id-missing');
    expect(await syncClientFolderName(client.id)).toBeNull();
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, client.id)).get()?.onedriveFolderPath).toBe('1.進行事件/田中一郎');
  });
});
