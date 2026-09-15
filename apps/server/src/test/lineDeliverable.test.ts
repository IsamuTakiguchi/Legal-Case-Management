import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-line-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.LINE_CHANNEL_SECRET = 'line-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'token';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { assertLineDeliverable, upsertLineFriend } = await import('../services/lineFriends.js');
const { openAlerts } = await import('../services/alerts.js');
const { eq } = await import('drizzle-orm');

const origFetch = globalThis.fetch;
/** LINE のプロフィール取得の応答を差し替える */
function stubProfile(status: number) {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(status === 200 ? JSON.stringify({ displayName: '山田 花子' }) : '', { status });
  }) as unknown as typeof fetch;
  return () => calls;
}

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe('LINE に届く相手かの確認', () => {
  it('ブロック（プロフィール 404）なら送らずにエラーにし、友だち解除として記録して要確認に出す', async () => {
    upsertLineFriend({ userId: 'Ublocked', displayName: '山田 花子', source: 'follow' });
    stubProfile(404);
    await expect(assertLineDeliverable('Ublocked')).rejects.toThrow(/ブロック/);
    expect(db().select().from(schema.lineFriends).where(eq(schema.lineFriends.userId, 'Ublocked')).get()?.unfollowedAt).toBeTruthy();
    expect(openAlerts().some((a) => a.type === 'line_blocked')).toBe(true);
  });

  it('友だちに戻っていれば、解除の記録を消してそのまま送れる', async () => {
    upsertLineFriend({ userId: 'Uback', source: 'follow' });
    db().update(schema.lineFriends).set({ unfollowedAt: new Date().toISOString() }).where(eq(schema.lineFriends.userId, 'Uback')).run();
    stubProfile(200);
    await expect(assertLineDeliverable('Uback')).resolves.toBeUndefined();
    expect(db().select().from(schema.lineFriends).where(eq(schema.lineFriends.userId, 'Uback')).get()?.unfollowedAt).toBeNull();
  });

  it('確認できないとき（LINE 側のエラー）は送信を止めない', async () => {
    stubProfile(500);
    await expect(assertLineDeliverable('Uunknown')).resolves.toBeUndefined();
  });

  it('グループは「まだ入っているか」で確かめる（退出させられていれば送らない）', async () => {
    stubProfile(404);
    await expect(assertLineDeliverable('Cgroup')).rejects.toThrow(/グループから退出/);
    stubProfile(200);
    await expect(assertLineDeliverable('Cgroup')).resolves.toBeUndefined();
    await expect(assertLineDeliverable('Rroom')).resolves.toBeUndefined();
  });
});
