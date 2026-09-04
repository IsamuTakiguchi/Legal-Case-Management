import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { logger as honoLogger } from 'hono/logger';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, ensureDataDirSafe } from './config.js';
import { openDatabase } from './db/index.js';
import { logger } from './logger.js';
import { ensurePasswordHash, requireAuth } from './auth/index.js';
import { authRoutes } from './routes/auth.js';
import { webhookRoutes } from './routes/webhooks.js';
import { inboxRoutes } from './routes/inbox.js';
import { clientRoutes } from './routes/clients.js';
import { taskRoutes } from './routes/tasks.js';
import { schedulingRoutes } from './routes/scheduling.js';
import { fileRoutes } from './routes/files.js';
import { settingsRoutes } from './routes/settings.js';
import { setupRoutes } from './routes/setup.js';
import { applyCredentialOverrides } from './services/credentials.js';
import { startJobs } from './jobs/index.js';
import { ZodError } from 'zod';

export function createApp() {
  const app = new Hono();
  app.use('*', honoLogger((msg) => logger.debug(msg)));

  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ error: '入力が不正です', issues: err.issues }, 400);
    logger.error({ err, path: c.req.path }, 'リクエスト処理でエラー');
    return c.json({ error: (err as Error).message ?? String(err) }, 500);
  });

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.route('/webhooks', webhookRoutes);
  app.route('/api/auth', authRoutes);

  const api = new Hono();
  api.use('*', requireAuth);
  api.route('/', inboxRoutes);
  api.route('/', clientRoutes);
  api.route('/', taskRoutes);
  api.route('/', schedulingRoutes);
  api.route('/', fileRoutes);
  api.route('/', settingsRoutes);
  api.route('/', setupRoutes);
  app.route('/api', api);

  // 静的ファイル（ビルド済み web）＋ SPA フォールバック
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = [path.resolve(here, '../../web/dist'), path.resolve(here, '../../../web/dist')].find((p) => fs.existsSync(p));
  if (webDist) {
    const rel = path.relative(process.cwd(), webDist);
    app.use('/*', serveStatic({ root: rel }));
    app.get('*', (c) => {
      if (c.req.path.startsWith('/api') || c.req.path.startsWith('/webhooks')) return c.json({ error: 'not found' }, 404);
      return c.html(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8'));
    });
  }
  return app;
}

async function main() {
  const e = env();
  ensureDataDirSafe();
  openDatabase();
  applyCredentialOverrides();
  ensurePasswordHash();
  const app = createApp();
  serve({ fetch: app.fetch, port: e.PORT, hostname: '0.0.0.0' }, (info) => {
    logger.info({ port: info.port, publicBaseUrl: e.PUBLIC_BASE_URL }, 'サーバーを起動しました');
  });
  startJobs();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    logger.fatal({ err }, '起動に失敗');
    process.exit(1);
  });
}
