import { db, schema } from '../db/index.js';
import { eq, inArray, and } from 'drizzle-orm';
import { notifyMyChat, appUrl } from '../services/notify.js';
import { todaysEvents } from '../services/court.js';
import { openAlerts } from '../services/alerts.js';
import { formatJaDateTime, TASK_STATUS_LABEL, type TaskStatus, EVENT_KIND_LABEL, type EventKind } from '@lcm/shared';
import { getSetting, getSettingInt } from '../services/settings.js';

/** 毎朝のダイジェストを Chatwork マイチャットへ */
export async function morningDigest(): Promise<string> {
  const d = db();
  const waiting = d
    .select({ t: schema.tasks, clientName: schema.clients.name })
    .from(schema.tasks)
    .leftJoin(schema.clients, eq(schema.clients.id, schema.tasks.clientId))
    .where(inArray(schema.tasks.status, ['waiting_client', 'waiting_other']))
    .all();
  const openTasks = d
    .select({ t: schema.tasks, clientName: schema.clients.name })
    .from(schema.tasks)
    .leftJoin(schema.clients, eq(schema.clients.id, schema.tasks.clientId))
    .where(and(eq(schema.tasks.status, 'open')))
    .all()
    .filter((r) => r.t.dueAt && r.t.dueAt <= new Date(Date.now() + 86400_000).toISOString());
  const events = todaysEvents();
  const needsReply = d.select().from(schema.conversations).where(and(eq(schema.conversations.needsReply, true), eq(schema.conversations.archived, false))).all();
  const alerts = openAlerts();
  const byType: Record<string, number> = {};
  for (const a of alerts) byType[a.type] = (byType[a.type] ?? 0) + 1;

  const sections: string[] = [];
  sections.push(`■ 今日の予定 (${events.length})`);
  for (const e of events) sections.push(`  ${formatJaDateTime(new Date(e.startAt), { withWeekday: false })} ${e.title}${e.kind !== 'other' ? `〔${EVENT_KIND_LABEL[e.kind as EventKind]}〕` : ''}`);
  sections.push(`■ 未返信の会話: ${needsReply.length} 件`);
  sections.push(`■ 返信待ち (${waiting.length})`);
  const now = Date.now();
  const maxItems = Math.max(1, getSettingInt('digest_max_items', 15));
  for (const r of waiting.slice(0, maxItems)) {
    const over = r.t.followUpAt && new Date(r.t.followUpAt).getTime() < now ? '【期限超過】' : '';
    sections.push(`  ${over}${r.clientName ? `${r.clientName} / ` : ''}${r.t.title}（${TASK_STATUS_LABEL[r.t.status as TaskStatus]}）`);
  }
  if (openTasks.length) {
    sections.push(`■ 期限が今日までのタスク (${openTasks.length})`);
    for (const r of openTasks.slice(0, 10)) sections.push(`  ${r.clientName ? `${r.clientName} / ` : ''}${r.t.title}`);
  }
  const alertLines = Object.entries(byType).map(([k, v]) => `  ${labelAlert(k)}: ${v} 件`);
  if (alertLines.length) sections.push(`■ 要確認`, ...alertLines);
  const footer = getSetting('digest_footer').trim();
  if (footer) sections.push('', footer);
  sections.push('', appUrl('/'));
  const text = `[info][title]${getSetting('digest_title') || '本日のまとめ'}[/title]${sections.join('\n')}[/info]`;
  await notifyMyChat(text);
  return text;
}

function labelAlert(type: string): string {
  const map: Record<string, string> = {
    waiting_overdue: '返信待ちの期限超過',
    next_hearing_missing: '次回期日の未入力',
    unassigned_file: '振り分け待ちファイル',
    unlinked_contact: '未紐付けの連絡先',
    reply_received: '返信あり',
    scheduling_stale: '日程調整の停滞',
    line_quota: 'LINE 通数',
    creditor_overdue: '債権者対応の期限超過',
  };
  return map[type] ?? type;
}
