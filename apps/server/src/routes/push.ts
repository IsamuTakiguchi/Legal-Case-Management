import { Hono } from 'hono';
import { z } from 'zod';
import { listSubscriptions, removeSubscription, saveSubscription, sendTestPush, vapidKeys } from '../services/push.js';

export const pushRoutes = new Hono();

/** 端末が購読を作るのに必要な公開鍵 */
pushRoutes.get('/push/key', (c) => c.json({ publicKey: vapidKeys().publicKey }));

/** 登録済みの端末（購読）の一覧。鍵そのものは返さない */
pushRoutes.get('/push/subscriptions', (c) =>
  c.json(
    listSubscriptions().map((s) => ({
      id: s.id,
      label: s.label,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastSuccessAt: s.lastSuccessAt,
      lastErrorAt: s.lastErrorAt,
      lastError: s.lastError,
      endpointHint: s.endpoint.slice(0, 40),
    })),
  ),
);

const subSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  label: z.string().max(60).optional(),
});

pushRoutes.post('/push/subscribe', async (c) => {
  const body = subSchema.parse(await c.req.json());
  const row = saveSubscription({ ...body, userAgent: c.req.header('user-agent') ?? null });
  return c.json({ ok: true, id: row.id });
});

pushRoutes.post('/push/unsubscribe', async (c) => {
  const { endpoint } = z.object({ endpoint: z.string().url() }).parse(await c.req.json());
  return c.json({ removed: removeSubscription(endpoint) });
});

pushRoutes.post('/push/test', async (c) => c.json(await sendTestPush()));
