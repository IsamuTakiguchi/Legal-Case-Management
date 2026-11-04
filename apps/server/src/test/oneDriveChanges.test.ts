import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-odchanges-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.STORAGE_BACKEND = 'onedrive';
process.env.ONEDRIVE_CLIENT_ROOT = '/依頼者';

/** 偽の OneDrive。delta はページごとに返す */
const calls: string[] = [];
let pages: { name: string; parent: string; folder?: boolean; deleted?: boolean }[][] = [];
let failWith: string | null = null;
vi.mock('../integrations/onedrive.js', async (orig) => {
  const actual = await orig<typeof import('../integrations/onedrive.js')>();
  return {
    ...actual,
    latestDriveDeltaLink: async () => {
      calls.push('latest');
      return 'delta-latest';
    },
    driveDeltaPages: async (link: string, onPage: (items: unknown[]) => void) => {
      calls.push(`delta:${link}`);
      if (failWith) throw new Error(failWith);
      for (const p of pages)
        onPage(
          p.map((x, i) => ({
            id: `${x.name}-${i}`,
            name: x.name,
            size: 10,
            ...(x.folder ? { folder: { childCount: 0 } } : { file: {} }),
            ...(x.deleted ? { deleted: {} } : {}),
            parentReference: { path: `/drives/b!x/root:${x.parent}` },
            lastModifiedDateTime: '2026-11-03T00:00:00Z',
          })),
        );
      return 'delta-next';
    },
  };
});

const { storage } = await import('../integrations/storage.js');

beforeEach(() => {
  calls.length = 0;
  pages = [];
  failWith = null;
});

describe('OneDrive の変更の取り方', () => {
  it('初回はドライブ全体を読まず、いまから見はじめる', async () => {
    const r = await storage().changedFiles!('/依頼者', null);
    expect(r).toEqual({ files: [], cursor: 'delta-latest', initial: true });
    expect(calls).toEqual(['latest']);
  });

  it('ドライブ全体の変更から、依頼者フォルダ配下の・受け付ける形式のファイルだけを残す', async () => {
    pages = [
      [
        { name: '準備書面.docx', parent: '/依頼者/山田' },
        { name: '写真.jpg', parent: '/依頼者/山田/受領資料' },
        { name: '山田', parent: '/依頼者', folder: true },
        { name: '消した.docx', parent: '/依頼者/山田', deleted: true },
      ],
      [
        { name: '私物.docx', parent: '/個人' },
        { name: '依頼者以外.docx', parent: '/依頼者メモ' },
        { name: '契約書.xlsx', parent: '/依頼者/%E4%BD%90%E8%97%A4' },
      ],
    ];
    const r = await storage().changedFiles!('/依頼者', 'delta-1', { accept: /\.(docx|xlsx)$/ });
    expect(r.cursor).toBe('delta-next');
    expect(r.initial).toBe(false);
    expect(r.files.map((f) => f.path)).toEqual(['/依頼者/山田/準備書面.docx', '/依頼者/佐藤/契約書.xlsx']);
  });

  it('目印が古くて使えないときは、いまから見はじめる。それ以外の失敗はそのまま知らせる', async () => {
    failWith = 'Graph API エラー 410 resyncRequired';
    expect(await storage().changedFiles!('/依頼者', 'old')).toEqual({ files: [], cursor: 'delta-latest', initial: true });
    failWith = 'Graph API エラー 500';
    await expect(storage().changedFiles!('/依頼者', 'old')).rejects.toThrow('500');
  });
});
