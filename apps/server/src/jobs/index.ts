import { Cron } from 'croner';
import { db, schema } from '../db/index.js';
import { logger } from '../logger.js';
import { env, isConfigured } from '../config.js';
import { pollGmail } from './gmailPoll.js';
import { pollChatwork } from './chatworkPoll.js';
import { morningDigest } from './digest.js';
import { syncCalendar, checkPostEvents } from '../services/court.js';
import { checkOverdueWaitingTasks, importChatworkTasks } from '../services/tasks.js';
import { checkStaleSessions } from '../services/scheduling.js';
import { checkCreditorOverdue } from '../services/creditors.js';
import { flushAlertNotifications } from '../services/notify.js';
import { indexForms } from '../services/forms.js';
import { casesNeedingSummary, generateCaseSummary } from '../services/cases.js';
import { retryFailedAttachments } from '../services/attachments.js';
import { isGoogleConnected } from '../integrations/google.js';
import { getSettingInt } from '../services/settings.js';
import { refreshLineTokenIfNeeded } from '../services/lineSetup.js';

export interface JobDef {
  name: string;
  label: string;
  cron: string;
  run: () => Promise<unknown>;
  enabled: () => boolean;
}

const running = new Set<string>();

export async function runJob(job: JobDef): Promise<{ ok: boolean; summary?: string; error?: string }> {
  if (running.has(job.name)) return { ok: false, error: '実行中' };
  running.add(job.name);
  const started = new Date().toISOString();
  const row = db().insert(schema.jobRuns).values({ name: job.name, startedAt: started }).returning().get();
  try {
    const result = await job.run();
    const summary = typeof result === 'string' ? result : JSON.stringify(result ?? {});
    db().update(schema.jobRuns).set({ finishedAt: new Date().toISOString(), ok: true, summary: summary.slice(0, 500) }).where(eq(schema.jobRuns.id, row.id)).run();
    logger.info({ job: job.name, summary: summary.slice(0, 200) }, 'ジョブ完了');
    return { ok: true, summary };
  } catch (err) {
    const msg = String((err as Error)?.stack ?? err).slice(0, 1000);
    db().update(schema.jobRuns).set({ finishedAt: new Date().toISOString(), ok: false, error: msg }).where(eq(schema.jobRuns.id, row.id)).run();
    logger.error({ job: job.name, err }, 'ジョブ失敗');
    return { ok: false, error: msg };
  } finally {
    running.delete(job.name);
  }
}

import { eq } from 'drizzle-orm';

export const JOBS: JobDef[] = [
  { name: 'gmailPoll', label: 'Gmail 受信', cron: '*/2 * * * *', run: pollGmail, enabled: () => isGoogleConnected() },
  { name: 'chatworkPoll', label: 'Chatwork 受信（ポーリング）', cron: '*/5 * * * *', run: () => pollChatwork(), enabled: () => isConfigured('chatwork') },
  { name: 'calendarSync', label: 'カレンダー同期', cron: '*/15 * * * *', run: syncCalendar, enabled: () => isGoogleConnected() },
  { name: 'postEventCheck', label: '期日終了後の次回期日確認', cron: '5,20,35,50 * * * *', run: async () => ({ alerts: checkPostEvents() }), enabled: () => true },
  { name: 'waitingCheck', label: '返信待ちの期限確認', cron: '10 * * * *', run: async () => ({ overdue: checkOverdueWaitingTasks(), stale: checkStaleSessions(), creditors: checkCreditorOverdue() }), enabled: () => true },
  { name: 'notifyAlerts', label: 'アラート通知', cron: '15,45 * * * *', run: async () => ({ notified: await flushAlertNotifications() }), enabled: () => isConfigured('chatwork') },
  { name: 'chatworkTasks', label: 'Chatwork タスク同期', cron: '25 * * * *', run: importChatworkTasks, enabled: () => isConfigured('chatwork') },
  { name: 'morningDigest', label: '朝のダイジェスト', cron: `0 ${getSettingInt('morning_digest_hour', 8) - 9 < 0 ? getSettingInt('morning_digest_hour', 8) + 15 : getSettingInt('morning_digest_hour', 8) - 9} * * *`, run: morningDigest, enabled: () => isConfigured('chatwork') },
  { name: 'formsIndex', label: '書式の索引化', cron: '30 17 * * *', run: () => indexForms(), enabled: () => true },
  { name: 'caseSummary', label: '事件サマリーの週次更新', cron: '0 20 * * 0', run: async () => { let n = 0; for (const c of casesNeedingSummary(7)) { await generateCaseSummary(c.id); n++; } return { updated: n }; }, enabled: () => isConfigured('anthropic') },
  { name: 'lineToken', label: 'LINE トークンの自動更新', cron: '15 18 * * *', run: refreshLineTokenIfNeeded, enabled: () => isConfigured('line') },
  { name: 'retryAttachments', label: '添付の再取得', cron: '40 */3 * * *', run: async () => ({ retried: await retryFailedAttachments() }), enabled: () => true },
];

const scheduled: Cron[] = [];

export function startJobs() {
  if (!env().JOBS_ENABLED) {
    logger.warn('JOBS_ENABLED=false のためジョブは起動しません');
    return;
  }
  for (const job of JOBS) {
    // cron はコンテナの TZ（UTC 想定）で評価。朝ダイジェストのみ JST→UTC 変換済み
    const c = new Cron(job.cron, { timezone: 'UTC', protect: true }, async () => {
      if (!job.enabled()) return;
      await runJob(job);
    });
    scheduled.push(c);
  }
  logger.info({ jobs: JOBS.map((j) => j.name) }, 'ジョブを起動しました');
}

export function stopJobs() {
  for (const c of scheduled) c.stop();
  scheduled.length = 0;
}

export function jobStatus() {
  return JOBS.map((j) => {
    const last = db().select().from(schema.jobRuns).where(eq(schema.jobRuns.name, j.name)).orderBy(desc(schema.jobRuns.startedAt)).limit(1).get();
    return { name: j.name, label: j.label, cron: j.cron, enabled: j.enabled(), running: running.has(j.name), last: last ?? null };
  });
}

import { desc } from 'drizzle-orm';
