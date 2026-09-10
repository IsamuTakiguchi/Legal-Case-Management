import { eq, isNull, and } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getLineFollowerIds, getLineProfile } from '../channels/line.js';
import { linkConversationToClient, cleanDisplayName } from './identity.js';
import { upsertAlert, resolveAlertsByKeyPrefix } from './alerts.js';
import { isConfigured } from '../config.js';
import { logger } from '../logger.js';

export type FriendSource = 'follow' | 'followers_api' | 'message' | 'conversation';

/** 友だちを登録・更新する（名前が分かったら上書き、ブロック解除なら unfollowedAt を消す） */
export function upsertLineFriend(f: { userId: string; displayName?: string | null; pictureUrl?: string | null; source: FriendSource; followedAt?: string | null }) {
  const now = new Date().toISOString();
  const cur = db().select().from(schema.lineFriends).where(eq(schema.lineFriends.userId, f.userId)).get();
  const name = cleanDisplayName(f.displayName) ?? cur?.displayName ?? null;
  if (!cur) {
    db()
      .insert(schema.lineFriends)
      .values({ userId: f.userId, displayName: name, pictureUrl: f.pictureUrl ?? null, followedAt: f.followedAt ?? (f.source === 'follow' ? now : null), lastSeenAt: now, source: f.source })
      .run();
    return;
  }
  db()
    .update(schema.lineFriends)
    .set({
      displayName: name,
      pictureUrl: f.pictureUrl ?? cur.pictureUrl,
      followedAt: f.source === 'follow' ? (f.followedAt ?? now) : cur.followedAt,
      unfollowedAt: f.source === 'follow' ? null : cur.unfollowedAt,
      lastSeenAt: now,
      updatedAt: now,
    })
    .where(eq(schema.lineFriends.userId, f.userId))
    .run();
}

export function markLineUnfollowed(userId: string) {
  const now = new Date().toISOString();
  const cur = db().select().from(schema.lineFriends).where(eq(schema.lineFriends.userId, userId)).get();
  if (cur) db().update(schema.lineFriends).set({ unfollowedAt: now, updatedAt: now }).where(eq(schema.lineFriends.userId, userId)).run();
  else db().insert(schema.lineFriends).values({ userId, unfollowedAt: now, source: 'follow' }).run();
  resolveAlertsByKeyPrefix(`line_followed:${userId}`);
}

/** 友だち追加の通知を要確認に出す（すでに依頼者に紐付いている ID なら出さない） */
export function raiseLineFollowed(userId: string, displayName: string | null) {
  const linked = db().select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.lineUserId, userId)).get();
  if (linked) return;
  const name = cleanDisplayName(displayName);
  upsertAlert({
    type: 'line_followed',
    dedupeKey: `line_followed:${userId}`,
    title: `LINE 友だち追加: ${name ?? `名前が取得できない相手（ID 末尾 …${userId.slice(-6)}）`}`,
    body: '依頼者に紐付けると、この相手からの LINE が最初から依頼者のやり取りとして届きます。まだメッセージが無くても紐付けできます。',
    payload: { lineUserId: userId, displayName: name },
    refresh: true,
  });
}

export interface LineFriendRow {
  userId: string;
  displayName: string | null;
  pictureUrl: string | null;
  followedAt: string | null;
  unfollowedAt: string | null;
  lastSeenAt: string | null;
  client: { id: number; name: string } | null;
  conversationId: number | null;
  lastMessageAt: string | null;
}

/** 友だち一覧（依頼者への紐付け状況と、会話の有無つき） */
export function listLineFriends(opts: { unlinkedOnly?: boolean } = {}): LineFriendRow[] {
  const d = db();
  const friends = d.select().from(schema.lineFriends).where(isNull(schema.lineFriends.unfollowedAt)).all();
  const clients = d.select({ id: schema.clients.id, name: schema.clients.name, lineUserId: schema.clients.lineUserId }).from(schema.clients).where(eq(schema.clients.archived, false)).all();
  const convs = d.select({ id: schema.conversations.id, externalThreadId: schema.conversations.externalThreadId, lastMessageAt: schema.conversations.lastMessageAt }).from(schema.conversations).where(eq(schema.conversations.channel, 'line')).all();
  const rows = friends.map((f) => {
    const c = clients.find((x) => x.lineUserId === f.userId);
    const conv = convs.find((x) => x.externalThreadId === f.userId);
    return {
      userId: f.userId,
      displayName: f.displayName,
      pictureUrl: f.pictureUrl,
      followedAt: f.followedAt,
      unfollowedAt: f.unfollowedAt,
      lastSeenAt: f.lastSeenAt,
      client: c ? { id: c.id, name: c.name } : null,
      conversationId: conv?.id ?? null,
      lastMessageAt: conv?.lastMessageAt ?? null,
    };
  });
  const out = opts.unlinkedOnly ? rows.filter((r) => !r.client) : rows;
  return out.sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''));
}

