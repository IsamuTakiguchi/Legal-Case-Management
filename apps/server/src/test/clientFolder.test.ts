import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-folder-'));
const root = path.join(tmp, 'clients');
fs.mkdirSync(root, { recursive: true });
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.STORAGE_BACKEND = 'local';
process.env.LOCAL_CLIENT_ROOT = root;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { listClientFolder, listCourtDocs } = await import('../services/court.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

/** 依頼者フォルダに、更新日時を指定してファイルを置く */
async function putFile(rel: string, when: string) {
  const abs = path.join(root, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, 'x');
  await fsp.utimes(abs, new Date(when), new Date(when));
}

describe('事件フォルダのファイルを選ぶ', () => {
  it('フォルダの中を見られ、サブフォルダにも入れる', async () => {
    const client = db().insert(schema.clients).values({ name: '山田 花子', onedriveFolderPath: '山田 花子' }).returning().get();
    await putFile('山田 花子/委任状.pdf', '2027-09-01T01:00:00Z');
    await putFile('山田 花子/提出書面/準備書面（2）.pdf', '2027-10-05T01:00:00Z');
    await putFile('山田 花子/提出書面/証拠説明書.pdf', '2027-10-04T01:00:00Z');
    await putFile('山田 花子/メモ.exe', '2027-10-05T01:00:00Z');

    const top = await listClientFolder(client.id);
    expect(top.sub).toBe('');
    expect(top.parent).toBeNull();
    expect(top.folders.map((f) => f.name)).toEqual(['提出書面']);
    // 添付にできない拡張子は出さない
    expect(top.files.map((f) => f.name)).toEqual(['委任状.pdf']);

    const sub = await listClientFolder(client.id, top.folders[0]!.sub);
    expect(sub.sub).toBe('提出書面');
    expect(sub.parent).toBe('');
    // 更新が新しい順
    expect(sub.files.map((f) => f.name)).toEqual(['準備書面（2）.pdf', '証拠説明書.pdf']);
  });

  it('「..」や絶対パスで依頼者フォルダの外には出られない', async () => {
    const client = db().insert(schema.clients).values({ name: '佐藤 太郎', onedriveFolderPath: '佐藤 太郎' }).returning().get();
    await putFile('佐藤 太郎/受任通知.pdf', '2027-09-01T01:00:00Z');
    await putFile('ほかの依頼者/秘密.pdf', '2027-09-01T01:00:00Z');
    // 「..」などは取り除かれるので、外のフォルダには届かない
    for (const bad of ['..', './../.', '../']) {
      const r = await listClientFolder(client.id, bad);
      expect(r.sub).toBe('');
      expect(r.files.map((f) => f.name)).toEqual(['受任通知.pdf']);
    }
    // 外を指したつもりでも、依頼者フォルダの中として扱われる（無いので見つからない）
    for (const bad of ['../ほかの依頼者', '/ほかの依頼者']) {
      await expect(listClientFolder(client.id, bad)).rejects.toThrow(/フォルダがありません: \/佐藤 太郎\/ほかの依頼者/);
    }
  });

  it('提出書面の一覧は、更新が新しい順で日数でも絞れる', async () => {
    const client = db().insert(schema.clients).values({ name: '鈴木 一郎', onedriveFolderPath: '鈴木 一郎' }).returning().get();
    const now = Date.now();
    await putFile('鈴木 一郎/提出書面/新しい.pdf', new Date(now - 2 * 86400_000).toISOString());
    await putFile('鈴木 一郎/提出書面/古い.pdf', new Date(now - 90 * 86400_000).toISOString());
    const all = await listCourtDocs(client.id, { days: 365 });
    expect(all.map((f) => f.name)).toEqual(['新しい.pdf', '古い.pdf']);
    const recent = await listCourtDocs(client.id, { days: 7 });
    expect(recent.map((f) => f.name)).toEqual(['新しい.pdf']);
  });

  it('無い依頼者を指定したらエラーになる', async () => {
    await expect(listClientFolder(99999)).rejects.toThrow(/依頼者が見つかりません/);
  });
});
