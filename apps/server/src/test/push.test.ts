import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-push-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { vapidKeys, saveSubscription, removeSubscription, listSubscriptions, sendPush, previewBody, badgeCountForPush } = await import('../services/push.js');
const { setSetting, clearSettingsCache } = await import('../services/settings.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

const KEYS = { p256dh: 'BPS_dummy_p256dh_key', auth: 'dummy_auth' };

describe('受信をすぐ知らせる（通知）', () => {
  it('送信元の鍵は一度作ったら変わらない', () => {
    const a = vapidKeys();
    const b = vapidKeys();
    expect(a.publicKey).toBeTruthy();
    expect(a.privateKey).toBeTruthy();
    expect(b.publicKey).toBe(a.publicKey);
  });

  it('同じ端末を二度登録しても 1 件のまま（鍵は上書き）', () => {
    saveSubscription({ endpoint: 'https://push.example/1', keys: KEYS, label: 'iPhone' });
    saveSubscription({ endpoint: 'https://push.example/1', keys: { p256dh: 'new_key', auth: 'new_auth' }, label: 'iPhone' });
    const all = listSubscriptions();
    expect(all.length).toBe(1);
    expect(all[0]!.p256dh).toBe('new_key');
    expect(removeSubscription('https://push.example/1')).toBe(1);
    expect(listSubscriptions().length).toBe(0);
  });

  it('宛先が無ければ何も送らない（ネットワークに出ない）', async () => {
    expect(await sendPush({ title: 'x', body: 'y' })).toEqual({ sent: 0, removed: 0, failed: 0 });
  });

  it('通知の本文は 120 字で切り、改行は 1 つの空白にする', () => {
    expect(previewBody('あ\n\nい  う')).toBe('あ い う');
    const long = 'あ'.repeat(200);
    expect(previewBody(long).length).toBe(121); // 120 字＋…
    expect(previewBody(null)).toBe('');
  });

  it('通知と一緒に送る件数は、アイコンの設定に合わせて数える', () => {
    // 未読 1・未返信 2（うち 1 件はアーカイブ済みなので数えない）
    db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'p-1', unread: 1, needsReply: true, archived: false }).run();
    db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'p-2', unread: 0, needsReply: true, archived: false }).run();
    db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'p-3', unread: 3, needsReply: true, archived: true }).run();
    clearSettingsCache();
    setSetting('app_badge_source', 'inbox_unread');
    expect(badgeCountForPush()).toBe(1);
    setSetting('app_badge_source', 'inbox');
    expect(badgeCountForPush()).toBe(2);
    setSetting('app_badge_source', 'off');
    expect(badgeCountForPush()).toBeUndefined();
  });
});

describe('受信したときに通知の待ち行列へ入るか', () => {
  it('設定が「知らせない」なら入れない。「知らせる」なら入る', async () => {
    const { queueInboundPush, resetPushQueue, pushQueueLength } = await import('../services/push.js');
    const conv = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'q-1', counterpartName: '山田 花子' }).returning().get();
    const msg = db()
      .insert(schema.messages)
      .values({ conversationId: conv.id, channel: 'line', externalId: 'qm-1', direction: 'in', senderName: '山田 花子', body: '書類を送りました', sentAt: '2027-09-01T01:00:00.000Z' })
      .returning()
      .get();
    resetPushQueue();
    setSetting('push_inbound', '0');
    queueInboundPush(conv, msg);
    expect(pushQueueLength()).toBe(0);
    setSetting('push_inbound', '1');
    queueInboundPush(conv, msg);
    expect(pushQueueLength()).toBe(1);
    resetPushQueue();
  });
});
