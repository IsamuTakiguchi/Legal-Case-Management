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
        try {
          await generateStyleProfile('all');
          result.profile = 'generated';
        } catch (err) {
          result.profileError = String(err);
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
