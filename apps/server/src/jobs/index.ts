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
import { ignoreOutboundAttachments } from '../services/attachments.js';
import { getSyncState, setSyncState } from '../services/settings.js';
import { indexForms } from '../services/forms.js';
import { casesNeedingSummary, generateCaseSummary } from '../services/cases.js';
import { retryFailedAttachments, requeueStuckAttachments } from '../services/attachments.js';
import { isGoogleConnected } from '../integrations/google.js';
import { getSettingInt } from '../services/settings.js';
import { refreshLineTokenIfNeeded } from '../services/lineSetup.js';
import { runBackup } from '../services/backup.js';
import { resolveAllClientFolders, syncClientFolderNames } from '../services/clientFolders.js';
import { refreshStyleProfiles } from '../services/style.js';
import { runDueScheduled, recoverStuckScheduled } from '../services/scheduledSend.js';
import { refreshUnlinkedAlerts } from '../services/identity.js';
import { repairConversationTimes } from '../services/inbox.js';
import { backfillLineFriends } from '../services/lineFriends.js';

export interface JobDef {
  name: string;
  label: string;
  cron: string;
  run: () => Promise<unknown>;
  enabled: () => boolean;
  /** 毎分など頻繁に動くジョブ: 何もしなかった回は履歴（job_runs）に残さない */
  quiet?: boolean;
}

/** 「何もしなかった」とみなす結果（数値がすべて 0 のオブジェクト） */
function isNoop(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const vals = Object.values(result as Record<string, unknown>);
  return vals.length > 0 && vals.every((v) => v === 0);
}

const running = new Set<string>();

export async function runJob(job: JobDef): Promise<{ ok: boolean; summary?: string; error?: string }> {
  if (running.has(job.name)) return { ok: false, error: '実行中' };
  running.add(job.name);
  const started = new Date().toISOString();
  // quiet なジョブは終わってから（何かしたときだけ）履歴を残す
  const row = job.quiet ? null : db().insert(schema.jobRuns).values({ name: job.name, startedAt: started }).returning().get();
  const finish = (patch: { ok: boolean; summary?: string; error?: string }) => {
    const finishedAt = new Date().toISOString();
    if (row) db().update(schema.jobRuns).set({ finishedAt, ...patch }).where(eq(schema.jobRuns.id, row.id)).run();
    else db().insert(schema.jobRuns).values({ name: job.name, startedAt: started, finishedAt, ...patch }).run();
  };
  try {
    const result = await job.run();
    const summary = typeof result === 'string' ? result : JSON.stringify(result ?? {});
    if (!(job.quiet && isNoop(result))) {
      finish({ ok: true, summary: summary.slice(0, 500) });
      logger.info({ job: job.name, summary: summary.slice(0, 200) }, 'ジョブ完了');
    }
    return { ok: true, summary };
  } catch (err) {
    const msg = String((err as Error)?.stack ?? err).slice(0, 1000);
    finish({ ok: false, error: msg });
    logger.error({ job: job.name, err }, 'ジョブ失敗');
    return { ok: false, error: msg };
  } finally {
    running.delete(job.name);
  }
}

import { eq, lt } from 'drizzle-orm';

