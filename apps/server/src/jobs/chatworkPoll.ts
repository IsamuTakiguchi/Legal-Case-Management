import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import * as cw from '../channels/chatwork.js';
import { ingestMessage } from '../services/inbox.js';
import { getSyncState, setSyncState, getSetting } from '../services/settings.js';
import { isConfigured } from '../config.js';
import { logger } from '../logger.js';

const KEY_ME = 'chatwork:myAccountId';
const KEY_ROOM_TYPES = 'chatwork:roomTypes';
const KEY_TASK_MSGS = 'chatwork:taskMessageIds';

function scope(): cw.ChatworkScope {
  return getSetting('chatwork_scope') === 'to_me' ? 'to_me' : 'all';
}

function roomTypes(): Record<string, string> {
  try {
    return JSON.parse(getSyncState(KEY_ROOM_TYPES) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function taskMessageIds(): Set<string> {
  try {
    return new Set(JSON.parse(getSyncState(KEY_TASK_MSGS) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** 自分宛タスクのメッセージ ID を控える（取込範囲 to_me の判定に使う） */
export async function refreshChatworkTaskMessageIds(): Promise<Set<string>> {
  const open = await cw.myTasks('open');
  const ids = new Set(open.map((t) => t.message_id));
  setSyncState(KEY_TASK_MSGS, JSON.stringify([...ids]));
  return ids;
}

function conversationExists(roomId: number): boolean {
  return !!db()
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(and(eq(schema.conversations.channel, 'chatwork'), eq(schema.conversations.externalThreadId, String(roomId))))
    .get();
}

/** Webhook ごとにタスク一覧を取りに行かないよう、控えの更新は 1 分に 1 回まで */
let taskIdsRefreshedAt = 0;
async function taskMessageIdsFresh(): Promise<Set<string>> {
  if (Date.now() - taskIdsRefreshedAt < 60_000) return taskMessageIds();
  taskIdsRefreshedAt = Date.now();
  try {
    return await refreshChatworkTaskMessageIds();
  } catch {
    return taskMessageIds();
  }
}

export async function chatworkMyAccountId(): Promise<number | null> {
  if (!isConfigured('chatwork')) return null;
  const cached = getSyncState(KEY_ME);
  if (cached) return Number(cached);
  const me = await cw.chatworkMe();
  setSyncState(KEY_ME, String(me.account_id));
  return me.account_id;
}

/**
 * Webhook の取りこぼしを補うポーリング。
 * 依頼者に紐付いたルーム＋未読のあるルームを対象に force=1 で取得し、message_id で重複排除する。
 */
export async function pollChatwork(opts: { allRooms?: boolean } = {}): Promise<{ ingested: number; rooms: number }> {
  if (!isConfigured('chatwork')) return { ingested: 0, rooms: 0 };
  const me = await chatworkMyAccountId();
  const rooms = await cw.listRooms();
  const linked = new Set(
    db()
      .select({ id: schema.clients.chatworkRoomId })
      .from(schema.clients)
      .all()
      .map((r) => r.id)
      .filter((x): x is number => !!x),
  );
  const known = new Set(
    db()
      .select({ t: schema.conversations.externalThreadId })
      .from(schema.conversations)
      .where(eq(schema.conversations.channel, 'chatwork'))
      .all()
      .map((r) => Number(r.t)),
  );
  setSyncState(KEY_ROOM_TYPES, JSON.stringify(Object.fromEntries(rooms.map((r) => [String(r.room_id), r.type]))));
  const sc = scope();
  let taskIds = new Set<string>();
  if (sc === 'to_me') {
    try {
      taskIds = await refreshChatworkTaskMessageIds();
    } catch (err) {
      logger.warn({ err }, 'Chatwork タスク一覧の取得に失敗（取込範囲の判定は To だけで行う）');
      taskIds = taskMessageIds();
    }
  }
  let ingested = 0;
  let count = 0;
  for (const room of rooms) {
    if (room.type === 'my') continue;
    const target = opts.allRooms || linked.has(room.room_id) || known.has(room.room_id) || (room.unread_num ?? 0) > 0;
    if (!target) continue;
    count++;
    let msgs: cw.ChatworkMessage[] = [];
    try {
      msgs = await cw.fetchRoomMessages(room.room_id);
    } catch (err) {
      logger.warn({ err, room: room.room_id }, 'Chatwork ルーム取得に失敗');
      continue;
    }
    for (const m of msgs) {
      if (!cw.chatworkInScope(sc, m, { myAccountId: me, roomType: room.type, taskMessageIds: taskIds, conversationExists: conversationExists(room.room_id) })) continue;
      const norm = cw.normalizeChatworkMessage(room.room_id, m, me);
      if (norm.direction === 'in' && !norm.identity.displayName) norm.identity.displayName = room.name;
      const r = await ingestMessage(norm);
      if (r.isNew) ingested++;
    }
  }
  return { ingested, rooms: count };
}

/** Webhook 受信時: 本文は webhook に含まれるが、名前と添付のため API で取り直す */
export async function ingestChatworkWebhook(body: cw.ChatworkWebhookBody): Promise<boolean> {
  const ev = body.webhook_event;
  const me = await chatworkMyAccountId();
  let msg: cw.ChatworkMessage;
  try {
    msg = await cw.fetchMessage(ev.room_id, ev.message_id);
  } catch (err) {
    logger.warn({ err }, 'Chatwork メッセージ再取得に失敗、webhook の本文で保存');
    msg = { message_id: ev.message_id, account: { account_id: ev.account_id, name: '' }, body: ev.body, send_time: ev.send_time, update_time: ev.update_time };
  }
  // 取込範囲が「自分宛だけ」なら、To・全員宛・ダイレクト・自分宛タスク以外は取り込まない（mention_to_me は常に対象）
  if (body.webhook_event_type !== 'mention_to_me') {
    const sc = scope();
    if (sc === 'to_me') {
      let taskIds = taskMessageIds();
      if (!taskIds.has(msg.message_id)) taskIds = await taskMessageIdsFresh();
      if (!cw.chatworkInScope(sc, msg, { myAccountId: me, roomType: roomTypes()[String(ev.room_id)] ?? null, taskMessageIds: taskIds, conversationExists: conversationExists(ev.room_id) })) return false;
    }
  }
  const norm = cw.normalizeChatworkMessage(ev.room_id, msg, me);
  const r = await ingestMessage(norm);
  return r.isNew;
}
