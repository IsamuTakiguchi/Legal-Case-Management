import { Hono } from 'hono';
import { z } from 'zod';
import { allSettings, setSetting, SETTING_DEFAULTS, getSyncState } from '../services/settings.js';
import { listTemplates, saveTemplates } from '../services/templates.js';
import { isConfigured, env } from '../config.js';
import { isGoogleConnected, googleAccount } from '../integrations/google.js';
import { isMsConnected, msAccount } from '../integrations/onedrive.js';
import { lineQuotaStatus } from '../services/lineQuota.js';
import { JOBS, runJob, jobStatus } from '../jobs/index.js';
import { generateStyleProfile, getStyleProfile, saveStyleProfile, importGmailSent, importChatworkMine, importPlainText, styleStats } from '../services/style.js';
import { storage } from '../integrations/storage.js';
import { channelSchema } from '@lcm/shared';
import { openAlerts } from '../services/alerts.js';
import { listTasks } from '../services/tasks.js';
import { todaysEvents } from '../services/court.js';
import { db, schema } from '../db/index.js';
import { and, eq } from 'drizzle-orm';
import { runBackup, listLocalBackups, localBackupPath, remoteBackupFolder } from '../services/backup.js';
import { seedDemoData, clearDemoData, demoStatus } from '../services/demo.js';
import fs from 'node:fs';
import { recategorizeConversations } from '../channels/gmail.js';
import { logger } from '../logger.js';

export const settingsRoutes = new Hono();

const EDITABLE = Object.keys(SETTING_DEFAULTS).concat(['access_note', 'templates_json']);

settingsRoutes.get('/settings', (c) => {
  const s = allSettings();
  delete s.password_hash;
  delete s.templates_json;
  delete s.demo_ids;
  for (const k of Object.keys(s)) if (k.startsWith('cred:') || k.startsWith('line_auto_token') || k.startsWith('ms_')) delete s[k];
  return c.json(s);
});

settingsRoutes.put('/settings', async (c) => {
  const body = z.record(z.string(), z.string()).parse(await c.req.json());
  const before = allSettings();
  for (const [k, v] of Object.entries(body)) {
    if (!EDITABLE.includes(k)) continue;
    setSetting(k, v);
  }
  // 「メインだけ」に切り替えたら、区分の無い取込済み会話を裏で判定し直す
  if (body.gmail_categories === 'primary' && before.gmail_categories !== 'primary') {
    setImmediate(() => recategorizeConversations().catch((err) => logger.warn({ err }, 'Gmail 会話の再判定に失敗')));
  }
  return c.json({ ok: true });
});

/** 取込済みの Gmail 会話の区分（メイン／プロモーション等）を判定し直す */
settingsRoutes.post('/gmail/recategorize', async (c) => c.json(await recategorizeConversations({ all: c.req.query('all') === '1' })));

settingsRoutes.get('/settings/templates', (c) => c.json(listTemplates()));
settingsRoutes.put('/settings/templates', async (c) => {
  const body = z.array(z.object({ key: z.string(), label: z.string(), when: z.string().default(''), body: z.string() })).parse(await c.req.json());
  saveTemplates(body);
  return c.json({ ok: true });
});

/** 接続状況 */
settingsRoutes.get('/status', async (c) => {
  const e = env();
  return c.json({
    publicBaseUrl: e.PUBLIC_BASE_URL,
    storage: storage().kind,
    line: {
      configured: isConfigured('line'),
      webhookUrl: `${e.PUBLIC_BASE_URL}/webhooks/line`,
      quota: isConfigured('line') ? lineQuotaStatus() : null,
      lastWebhookAt: getSyncState('line_last_webhook_at'),
      lastEventAt: getSyncState('line_last_event_at'),
      lastError: getSyncState('line_last_webhook_error'),
    },
    chatwork: { configured: isConfigured('chatwork'), webhookUrl: `${e.PUBLIC_BASE_URL}/webhooks/chatwork`, webhookTokenSet: !!e.CHATWORK_WEBHOOK_TOKEN },
    google: { configured: isConfigured('google'), connected: isGoogleConnected(), account: googleAccount(), redirectUri: `${e.PUBLIC_BASE_URL}/api/auth/google/callback` },
    microsoft: { configured: isConfigured('microsoft'), connected: await isMsConnected(), account: msAccount(), redirectUri: `${e.PUBLIC_BASE_URL}/api/auth/microsoft/callback` },
    zoom: { configured: isConfigured('zoom') },
    anthropic: { configured: isConfigured('anthropic'), model: e.ANTHROPIC_MODEL },
    jobs: jobStatus(),
    demo: demoStatus(),
  });
});