export const JOBS: JobDef[] = [
  { name: 'gmailPoll', label: 'Gmail 受信', cron: '*/2 * * * *', run: pollGmail, enabled: () => isGoogleConnected() },
  { name: 'chatworkPoll', label: 'Chatwork 受信（ポーリング）', cron: '*/5 * * * *', run: () => pollChatwork(), enabled: () => isConfigured('chatwork') },
  { name: 'calendarSync', label: 'カレンダー同期', cron: '*/15 * * * *', run: syncCalendar, enabled: () => isGoogleConnected() },
  { name: 'postEventCheck', label: '期日終了後の次回期日確認', cron: '5,20,35,50 * * * *', run: async () => ({ alerts: checkPostEvents() }), enabled: () => true },
  { name: 'waitingCheck', label: '返信待ちの期限確認', cron: '10 * * * *', run: async () => ({ overdue: checkOverdueWaitingTasks(), stale: checkStaleSessions(), creditors: checkCreditorOverdue() }), enabled: () => true },
  { name: 'notifyAlerts', label: 'アラート通知', cron: '15,45 * * * *', run: async () => ({ notified: await flushAlertNotifications() }), enabled: () => isConfigured('chatwork') },
  { name: 'chatworkTasks', label: 'Chatwork タスク同期', cron: '25 * * * *', run: importChatworkTasks, enabled: () => isConfigured('chatwork') },
  { name: 'morningDigest', label: '朝のダイジェスト', cron: `0 ${getSettingInt('morning_digest_hour', 8) - 9 < 0 ? getSettingInt('morning_digest_hour', 8) + 15 : getSettingInt('morning_digest_hour', 8) - 9} * * *`, run: morningDigest, enabled: () => isConfigured('chatwork') },
  { name: 'formsIndex', label: '書式の索引化', cron: '30 17 * * *', run: async () => { const r = await resolveAllClientFolders().catch(() => null); const f = await indexForms(); return { folders: r, forms: f }; }, enabled: () => true },
  { name: 'caseSummary', label: '事件サマリーの週次更新', cron: '0 20 * * 0', run: async () => { let n = 0; for (const c of casesNeedingSummary(7)) { await generateCaseSummary(c.id); n++; } return { updated: n }; }, enabled: () => isConfigured('anthropic') },
  { name: 'styleProfiles', label: '文体プロファイルの自動更新（チャネル別）', cron: '30 19 * * *', run: refreshStyleProfiles, enabled: () => isConfigured('anthropic') },
  { name: 'lineToken', label: 'LINE トークンの自動更新', cron: '15 18 * * *', run: refreshLineTokenIfNeeded, enabled: () => isConfigured('line') },
  { name: 'backup', label: 'バックアップ（OneDrive に世代保存）', cron: '0 18 * * *', run: runBackup, enabled: () => true },
  { name: 'scheduledSend', label: '送信予約の実行（毎分）', cron: '* * * * *', run: () => runDueScheduled(), enabled: () => true, quiet: true },
  { name: 'housekeeping', label: 'ジョブ履歴の整理（60 日より古いものを削除）', cron: '50 16 * * *', run: async () => ({ deleted: pruneJobRuns(60) }), enabled: () => true },
  {
    name: 'clientFolderSync',
    label: 'OneDrive のフォルダ名の変更を取り込む',
    cron: '45 * * * *',
    run: async () => {
      const r = await syncClientFolderNames();
      return { renamed: r.renamed, adopted: r.adopted };
    },
    enabled: () => true,
    quiet: true,
  },
  { name: 'retryAttachments', label: '添付の再取得（失敗・取得中のまま止まったもの）', cron: '40 * * * *', run: async () => ({ requeued: await requeueStuckAttachments(), retried: await retryFailedAttachments() }), enabled: () => true },
];

const scheduled: Cron[] = [];

export function startJobs() {
  // 一度だけの後始末: 以前の版で受信ファイルに入っていた自分の送信添付を外す
  if (!getSyncState('cleanup:outbound_attachments')) {
    setImmediate(() => {
      ignoreOutboundAttachments()
        .then(() => setSyncState('cleanup:outbound_attachments', new Date().toISOString()))
        .catch((err) => logger.warn({ err }, '送信添付の整理に失敗'));
    });
  }
  // 再起動・再デプロイで取得の途中で止まった添付を拾い直す（起動直後は少し待つ）
  setTimeout(() => {
    requeueStuckAttachments(2).catch((err) => logger.warn({ err }, '取得中の添付の再処理に失敗'));
  }, 15_000).unref();
  // 一度だけの後始末: 旧形式の「未紐付けの連絡先」警告に相手・本文の抜粋を入れる
  if (!getSyncState('cleanup:unlinked_alert_preview')) {
    try {
      const n = refreshUnlinkedAlerts();
      setSyncState('cleanup:unlinked_alert_preview', new Date().toISOString());
      if (n) logger.info({ n }, '未紐付けの警告を新しい表示に作り直しました');
    } catch (err) {
      logger.warn({ err }, '未紐付けの警告の作り直しに失敗');
    }
  }
  // 一度だけの後始末: 既存の LINE 会話・依頼者から友だち一覧を作る
  if (!getSyncState('cleanup:line_friends')) {
    try {
      const n = backfillLineFriends();
      setSyncState('cleanup:line_friends', new Date().toISOString());
      if (n) logger.info({ n }, 'LINE の友だち一覧を既存データから作りました');
    } catch (err) {
      logger.warn({ err }, 'LINE の友だち一覧の作成に失敗');
    }
  }
  // 一度だけの後始末: 過去分の取り込みで巻き戻っていた会話の最終日時を直す
  if (!getSyncState('cleanup:conversation_times')) {
    try {
      const n = repairConversationTimes();
      setSyncState('cleanup:conversation_times', new Date().toISOString());
      if (n) logger.info({ n }, '会話の最終日時を計算し直しました');
    } catch (err) {
      logger.warn({ err }, '会話の最終日時の修復に失敗');
    }
  }
  // 再起動で「送信中」のまま止まった送信予約を戻す
  try {
    const n = recoverStuckScheduled();
    if (n) logger.warn({ n }, '送信中のまま止まっていた送信予約を予約中に戻しました');
  } catch (err) {
    logger.warn({ err }, '送信予約の復旧に失敗');
  }
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

/** 古いジョブ履歴を削除する（毎分のジョブが増えても肥大化しないように） */
export function pruneJobRuns(days: number): number {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  return db().delete(schema.jobRuns).where(lt(schema.jobRuns.startedAt, cutoff)).run().changes;
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
