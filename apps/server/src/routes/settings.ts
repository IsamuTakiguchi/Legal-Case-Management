import { Hono } from 'hono';
import { recheckChatworkScope } from '../services/chatworkRecheck.js';
import { z } from 'zod';
import { allSettings, setSetting, getSetting, SETTING_DEFAULTS, getSyncState } from '../services/settings.js';
import { listTemplates, saveTemplates } from '../services/templates.js';
import { isConfigured, env } from '../config.js';
import { isGoogleConnected, googleAccount } from '../integrations/google.js';
import { isMsConnected, msAccount } from '../integrations/onedrive.js';
import { recentActivity } from '../services/activity.js';
import { lineQuotaStatus } from '../services/lineQuota.js';
import { JOBS, runJob, jobStatus } from '../jobs/index.js';
import { usageSummary } from '../services/apiCost.js';
import { myAddresses, configuredMyAddresses } from '../jobs/gmailPoll.js';
import { refixOwnMessages, inboxCounts } from '../services/inbox.js';
import { generateStyleProfile, getStyleProfile, saveStyleProfile, importGmailSent, importChatworkMine, importPlainText, styleStats } from '../services/style.js';
import { storage } from '../integrations/storage.js';
import { channelSchema, countTasks } from '@lcm/shared';
import { model as aiModel } from '../integrations/anthropic.js';
import { openAlerts } from '../services/alerts.js';
import { listTasks } from '../services/tasks.js';
import { todaysEvents } from '../services/court.js';
import { db, schema } from '../db/index.js';
import { and, eq, gt } from 'drizzle-orm';
import { runBackup, listLocalBackups, localBackupPath, remoteBackupFolder, lastBackupInfo, restoreBackup, restoreLocalBackup } from '../services/backup.js';
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
  // 自分のアドレスを追加したら、そのアドレスからの「受信」を送信に直す
  if (body.my_email_addresses !== undefined && body.my_email_addresses !== before.my_email_addresses) {
    setImmediate(() => refixOwnMessagesNow().catch((err) => logger.warn({ err }, '自分の送信の判定し直しに失敗')));
  }
  // 「メインだけ」に切り替えたら、区分の無い取込済み会話を裏で判定し直す
  if (body.gmail_categories === 'primary' && before.gmail_categories !== 'primary') {
    setImmediate(() => recategorizeConversations().catch((err) => logger.warn({ err }, 'Gmail 会話の再判定に失敗')));
  }
  // Chatwork を「自分宛だけ」に切り替えたら、取込済みの分にも当て直す
  // （これが無いと、範囲外のやり取りが受信箱と要確認に残り続ける）
  if (body.chatwork_scope === 'to_me' && before.chatwork_scope !== 'to_me') {
    setImmediate(() => recheckChatworkScope({ apply: true }).catch((err) => logger.warn({ err }, 'Chatwork の取込範囲の当て直しに失敗')));
  }
  return c.json({ ok: true });
});

/** 自分のアドレスから送った控えが受信になっているものを送信に直す */
async function refixOwnMessagesNow() {
  const addrs = isGoogleConnected() ? await myAddresses({ refresh: true }) : configuredMyAddresses();
  return refixOwnMessages(addrs);
}
settingsRoutes.post('/gmail/refix-own', async (c) => c.json(await refixOwnMessagesNow()));

/** いま「自分の送信」とみなしているメールアドレス（Gmail のプロフィール・別名・設定で足したもの） */
settingsRoutes.get('/gmail/my-addresses', async (c) => {
  const configured = configuredMyAddresses();
  if (!isGoogleConnected()) return c.json({ addresses: configured, googleConnected: false });
  try {
    return c.json({ addresses: await myAddresses(), googleConnected: true });
  } catch {
    return c.json({ addresses: configured, googleConnected: true });
  }
});

/**
 * 取込済みの Chatwork に、いまの取込範囲を当て直す。
 * ?apply=1 で実際に片付ける（付けなければ件数を数えるだけ）
 */
settingsRoutes.post('/chatwork/recheck-scope', async (c) => c.json(await recheckChatworkScope({ apply: c.req.query('apply') === '1' })));

/** 取込済みの Gmail 会話の区分（メイン／プロモーション等）を判定し直す */
settingsRoutes.post('/gmail/recategorize', async (c) => c.json(await recategorizeConversations({ all: c.req.query('all') === '1' })));

settingsRoutes.get('/settings/templates', (c) => c.json(listTemplates()));
settingsRoutes.put('/settings/templates', async (c) => {
  const body = z.array(z.object({ key: z.string(), label: z.string(), when: z.string().default(''), body: z.string() })).parse(await c.req.json());
  saveTemplates(body);
  return c.json({ ok: true });
});

/** 接続状況 */
const STARTED_AT = new Date().toISOString();

/**
 * 直近 N 時間に取り込んだ Chatwork の受信を、取り込んだ理由ごとに数える。
 * 「自分宛だけ」なのに理由の無いものが増えていれば、どこかで判定を通さずに入っている
 */
