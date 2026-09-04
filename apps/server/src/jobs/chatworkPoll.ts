import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import * as cw from '../channels/chatwork.js';
import { ingestMessage } from '../services/inbox.js';
import { getSyncState, setSyncState } from '../services/settings.js';
import { isConfigured } from '../config.js';
import { logger } from '../logger.js';

const KEY_ME = 'chatwork:myAccountId';

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
  const norm = cw.normalizeChatworkMessage(ev.room_id, msg, me);
  const r = await ingestMessage(norm);
  return r.isNew;
}
