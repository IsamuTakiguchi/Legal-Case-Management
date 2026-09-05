import { Hono } from 'hono';
import { verifyLineSignature, normalizeLineEvent, getLineProfile, type LineEvent } from '../channels/line.js';
import { verifyChatworkSignature, type ChatworkWebhookBody } from '../channels/chatwork.js';
import { ingestChatworkWebhook } from '../jobs/chatworkPoll.js';
import { ingestMessage } from '../services/inbox.js';
import { logger } from '../logger.js';
import { db, schema } from '../db/index.js';
import { eq, and } from 'drizzle-orm';

export const webhookRoutes = new Hono();

/** LINE: 署名検証 → 即 200 → 非同期で取り込み */
webhookRoutes.post('/line', async (c) => {
  const raw = Buffer.from(await c.req.arrayBuffer());
  if (!verifyLineSignature(raw, c.req.header('x-line-signature'))) {
    logger.warn('LINE webhook の署名が不正');
    return c.text('invalid signature', 401);
  }
  let body: { events?: LineEvent[] };
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return c.text('bad json', 400);
  }
  const events = body.events ?? [];
  setImmediate(() => {
    void (async () => {
      for (const ev of events) {
        try {
          if (ev.type === 'follow' && ev.source?.userId) {
            const p = await getLineProfile(ev.source.userId);
            logger.info({ userId: ev.source.userId, name: p?.displayName }, 'LINE 友だち追加');
            continue;
          }
          const norm = normalizeLineEvent(ev);
          if (!norm) continue;
          const userId = ev.source?.userId;
          if (userId) {
            const conv = db()
              .select()
              .from(schema.conversations)
              .where(and(eq(schema.conversations.channel, 'line'), eq(schema.conversations.externalThreadId, norm.externalThreadId)))
              .get();
            if (!conv?.counterpartName) {
              const p = await getLineProfile(userId);
              norm.senderName = p?.displayName ?? null;
              norm.identity.displayName = p?.displayName ?? null;
            } else {
              norm.senderName = conv.counterpartName;
              norm.identity.displayName = conv.counterpartName;
            }
          }
          await ingestMessage(norm);
        } catch (err) {
          logger.error({ err, type: ev.type, messageId: ev.message?.id }, 'LINE イベント処理に失敗');
        }
      }
    })();
  });
  return c.json({ ok: true });
});

/** Chatwork: 署名検証 → 即 200 → 非同期で取り込み */
webhookRoutes.post('/chatwork', async (c) => {
  const raw = Buffer.from(await c.req.arrayBuffer());
  if (!verifyChatworkSignature(raw, c.req.header('x-chatworkwebhooksignature'))) {
    logger.warn('Chatwork webhook の署名が不正');
    return c.text('invalid signature', 401);
  }
  let body: ChatworkWebhookBody;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return c.text('bad json', 400);
  }
  if (body.webhook_event_type === 'message_created' || body.webhook_event_type === 'mention_to_me' || body.webhook_event_type === 'message_updated') {
    setImmediate(() => {
      ingestChatworkWebhook(body).catch((err) => logger.error({ err }, 'Chatwork webhook 処理に失敗'));
    });
  }
  return c.json({ ok: true });
});