function chatworkRecentByReason(hours: number): { total: number; byReason: Record<string, number> } {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = db()
    .select({ raw: schema.messages.raw, createdAt: schema.messages.createdAt })
    .from(schema.messages)
    .where(and(eq(schema.messages.channel, 'chatwork'), eq(schema.messages.direction, 'in'), gt(schema.messages.createdAt, since)))
    .all();
  const byReason: Record<string, number> = {};
  for (const r of rows) {
    const reason = (r.raw as { scopeReason?: string } | null)?.scopeReason ?? 'none';
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  return { total: rows.length, byReason };
}

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
    chatwork: {
      configured: isConfigured('chatwork'),
      webhookUrl: `${e.PUBLIC_BASE_URL}/webhooks/chatwork`,
      webhookTokenSet: !!e.CHATWORK_WEBHOOK_TOKEN,
      // 取込範囲を、サーバーが実際に見ている値で返す（画面の設定と食い違っていないかの確認用）
      scope: getSetting('chatwork_scope') === 'to_me' ? 'to_me' : 'all',
      lastWebhookAt: getSyncState('chatwork_last_webhook_at'),
      lastPollAt: getSyncState('chatwork_last_poll_at'),
      recent: chatworkRecentByReason(24),
    },
    // 動いている版。Railway が起動時に入れる値。手元の main と見比べて、デプロイが反映されているかを確かめる
    version: { commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? null, message: process.env.RAILWAY_GIT_COMMIT_MESSAGE ?? null, startedAt: STARTED_AT },
    google: { configured: isConfigured('google'), connected: isGoogleConnected(), account: googleAccount(), redirectUri: `${e.PUBLIC_BASE_URL}/api/auth/google/callback` },
    microsoft: { configured: isConfigured('microsoft'), connected: await isMsConnected(), account: msAccount(), redirectUri: `${e.PUBLIC_BASE_URL}/api/auth/microsoft/callback` },
    zoom: { configured: isConfigured('zoom') },
    anthropic: { configured: isConfigured('anthropic'), model: aiModel('main'), modelLight: aiModel('light') },
    jobs: jobStatus(),
    demo: demoStatus(),
  });
});

// ---- バックアップ ----
settingsRoutes.get('/backup', (c) => c.json({ local: listLocalBackups(), remoteFolder: remoteBackupFolder(), last: lastBackupInfo() }));
settingsRoutes.post('/backup/run', async (c) => c.json(await runBackup()));
/** アップロードしたバックアップ（.db.gz / .db）から復元 */
settingsRoutes.post('/backup/restore', async (c) => {
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) return c.json({ error: 'ファイルを指定してください' }, 400);
  const data = Buffer.from(await file.arrayBuffer());
  return c.json(await restoreBackup(data, file.name));
});
/** サーバー内の世代から復元 */
settingsRoutes.post('/backup/restore/:name', async (c) => c.json(await restoreLocalBackup(c.req.param('name'))));

/** 受信をいま取り込み直す（Gmail・Chatwork のポーリングを即時実行。8 秒で打ち切って応答） */
settingsRoutes.post('/sync/now', async (c) => {
  const targets = JOBS.filter((j) => (j.name === 'gmailPoll' || j.name === 'chatworkPoll') && j.enabled());
  const runs = targets.map((j) => runJob(j).then((r) => ({ name: j.name, ...r })));
  const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 8000));
  const result = await Promise.race([Promise.all(runs), timeout]);
  if (result === 'timeout') return c.json({ started: targets.map((j) => j.name), done: false });
  return c.json({ started: targets.map((j) => j.name), done: true, results: result });
});
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
  const active = listTasks({ status: 'active' });
  const activeTasks = active.length;
  const openTasks = active.filter((t) => t.status === 'open').length;
  // 対応中と連絡待ちを分けて、期限切れも数える
  const taskCounts = countTasks(active);
  return c.json({
    alerts: alerts.slice(0, 20),
    alertCounts: byType,
    waiting,
    needsReply,
    activeTasks,
    openTasks,
    taskCounts,
    todaysEvents: todaysEvents(),
    recent: recentActivity(12),
    lineQuota: isConfigured('line') ? lineQuotaStatus() : null,
    demo: demoStatus().seeded,
  });
});

/** API 利用料（概算）。month=YYYY-MM で月を指定 */
settingsRoutes.get('/api-usage', (c) => {
  const month = c.req.query('month');
  return c.json(usageSummary(month && /^\d{4}-\d{2}$/.test(month) ? month : undefined));
});

/** メニューに出す件数（受信箱の要返信・未完了タスク・要確認）。軽いので 1 分ごとに取得する */
settingsRoutes.get('/nav-counts', (c) => c.json(navCounts()));

export function navCounts(): { inbox: number; unread: number; tasks: number; alerts: number } {
  // 未返信・未読は受信箱と同じ見え方で数える（inboxCounts）
  const { inbox, unread } = inboxCounts();
  const tasks = listTasks({ status: 'active' }).length;
  const alerts = openAlerts().length;
  return { inbox, unread, tasks, alerts };
}
