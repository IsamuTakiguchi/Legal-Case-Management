import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-folderedit-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

/** OneDrive のフォルダ（ID → 名前と親のパス）をこちらで持つ */
type Item = { id: string; name: string; parent: string; deleted?: boolean };
const items = new Map<string, Item>();
const renamed: { id: string; name: string }[] = [];
const fullPath = (i: Item) => `${i.parent}/${i.name}`;
const asDrive = (i: Item) => ({ id: i.id, name: i.name, parentReference: { path: `/drive/root:${i.parent}` }, ...(i.deleted ? { deleted: {} } : {}) });
vi.mock('../integrations/onedrive.js', async (orig) => {
  const actual = await orig<typeof import('../integrations/onedrive.js')>();
  return {
    ...actual,
    isMsConnected: async () => true,
    getItem: async (id: string) => {
      const i = items.get(id);
      if (!i) throw new Error('Graph API エラー 404');
      return asDrive(i);
    },
    getItemByPath: async (p: string) => {
      const i = [...items.values()].find((x) => fullPath(x) === p.replace(/\/+$/, ''));
      return i ? asDrive(i) : null;
    },
    renameItem: async (id: string, name: string) => {
      const i = items.get(id)!;
      if ([...items.values()].some((x) => x.id !== id && x.parent === i.parent && x.name === name)) throw new Error('Graph API エラー 409 /me/drive/items: nameAlreadyExists');
      renamed.push({ id, name });
      i.name = name;
      return asDrive(i);
    },
  };
});

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { setStorageBackend } = await import('../integrations/storage.js');
const { createApp } = await import('../index.js');
const { setPassword } = await import('../auth/index.js');
const { syncClientFolderName, renameClientFolder, validateFolderName } = await import('../services/clientFolders.js');
const { eq } = await import('drizzle-orm');

const ROOT = '/依頼者';
beforeAll(() => {
  openTestDatabase();
  setStorageBackend({ kind: 'onedrive', clientRoot: () => ROOT } as never);
});
afterAll(() => {
  setStorageBackend(null);
  closeDatabase();
});

let clientId = 0;
beforeEach(() => {
  items.clear();
  renamed.length = 0;
  db().delete(schema.attachments).run();
  db().delete(schema.messages).run();
  db().delete(schema.conversations).run();
  db().delete(schema.clients).run();
  items.set('old', { id: 'old', name: 'やまだ山田花子_離婚', parent: `${ROOT}/1.進行事件` });
  items.set('new', { id: 'new', name: 'やまだ山田花子_離婚（2）', parent: `${ROOT}/1.進行事件` });
  clientId = db().insert(schema.clients).values({ name: '山田 花子', onedriveFolderPath: '1.進行事件/やまだ山田花子_離婚', onedriveItemId: 'old' }).returning().get().id;
});

const client = () => db().select().from(schema.clients).where(eq(schema.clients.id, clientId)).get()!;

async function api() {
  const app = createApp();
  setPassword('folder-edit-test');
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'folder-edit-test' }) });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  return (method: string, url: string, body?: unknown) => app.request(url, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe('依頼者フォルダを指定し直す・名前を変える', () => {
  it('画面で別のフォルダを指定したら、そのフォルダを追う（前のフォルダに戻されない）', async () => {
    const call = await api();
    const r = await call('PUT', `/api/clients/${clientId}`, { onedriveFolderPath: '1.進行事件/やまだ山田花子_離婚（2）' });
    expect(r.status).toBe(200);
    expect(client()).toMatchObject({ onedriveFolderPath: '1.進行事件/やまだ山田花子_離婚（2）', onedriveItemId: 'new' });
    // 名前変更の追従を走らせても、前のフォルダには戻らない
    expect(await syncClientFolderName(clientId)).toBeNull();
    expect(client().onedriveFolderPath).toBe('1.進行事件/やまだ山田花子_離婚（2）');
    // その後 OneDrive で新しいフォルダの名前を変えれば、それに付いていく
    items.get('new')!.name = 'やまだ山田花子_離婚・財産分与';
    expect((await syncClientFolderName(clientId))?.to).toBe('1.進行事件/やまだ山田花子_離婚・財産分与');
  });

  it('まだ無いフォルダを指定したら ID は空にしておく（前のフォルダに戻されない）', async () => {
    const call = await api();
    await call('PUT', `/api/clients/${clientId}`, { onedriveFolderPath: '0.相談/やまだ山田花子' });
    expect(client()).toMatchObject({ onedriveFolderPath: '0.相談/やまだ山田花子', onedriveItemId: null });
    expect(await syncClientFolderName(clientId)).toBeNull();
    expect(client().onedriveFolderPath).toBe('0.相談/やまだ山田花子');
  });

  it('フォルダ以外を直しても、フォルダの追跡はそのまま', async () => {
    const call = await api();
    await call('PUT', `/api/clients/${clientId}`, { notes: 'メモ', onedriveFolderPath: '1.進行事件/やまだ山田花子_離婚' });
    expect(client().onedriveItemId).toBe('old');
  });

  it('フォルダ名を変えると、OneDrive の名前・アプリのパス・保存済みファイルの表示がそろって変わる', async () => {
    const conv = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'U1', clientId }).returning().get();
    const msg = db().insert(schema.messages).values({ conversationId: conv.id, channel: 'line', externalId: 'm1', direction: 'in', body: '', sentAt: new Date().toISOString() }).returning().get();
    db()
      .insert(schema.attachments)
      .values({ messageId: msg.id, clientId, filename: '診断書.pdf', status: 'stored', storedPath: `${ROOT}/1.進行事件/やまだ山田花子_離婚/受領資料/診断書.pdf` })
      .run();
    const call = await api();
    const res = await call('POST', `/api/clients/${clientId}/folder/rename`, { name: ' やまだ山田花子_離婚・婚費 ' });
    expect(res.status).toBe(200);
    expect(renamed).toEqual([{ id: 'old', name: 'やまだ山田花子_離婚・婚費' }]);
    expect(client()).toMatchObject({ onedriveFolderPath: '1.進行事件/やまだ山田花子_離婚・婚費', onedriveItemId: 'old' });
    expect(db().select().from(schema.attachments).all()[0]!.storedPath).toBe(`${ROOT}/1.進行事件/やまだ山田花子_離婚・婚費/受領資料/診断書.pdf`);
    // 名前変更の追従も同じ結果になる（二重に書き換えない）
    expect(await syncClientFolderName(clientId)).toBeNull();
  });

  it('同じ名前のフォルダがあるときや、使えない文字は分かるように断る', async () => {
    await expect(renameClientFolder(clientId, 'やまだ山田花子_離婚（2）')).rejects.toThrow('すでにあります');
    expect(client().onedriveFolderPath).toBe('1.進行事件/やまだ山田花子_離婚');
    expect(() => validateFolderName('山田/花子')).toThrow('使えません');
    expect(() => validateFolderName('  ')).toThrow('入力してください');
    expect(() => validateFolderName('山田.')).toThrow('「.」');
  });

  it('フォルダが OneDrive に無ければ名前は変えられない', async () => {
    items.clear();
    await expect(renameClientFolder(clientId, '新しい名前')).rejects.toThrow('見つかりません');
  });
});
