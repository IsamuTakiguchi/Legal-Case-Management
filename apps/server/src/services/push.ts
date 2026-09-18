import webpush from 'web-push';
import { and, desc, eq, gt } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { logger } from '../logger.js';
import { getSetting, getSyncState, setSyncState } from './settings.js';
import { CHANNEL_LABEL } from '@lcm/shared';
import { openAlerts } from './alerts.js';
import { inboxCounts, type ConversationRow, type MessageRow } from './inbox.js';

/** 通知と一緒に送る「アイコンに出す件数」。設定（app_badge_source）に合わせて数える */
export function badgeCountForPush(): number | undefined {
  const source = getSetting('app_badge_source') || 'inbox';
  if (source === 'off') return undefined;
  // 画面のメニューと同じ数え方にそろえる（受信箱で隠している会話は数えない）
  const { inbox, unread } = inboxCounts();
  if (source === 'inbox_unread') return unread;
  return source === 'inbox_alerts' ? inbox + openAlerts().length : inbox;
}

const KEY_PUBLIC = 'push:vapid_public';
const KEY_PRIVATE = 'push:vapid_private';

export interface PushPayload {
  title: string;
  body: string;
  /** 通知を押したときに開く画面 */
  url?: string;
  /** 同じ tag の通知は 1 つにまとめられる */
  tag?: string;
  /** アイコンに出す件数（受け取った端末で設定する） */
  badge?: number;
}

/** 送信元の鍵。無ければ作って保存する（1 度作ったら変えない。変えると購読が全部無効になる） */
export function vapidKeys(): { publicKey: string; privateKey: string } {
  let pub = getSyncState(KEY_PUBLIC);
  let priv = getSyncState(KEY_PRIVATE);
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    setSyncState(KEY_PUBLIC, pub);
    setSyncState(KEY_PRIVATE, priv);
    logger.info('通知用の鍵（VAPID）を作りました');
  }
  return { publicKey: pub, privateKey: priv };
}

function subject(): string {
  // web-push は mailto: か https: の連絡先を必須にしている
  const mail = getSetting('vapid_contact_email') || 'takiguchi@noborilaw.com';
  return mail.startsWith('http') || mail.startsWith('mailto:') ? mail : `mailto:${mail}`;
}

export function listSubscriptions() {
  return db().select().from(schema.pushSubscriptions).orderBy(desc(schema.pushSubscriptions.createdAt)).all();
}

export function saveSubscription(input: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label?: string | null;
  userAgent?: string | null;
}) {
  const d = db();
  const existing = d.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, input.endpoint)).get();
  if (existing) {
    d.update(schema.pushSubscriptions)
      .set({
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        label: input.label ?? existing.label,
        userAgent: input.userAgent ?? existing.userAgent,
        failCount: 0,
        lastError: null,
        lastErrorAt: null,
      })
      .where(eq(schema.pushSubscriptions.id, existing.id))
      .run();
    return { ...existing, id: existing.id };
  }
  return d
    .insert(schema.pushSubscriptions)
    .values({
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      label: input.label ?? null,
      userAgent: input.userAgent ?? null,
    })
    .returning()
    .get();
}

export function removeSubscription(endpoint: string): number {
  return db().delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, endpoint)).run().changes;
}

/** 登録済みのすべての端末へ通知を送る。相手が消えていたら購読を削除する */
export async function sendPush(payload: PushPayload): Promise<{ sent: number; removed: number; failed: number }> {
  const subs = listSubscriptions();
  if (!subs.length) return { sent: 0, removed: 0, failed: 0 };
  const { publicKey, privateKey } = vapidKeys();
  webpush.setVapidDetails(subject(), publicKey, privateKey);
  const text = JSON.stringify(payload);
  let sent = 0;
  let removed = 0;
  let failed = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, text, { TTL: 60 * 60 * 12 });
      db().update(schema.pushSubscriptions).set({ lastSuccessAt: new Date().toISOString(), failCount: 0, lastError: null }).where(eq(schema.pushSubscriptions.id, s.id)).run();
      sent++;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      // 404/410 は「その端末の購読はもう無い」という意味なので消す
      if (code === 404 || code === 410) {
        db().delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, s.id)).run();
        removed++;
        continue;
      }
      failed++;
      db()
        .update(schema.pushSubscriptions)
        .set({ lastErrorAt: new Date().toISOString(), lastError: String((err as Error).message ?? err).slice(0, 300), failCount: (s.failCount ?? 0) + 1 })
        .where(eq(schema.pushSubscriptions.id, s.id))
        .run();
      logger.warn({ err, endpoint: s.endpoint.slice(0, 60) }, '通知の送信に失敗');
    }
  }
  return { sent, removed, failed };
}

/** 通知に出す本文。長すぎると切れるので 120 字まで */
export function previewBody(body: string | null | undefined): string {
  const t = (body ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 120 ? `${t.slice(0, 120)}…` : t;
}

interface Pending {
  convId: number;
  channel: string;
  from: string;
  body: string;
}

const pending: Pending[] = [];
let timer: NodeJS.Timeout | null = null;
/** まとめて届いたときに通知が連発しないよう、少し待ってから 1 通にする */
const DEBOUNCE_MS = 4000;

/** 受信を通知の待ち行列に入れる（すぐには送らない） */
export function queueInboundPush(conv: ConversationRow, message: MessageRow): void {
  if (getSetting('push_inbound') === '0') return;
  pending.push({
    convId: conv.id,
    channel: conv.channel,
    from: message.senderName ?? conv.counterpartName ?? conv.subject ?? '相手',
    body: previewBody(message.body),
  });
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const items = pending.splice(0, pending.length);
    flushInbound(items).catch((err) => logger.warn({ err }, '受信の通知に失敗'));
  }, DEBOUNCE_MS);
  timer.unref?.();
}

async function flushInbound(items: Pending[]): Promise<void> {
  if (!items.length) return;
  const convIds = new Set(items.map((i) => i.convId));
  const first = items[0]!;
  const ch = CHANNEL_LABEL[first.channel as keyof typeof CHANNEL_LABEL] ?? first.channel;
  const badge = badgeCountForPush();
  const payload: PushPayload =
    items.length === 1
      ? { title: `${first.from}（${ch}）`, body: first.body || '（本文なし）', url: `/inbox/${first.convId}`, tag: `conv-${first.convId}` }
      : {
          title: `新しい連絡 ${items.length} 件`,
          body: [...new Set(items.map((i) => i.from))].slice(0, 4).join('、') + (convIds.size > 4 ? ' ほか' : ''),
          url: '/inbox',
          tag: 'inbox',
        };
  await sendPush({ ...payload, badge });
}

/** 設定画面の「テスト送信」用 */
export async function sendTestPush() {
  return sendPush({ title: 'T-Lex', body: '通知のテストです。これが出れば設定は完了です。', url: '/', tag: 'test' });
}

/** テスト用: 待ち行列を空にする */
export function resetPushQueue(): void {
  pending.length = 0;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** テスト用: 待ち行列に入っている件数 */
export function pushQueueLength(): number {
  return pending.length;
}
