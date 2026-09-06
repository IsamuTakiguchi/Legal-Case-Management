/**
 * 接続直後に自動で行う初期処理。ユーザーの手作業を減らすため、
 * Google 接続後: 送信済みメールの取込 → 文体プロファイル生成 → カレンダー同期 → 期日確認 → Gmail 初回同期
 * Microsoft 接続後: 書式の索引化
 */
import { runJob, JOBS } from '../jobs/index.js';
import { importGmailSent, generateStyleProfile, styleStats } from './style.js';
import { syncCalendar, checkPostEvents } from './court.js';
import { indexForms } from './forms.js';
import { isConfigured } from '../config.js';
import { logger } from '../logger.js';
import { getSyncState, setSyncState } from './settings.js';

const ONCE_KEY = 'onboarding:google';
const ONCE_KEY_MS = 'onboarding:microsoft';

export async function runOnboardingAfterGoogle(): Promise<void> {
  if (getSyncState(ONCE_KEY)) return;
  setSyncState(ONCE_KEY, new Date().toISOString());
  await runJob({
    name: 'onboardingGoogle',
    label: 'Google 接続後の初期処理',
    cron: '',
    enabled: () => true,
    run: async () => {
      const result: Record<string, unknown> = {};
      try {
        result.gmailSent = await importGmailSent({ maxMessages: 300 });
      } catch (err) {
        result.gmailSentError = String(err);
        logger.warn({ err }, '送信済みメールの取込に失敗');
      }
      if (isConfigured('anthropic') && styleStats().total >= 5) {
        // 全体と Gmail 専用の 2 つを作る（LINE・Chatwork はサンプルが溜まった時点で日次ジョブが作る）
        for (const ch of ['all', 'gmail'] as const) {
          try {
            await generateStyleProfile(ch);
            result[`profile_${ch}`] = 'generated';
          } catch (err) {
            result[`profile_${ch}_error`] = String(err);
          }
        }
      }
      try {
        result.calendar = await syncCalendar();
        result.postEvents = checkPostEvents();
      } catch (err) {
        result.calendarError = String(err);
      }
      const gmail = JOBS.find((j) => j.name === 'gmailPoll');
      if (gmail) result.gmailPoll = (await runJob(gmail)).ok;
      return result;
    },
  });
}

export async function runOnboardingAfterMicrosoft(): Promise<void> {
  if (getSyncState(ONCE_KEY_MS)) return;
  setSyncState(ONCE_KEY_MS, new Date().toISOString());
  await runJob({ name: 'onboardingMicrosoft', label: 'OneDrive 接続後の初期処理', cron: '', enabled: () => true, run: () => indexForms() });
}
