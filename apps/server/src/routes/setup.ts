import { Hono } from 'hono';
import { z } from 'zod';
import { describeCredentials, saveCredentials } from '../services/credentials.js';
import { testService } from '../services/connectionTest.js';
import { resetIntegrationCaches } from '../integrations/reset.js';
import { env, isConfigured } from '../config.js';
import { isGoogleConnected } from '../integrations/google.js';
import { isMsConnected, listChildren, joinPath } from '../integrations/onedrive.js';
import { statusFolderMap, extraClientFolders, guessStatusFolders, saveStatusFolderMap, resolveAllClientFolders } from '../services/clientFolders.js';
import { CASE_STATUSES } from '@lcm/shared';

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
      microsoft: { configured: isConfigured('microsoft'), connected: await isMsConnected(), mode: env().MS_AUTH_MODE },
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

/** 依頼者ルート直下の区分フォルダ（相談／進行事件／残務処理／終了事件）の設定 */
setupRoutes.get('/setup/onedrive/layout', async (c) => {
  if (!(await isMsConnected())) return c.json({ error: 'OneDrive が未接続です' }, 400);
  const root = env().ONEDRIVE_CLIENT_ROOT;
  const items = await listChildren(root).catch(() => []);
  const folders = items
    .filter((i) => i.folder)
    .map((i) => ({ name: i.name, childCount: i.folder?.childCount ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const current = statusFolderMap();
  const guess = guessStatusFolders(folders.map((f) => f.name).filter((n) => !/^_/.test(n)));
  return c.json({ root, folders, current, extras: extraClientFolders(), guess });
});

setupRoutes.put('/setup/onedrive/layout', async (c) => {
  const body = z
    .object({ map: z.record(z.string(), z.string()).default({}), extras: z.array(z.string()).default([]) })
    .parse(await c.req.json());
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(body.map)) if ((CASE_STATUSES as readonly string[]).includes(k) && v.trim()) map[k] = v.trim();
  saveStatusFolderMap(map, body.extras);
  const resolved = await resolveAllClientFolders().catch((err) => ({ scanned: 0, updated: 0, missing: [String(err)] }));
  return c.json({ ok: true, resolved });
});

setupRoutes.post('/setup/onedrive/resolve', async (c) => c.json(await resolveAllClientFolders()));

/** OneDrive のフォルダ一覧（依頼者ルートを画面で選ぶため） */
setupRoutes.get('/setup/onedrive/folders', async (c) => {
  if (!(await isMsConnected())) return c.json({ error: 'OneDrive が未接続です' }, 400);
  const path = (c.req.query('path') || '/').replace(/\/+$/, '') || '/';
  const items = await listChildren(path);
  const folders = items
    .filter((i) => i.folder)
    .map((i) => ({ name: i.name, path: joinPath(path, i.name), childCount: i.folder?.childCount ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return c.json({ path, folders, fileCount: items.length - folders.length });
});