// ---- バックアップ ----
settingsRoutes.get('/backup', (c) => c.json({ local: listLocalBackups(), remoteFolder: remoteBackupFolder() }));
settingsRoutes.post('/backup/run', async (c) => c.json(await runBackup()));
settingsRoutes.get('/backup/:name', (c) => {
  const p = localBackupPath(c.req.param('name'));
  if (!p) return c.json({ error: 'not found' }, 404);
  c.header('Content-Type', 'application/gzip');
  c.header('Content-Disposition', `attachment; filename="${c.req.param('name')}"`);
  return c.body(new Uint8Array(fs.readFileSync(p)));
});

// ---- デモデータ ----
settingsRoutes.post('/demo/seed', (c) => {
  const ids = seedDemoData();
  return c.json({ ok: true, clients: ids.clients.length, cases: ids.cases.length, messages: ids.messages.length });
});
settingsRoutes.post('/demo/clear', (c) => c.json({ ok: true, deleted: clearDemoData() }));

settingsRoutes.post('/jobs/:name/run', async (c) => {
  const job = JOBS.find((j) => j.name === c.req.param('name'));
  if (!job) return c.json({ error: 'not found' }, 404);
  return c.json(await runJob(job));
});

// ---- 文体 ----
settingsRoutes.get('/style', (c) => c.json({ stats: styleStats(), profiles: { all: getStyleProfile('all'), gmail: getStyleProfile('gmail'), chatwork: getStyleProfile('chatwork'), line: getStyleProfile('line') } }));

settingsRoutes.post('/style/profile', async (c) => {
  const body = z.object({ channel: z.enum(['all', 'gmail', 'chatwork', 'line']).default('all') }).parse(await c.req.json().catch(() => ({})));
  return c.json({ profile: await generateStyleProfile(body.channel) });
});

settingsRoutes.put('/style/profile', async (c) => {
  const body = z.object({ channel: z.enum(['all', 'gmail', 'chatwork', 'line']).default('all'), markdown: z.string() }).parse(await c.req.json());
  saveStyleProfile(body.channel, body.markdown);
  return c.json({ ok: true });
});

settingsRoutes.post('/style/import/gmail', async (c) => {
  const body = z.object({ maxMessages: z.number().int().default(300), newerThanDays: z.number().int().default(730) }).parse(await c.req.json().catch(() => ({})));
  return c.json({ imported: await importGmailSent(body) });
});

settingsRoutes.post('/style/import/chatwork', async (c) => c.json({ imported: await importChatworkMine() }));

settingsRoutes.post('/style/import/text', async (c) => {
  const body = z.object({ channel: channelSchema, text: z.string().min(1) }).parse(await c.req.json());
  return c.json({ imported: importPlainText(body.channel, body.text) });
});

/** ダッシュボード用まとめ */
settingsRoutes.get('/dashboard', (c) => {
  const alerts = openAlerts();
  const byType: Record<string, number> = {};
  for (const a of alerts) byType[a.type] = (byType[a.type] ?? 0) + 1;
  const waiting = listTasks({ status: 'active' }).filter((t) => t.status !== 'open');
  const needsReply = db().select({ id: schema.conversations.id }).from(schema.conversations).where(and(eq(schema.conversations.needsReply, true), eq(schema.conversations.archived, false))).all().length;
  return c.json({ alerts: alerts.slice(0, 20), alertCounts: byType, waiting, needsReply, todaysEvents: todaysEvents(), lineQuota: isConfigured('line') ? lineQuotaStatus() : null, demo: demoStatus().seeded });
});
