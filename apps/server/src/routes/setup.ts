import { Hono } from 'hono';
import { z } from 'zod';
import { describeCredentials, saveCredentials } from '../services/credentials.js';
import { testService } from '../services/connectionTest.js';
import { resetIntegrationCaches } from '../integrations/reset.js';
import { env, isConfigured } from '../config.js';
import { isGoogleConnected } from '../integrations/google.js';
import { isMsConnected } from '../integrations/onedrive.js';

export const setupRoutes = new Hono();

setupRoutes.get('/setup', async (c) => {
  const base = env().PUBLIC_BASE_URL.replace(/\/$/, '');
  return c.json({
    services: describeCredentials(),
    urls: {
      lineWebhook: `${base}/webhooks/line`,
      chatworkWebhook: `${base}/webhooks/chatwork`,
      googleRedirect: `${base}/api/auth/google/callback`,
      microsoftRedirect: `${base}/api/auth/microsoft/callback`,
    },
    state: {
      anthropic: isConfigured('anthropic'),
      line: isConfigured('line'),
      chatwork: isConfigured('chatwork'),
      google: { configured: isConfigured('google'), connected: isGoogleConnected() },
      microsoft: { configured: isConfigured('microsoft'), connected: await isMsConnected() },
      zoom: isConfigured('zoom'),
    },
  });
});

setupRoutes.put('/setup', async (c) => {
  const body = z.record(z.string(), z.string()).parse(await c.req.json());
  saveCredentials(body);
  resetIntegrationCaches();
  return c.json({ ok: true });
});

setupRoutes.post('/setup/test/:service', async (c) => c.json(await testService(c.req.param('service'))));
