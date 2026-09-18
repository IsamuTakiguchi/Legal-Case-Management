import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-lineinvite-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.LINE_CHANNEL_SECRET = 'line-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'token';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { lineInvite, lineAddFriendUrl, lineInviteMessage } = await import('../services/lineInvite.js');
const { markClientLineInvited, listLineWaitingClients, raiseLineFollowed, linkLineFriendToClient, upsertLineFriend } = await import('../services/lineFriends.js');
const { openAlerts } = await import('../services/alerts.js');
const { eq } = await import('drizzle-orm');

const origFetch = globalThis.fetch;
/** /v2/bot/info の応答を差し替える */
function stubBotInfo(body: Record<string, unknown>, status = 200) {
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('/v2/bot/info')) return new Response(JSON.stringify(body), { status });
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
}

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());
beforeEach(() => {
  db().delete(schema.clients).run();
  db().delete(schema.alerts).run();
  db().delete(schema.lineFriends).run();
  // ボット情報のキャッシュを消して、テストごとに取り直させる
  db().delete(schema.syncState).where(eq(schema.syncState.key, 'line:botInfo')).run();
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

function seedClient(name: string, patch: Record<string, unknown> = {}) {
  return db().insert(schema.clients).values({ name, ...patch }).returning().get();
}

describe('LINE 友だち追加の案内', () => {
  it('友だち追加 URL は LINE の URL スキームで作る', () => {
    expect(lineAddFriendUrl('@abc123')).toBe('https://line.me/R/ti/p/%40abc123');
    // @ が無い ID でも付けてから組み立てる
    expect(lineAddFriendUrl('abc123')).toBe('https://line.me/R/ti/p/%40abc123');
  });

  it('ベーシック ID から URL と QR を作る', async () => {
    stubBotInfo({ basicId: '@lawoffice', displayName: '登大路総合法律事務所' });
    const r = await lineInvite();
    expect(r).toMatchObject({ configured: true, basicId: '@lawoffice', displayName: '登大路総合法律事務所', reason: null });
    expect(r.addUrl).toBe('https://line.me/R/ti/p/%40lawoffice');
    expect(r.qrSvg).toContain('<svg');
  });

  it('プレミアム ID を設定していればそちらを使う', async () => {
    stubBotInfo({ basicId: '@abc123', premiumId: '@nobori-law', displayName: '事務所' });
    expect((await lineInvite()).basicId).toBe('@nobori-law');
  });

  it('2 回目はキャッシュを使い、LINE に問い合わせ直さない', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ basicId: '@abc123' }), { status: 200 });
    }) as unknown as typeof fetch;
    await lineInvite();
    await lineInvite();
    expect(calls).toBe(1);
    // refresh を付けたときだけ取り直す
    await lineInvite({ refresh: true });
    expect(calls).toBe(2);
  });

  it('LINE API が失敗しても落ちず、理由を返す', async () => {
    stubBotInfo({}, 401);
    const r = await lineInvite();
    expect(r.configured).toBe(true);
    expect(r.addUrl).toBeNull();
    expect(r.reason).toContain('401');
  });

  it('案内文には宛名と URL が入る', () => {
    const m = lineInviteMessage('山田 花子', 'https://line.me/R/ti/p/%40abc', '登大路総合法律事務所');
    expect(m).toContain('山田様');
    expect(m).toContain('https://line.me/R/ti/p/%40abc');
    expect(m).toContain('登大路総合法律事務所');
    // 名前が分からなくても宛名を作る
    expect(lineInviteMessage(null, 'https://x', '事務所')).toContain('ご依頼者様');
  });
});

describe('LINE 連携待ち', () => {
  it('連携待ちにすると一覧に出て、解除すると消える', () => {
    const c = seedClient('山田 花子');
    expect(listLineWaitingClients()).toEqual([]);
    markClientLineInvited(c.id, true);
    expect(listLineWaitingClients().map((w) => w.name)).toEqual(['山田 花子']);
    markClientLineInvited(c.id, false);
    expect(listLineWaitingClients()).toEqual([]);
  });

  it('すでに LINE が紐付いている依頼者は連携待ちにしない', () => {
    const c = seedClient('山田 花子', { lineUserId: 'U1' });
    expect(() => markClientLineInvited(c.id, true)).toThrow('すでに LINE が紐付いています');
  });

  it('友だち追加の通知に、連携待ちの依頼者を名前の近い順で載せる', () => {
    const hanako = seedClient('山田 花子');
    const taro = seedClient('佐藤 太郎');
    markClientLineInvited(taro.id, true);
    markClientLineInvited(hanako.id, true);

    raiseLineFollowed('Unew0000000000000000000000000001', '山田花子');
    const alert = openAlerts().find((a) => a.type === 'line_followed')!;
    const waiting = alert.payload.waiting as { id: number; name: string }[];
    // 名前が一致する山田が先頭
    expect(waiting.map((w) => w.name)).toEqual(['山田 花子', '佐藤 太郎']);
    expect(alert.body).toContain('友だち追加をお願いしている依頼者');
  });

  it('連携待ちが誰もいなければ、これまでどおりの案内文になる', () => {
    seedClient('山田 花子');
    raiseLineFollowed('Unew0000000000000000000000000002', '知らない人');
    const alert = openAlerts().find((a) => a.type === 'line_followed')!;
    expect(alert.payload.waiting).toEqual([]);
    expect(alert.body).toContain('まだメッセージが無くても紐付けできます');
  });

  it('紐付けると連携待ちが解け、友だち追加の通知も消える', () => {
    const c = seedClient('山田 花子');
    markClientLineInvited(c.id, true);
    upsertLineFriend({ userId: 'Unew0000000000000000000000000003', displayName: '山田花子', source: 'follow' });
    raiseLineFollowed('Unew0000000000000000000000000003', '山田花子');
    expect(openAlerts().some((a) => a.type === 'line_followed')).toBe(true);

    linkLineFriendToClient('Unew0000000000000000000000000003', c.id);
    const after = db().select().from(schema.clients).where(eq(schema.clients.id, c.id)).get()!;
    expect(after.lineUserId).toBe('Unew0000000000000000000000000003');
    expect(after.lineInvitedAt).toBeNull();
    expect(listLineWaitingClients()).toEqual([]);
    expect(openAlerts().some((a) => a.type === 'line_followed')).toBe(false);
  });

  it('すでに紐付いている相手が追加し直しても通知は出さない', () => {
    const c = seedClient('山田 花子', { lineUserId: 'Uknown000000000000000000000000001' });
    expect(c.lineUserId).toBe('Uknown000000000000000000000000001');
    raiseLineFollowed('Uknown000000000000000000000000001', '山田花子');
    expect(openAlerts().some((a) => a.type === 'line_followed')).toBe(false);
  });
});
