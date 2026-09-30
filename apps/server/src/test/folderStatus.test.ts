import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-folderstatus-'));
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
const { syncClientFolderNames, saveStatusFolderMap, folderStatusMismatches, applyFolderStatuses, alignCaseStatusToFolder } = await import('../services/clientFolders.js');
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


const at = (id: string, name: string, parent: string) => drive.set(id, { id, name, parentReference: { path: `/drive/root:/依頼者/${parent}` } });
const statuses = (clientId: number) => db().select().from(schema.cases).where(eq(schema.cases.clientId, clientId)).all().sort((a, b) => a.id - b.id).map((k) => k.status);

describe('OneDrive の区分フォルダと事件の区分の連動', () => {
  it('依頼者フォルダを別の区分フォルダへ移すと、事件の区分もそれに合わせる（記録も残す）', async () => {
    saveStatusFolderMap({ consultation: '0.相談', active: '1.進行事件', wrapup: '2.残務処理', closed: '3.終了事件' }, []);
    const c = db().insert(schema.clients).values({ name: '移動 太郎', onedriveFolderPath: '1.進行事件/移動太郎', onedriveItemId: 'F1' }).returning().get();
    db().insert(schema.cases).values([
      { clientId: c.id, title: '本件', status: 'active', updatedAt: '2027-01-02T00:00:00.000Z' },
      { clientId: c.id, title: '別件（相談）', status: 'consultation', updatedAt: '2027-01-01T00:00:00.000Z' },
    ]).run();
    at('F1', '移動太郎', '1.進行事件');
    expect((await syncClientFolderNames()).renamed).toBe(0);

    // 終了事件へ移す → 相談も進行事件も終了
    at('F1', '移動太郎', '3.終了事件');
    const r = await syncClientFolderNames();
    expect(r.renames[0]).toMatchObject({ to: '3.終了事件/移動太郎', status: { to: 'closed' } });
    expect(statuses(c.id)).toEqual(['closed', 'closed']);
    const note = db().select().from(schema.caseNotes).where(eq(schema.caseNotes.clientId, c.id)).all()[0]!;
    expect(note.gist).toContain('「進行事件」から「終了事件」');
    expect(note.createdBy).toBe('system');

    // 進行事件へ戻す → いちばん最近更新した事件だけが進行事件に（ほかは終了のまま）
    at('F1', '移動太郎', '1.進行事件');
    await syncClientFolderNames();
    expect(statuses(c.id)).toEqual(['active', 'closed']);

    // 残務処理へ → 進行事件が残務処理に
    at('F1', '移動太郎', '2.残務処理');
    await syncClientFolderNames();
    expect(statuses(c.id)).toEqual(['wrapup', 'closed']);

    // 名前を変えただけ（区分は同じ）なら区分は触らない
    at('F1', '移動太郎（完了）', '2.残務処理');
    const r2 = await syncClientFolderNames();
    expect(r2.renames[0]!.status).toBeUndefined();
    expect(statuses(c.id)).toEqual(['wrapup', 'closed']);
  });

  it('相談しかない依頼者のフォルダが進行事件へ移されたら、相談の事件を進行事件にする（受任）', () => {
    const c = db().insert(schema.clients).values({ name: '受任 花子' }).returning().get();
    db().insert(schema.cases).values([
      { clientId: c.id, title: '古い終了事件', status: 'closed', updatedAt: '2027-03-01T00:00:00.000Z' },
      { clientId: c.id, title: '新しい相談', status: 'consultation', updatedAt: '2027-02-01T00:00:00.000Z' },
    ]).run();
    const ch = alignCaseStatusToFolder(c.id, 'active', 'テスト');
    expect(ch).toEqual([expect.objectContaining({ title: '新しい相談', from: 'consultation', to: 'active' })]);
    expect(statuses(c.id)).toEqual(['closed', 'active']);
    // すでに合っていれば何もしない
    expect(alignCaseStatusToFolder(c.id, 'active', 'テスト')).toEqual([]);
  });

  it('以前から食い違っている依頼者を一覧にし、選んだ依頼者だけ合わせる。区分フォルダの外は対象外', () => {
    const a = db().insert(schema.clients).values({ name: '食違 一郎', onedriveFolderPath: '3.終了事件/食違一郎' }).returning().get();
    const b = db().insert(schema.clients).values({ name: '食違 二郎', onedriveFolderPath: '0.相談/食違二郎' }).returning().get();
    const x = db().insert(schema.clients).values({ name: '顧問 会社', onedriveFolderPath: '4.顧問/顧問会社' }).returning().get();
    for (const cl of [a, b, x]) db().insert(schema.cases).values({ clientId: cl.id, title: `${cl.name} 事件`, status: 'active' }).run();
    const list = folderStatusMismatches().filter((m) => [a.id, b.id, x.id].includes(m.clientId));
    expect(list.map((m) => [m.clientName, m.appStatus, m.folderStatus])).toEqual([
      ['食違 一郎', 'active', 'closed'],
      ['食違 二郎', 'active', 'consultation'],
    ]);
    const r = applyFolderStatuses([a.id]);
    expect(r.clients).toBe(1);
    expect(statuses(a.id)).toEqual(['closed']);
    expect(statuses(b.id)).toEqual(['active']);
    expect(folderStatusMismatches().some((m) => m.clientId === a.id)).toBe(false);
  });
});
