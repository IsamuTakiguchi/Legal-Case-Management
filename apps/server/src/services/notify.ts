import { isNull, and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { isConfigured, env } from '../config.js';
import { myChatRoomId, postMessage } from '../channels/chatwork.js';
import { logger } from '../logger.js';
import { markNotified } from './alerts.js';

/** Chatwork マイチャットへ通知。未設定なら何もしない */
export async function notifyMyChat(text: string): Promise<boolean> {
  if (!isConfigured('chatwork')) return false;
  try {
    const roomId = await myChatRoomId();
    if (!roomId) return false;
    await postMessage(roomId, text);
    return true;
  } catch (err) {
    logger.warn({ err }, 'Chatwork 通知に失敗');
    return false;
  }
}

export function appUrl(path: string): string {
  return `${env().PUBLIC_BASE_URL.replace(/\/$/, '')}${path}`;
}

/** 未通知のアラートをまとめて Chatwork に送る */
export async function flushAlertNotifications(): Promise<number> {
  const rows = db()
    .select()
    .from(schema.alerts)
    .where(and(eq(schema.alerts.status, 'open'), isNull(schema.alerts.notifiedAt)))
    .all();
  if (rows.length === 0) return 0;
  const lines = rows.map((r) => `・${r.title}${r.body ? `\n  ${r.body.split('\n')[0]}` : ''}`);
  const text = `[info][title]確認が必要な事項 (${rows.length}件)[/title]${lines.join('\n')}\n\n${appUrl('/alerts')}[/info]`;
  const ok = await notifyMyChat(text);
  markNotified(rows.map((r) => r.id));
  return ok ? rows.length : 0;
}