/** その LINE がほかの依頼者に付いていないことを確かめる */
export function assertLineFriendFree(userId: string, exceptClientId: number | null) {
  const other = db().select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(and(eq(schema.clients.lineUserId, userId), eq(schema.clients.archived, false))).get();
  if (other && other.id !== exceptClientId) throw new Error(`この LINE はすでに「${other.name}」に紐付いています。先にそちらの LINE を外してください`);
}

/** 友だちを依頼者に紐付ける。LINE の会話があればそれも依頼者に付け、友だち追加の通知を消す */
export function linkLineFriendToClient(userId: string, clientId: number) {
  const d = db();
  const client = d.select().from(schema.clients).where(eq(schema.clients.id, clientId)).get();
  if (!client) throw new Error('依頼者が見つかりません');
  assertLineFriendFree(userId, clientId);
  d.update(schema.clients).set({ lineUserId: userId, preferredChannel: client.preferredChannel ?? 'line', updatedAt: new Date().toISOString() }).where(eq(schema.clients.id, clientId)).run();
  const conv = d.select().from(schema.conversations).where(and(eq(schema.conversations.channel, 'line'), eq(schema.conversations.externalThreadId, userId))).get();
  if (conv && conv.clientId !== clientId) linkConversationToClient(conv.id, clientId);
  resolveAlertsByKeyPrefix(`line_followed:${userId}`);
  const friend = d.select().from(schema.lineFriends).where(eq(schema.lineFriends.userId, userId)).get();
  if (!friend) upsertLineFriend({ userId, displayName: conv?.counterpartName ?? null, source: 'conversation' });
  return { clientId, conversationId: conv?.id ?? null };
}

/** 友だち一覧 API から取り込む（新しい ID だけプロフィールを取る） */
export async function syncLineFollowers(): Promise<{ ok: boolean; total: number; added: number; reason?: string }> {
  if (!isConfigured('line')) return { ok: false, total: 0, added: 0, reason: 'LINE が未設定です' };
  const r = await getLineFollowerIds();
  if (!r.ok) return { ok: false, total: 0, added: 0, reason: r.reason };
  const known = new Set(db().select({ userId: schema.lineFriends.userId }).from(schema.lineFriends).all().map((x) => x.userId));
  let added = 0;
  for (const userId of r.userIds) {
    if (known.has(userId)) {
      upsertLineFriend({ userId, source: 'followers_api' });
      continue;
    }
    const p = await getLineProfile(userId).catch(() => null);
    upsertLineFriend({ userId, displayName: p?.displayName ?? null, pictureUrl: p?.pictureUrl ?? null, source: 'followers_api' });
    added++;
  }
  logger.info({ total: r.userIds.length, added }, 'LINE の友だち一覧を取り込みました');
  return { ok: true, total: r.userIds.length, added };
}

/** 起動時に一度: 既存の LINE 会話と依頼者の ID から友だち一覧を作る */
export function backfillLineFriends(): number {
  const d = db();
  let n = 0;
  for (const c of d.select().from(schema.conversations).where(eq(schema.conversations.channel, 'line')).all()) {
    if (!c.externalThreadId.startsWith('U')) continue;
    if (d.select().from(schema.lineFriends).where(eq(schema.lineFriends.userId, c.externalThreadId)).get()) continue;
    upsertLineFriend({ userId: c.externalThreadId, displayName: c.counterpartName, source: 'conversation' });
    n++;
  }
  for (const c of d.select().from(schema.clients).all()) {
    if (!c.lineUserId || !c.lineUserId.startsWith('U')) continue;
    if (d.select().from(schema.lineFriends).where(eq(schema.lineFriends.userId, c.lineUserId)).get()) continue;
    upsertLineFriend({ userId: c.lineUserId, displayName: c.name, source: 'conversation' });
    n++;
  }
  return n;
}
