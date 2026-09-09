import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { sendToConversation, type SendOutcome } from './send.js';
import { upsertAlert } from './alerts.js';
import { logger } from '../logger.js';
import type { SendMessageInput } from '@lcm/shared';

/** 予約の失敗をあきらめるまでの試行回数（ネットワークの一時的な不調は次の分で再試行する） */
const MAX_ATTEMPTS = 3;
/** 予約時刻からこれ以上遅れたものは、送らずに失敗にする（再起動などで長く止まっていた場合の誤送信防止） */
const STALE_AFTER_MS = 6 * 3600_000;

export interface ScheduledMessageRow {
  id: number;
  conversationId: number;
  text: string;
  scheduledAt: string;
  status: string;
  attempts: number;
  error: string | null;
  sentMessageId: number | null;
  sentAt: string | null;
  createdAt: string;
}

function toRow(r: typeof schema.scheduledMessages.$inferSelect): ScheduledMessageRow {
  return {
    id: r.id,
    conversationId: r.conversationId,
    text: r.text,
    scheduledAt: r.scheduledAt,
    status: r.status,
    attempts: r.attempts,
    error: r.error,
    sentMessageId: r.sentMessageId,
    sentAt: r.sentAt,
    createdAt: r.createdAt,
  };
}

function assertFuture(iso: string) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new Error('送信予定時刻の形式が正しくありません');
  if (t < Date.now() - 60_000) throw new Error('送信予定時刻が過去です');
  return new Date(t).toISOString();
}

/** 送信内容を保存し、時刻が来るまで待つ */
export function scheduleMessage(conversationId: number, input: SendMessageInput, scheduledAt: string): ScheduledMessageRow {
  const d = db();
  const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get();
  if (!conv) throw new Error('会話が見つかりません');
  const at = assertFuture(scheduledAt);
  const { scheduledAt: _omit, ...payload } = input;
  const row = d
    .insert(schema.scheduledMessages)
    .values({ conversationId, payload, text: input.text, scheduledAt: at })
    .returning()
    .get();
  logger.info({ id: row.id, conversationId, scheduledAt: at }, '送信を予約しました');
  return toRow(row);
}

export function listScheduled(opts: { conversationId?: number; includeDone?: boolean } = {}): (ScheduledMessageRow & { conversation: { id: number; channel: string; subject: string | null; counterpartName: string | null; clientName: string | null } })[] {
  const d = db();
  const conds = [];
  if (opts.conversationId) conds.push(eq(schema.scheduledMessages.conversationId, opts.conversationId));
  if (!opts.includeDone) conds.push(inArray(schema.scheduledMessages.status, ['pending', 'sending', 'failed']));
  const rows = d
    .select()
    .from(schema.scheduledMessages)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(schema.scheduledMessages.scheduledAt))
    .all();
  const convIds = [...new Set(rows.map((r) => r.conversationId))];
  const convs = convIds.length ? d.select().from(schema.conversations).where(inArray(schema.conversations.id, convIds)).all() : [];
  const clientIds = [...new Set(convs.map((c) => c.clientId).filter((x): x is number => !!x))];
  const clients = clientIds.length ? d.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(inArray(schema.clients.id, clientIds)).all() : [];
  return rows.map((r) => {
    const c = convs.find((x) => x.id === r.conversationId);
    return {
      ...toRow(r),
      conversation: {
        id: r.conversationId,
        channel: c?.channel ?? '',
        subject: c?.subject ?? null,
        counterpartName: c?.counterpartName ?? null,
        clientName: c?.clientId ? (clients.find((x) => x.id === c.clientId)?.name ?? null) : null,
      },
    };
  });
}

export function getScheduled(id: number): ScheduledMessageRow | null {
  const r = db().select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.id, id)).get();
  return r ? toRow(r) : null;
}

/** 予約の時刻・本文を変える（まだ送っていないものだけ） */
export function updateScheduled(id: number, patch: { scheduledAt?: string; text?: string }): ScheduledMessageRow {
  const d = db();
  const r = d.select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.id, id)).get();
  if (!r) throw new Error('送信予約が見つかりません');
  if (r.status !== 'pending' && r.status !== 'failed') throw new Error('この予約はもう変更できません');
  const set: Partial<typeof schema.scheduledMessages.$inferInsert> = { updatedAt: new Date().toISOString(), status: 'pending', error: null, attempts: 0 };
  if (patch.scheduledAt) set.scheduledAt = assertFuture(patch.scheduledAt);
  if (patch.text !== undefined) {
    if (!patch.text.trim()) throw new Error('本文が空です');
    set.text = patch.text;
    set.payload = { ...(r.payload as Record<string, unknown>), text: patch.text };
  }
  return toRow(d.update(schema.scheduledMessages).set(set).where(eq(schema.scheduledMessages.id, id)).returning().get());
}

export function cancelScheduled(id: number): ScheduledMessageRow {
  const d = db();
  const r = d.select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.id, id)).get();
  if (!r) throw new Error('送信予約が見つかりません');
  if (r.status === 'sent') throw new Error('送信済みのため取り消せません');
  if (r.status === 'sending') throw new Error('送信中のため取り消せません');
  return toRow(d.update(schema.scheduledMessages).set({ status: 'cancelled', updatedAt: new Date().toISOString() }).where(eq(schema.scheduledMessages.id, id)).returning().get());
}

/**
 * 1 件を実際に送る。sending への更新を「pending/failed のときだけ」行うことで、
 * ジョブと「今すぐ送る」が同時に走っても二重送信にならないようにする
 */
export async function dispatchScheduled(id: number, opts: { force?: boolean } = {}): Promise<{ ok: true; outcome: SendOutcome } | { ok: false; error: string; givenUp: boolean }> {
  const d = db();
  const claimed = d
    .update(schema.scheduledMessages)
    .set({ status: 'sending', updatedAt: new Date().toISOString() })
    .where(and(eq(schema.scheduledMessages.id, id), inArray(schema.scheduledMessages.status, ['pending', 'failed'])))
    .returning()
    .get();
  if (!claimed) return { ok: false, error: 'この予約は送信中か、すでに処理済みです', givenUp: true };
  const attempts = claimed.attempts + 1;
  try {
    if (!opts.force && Date.now() - Date.parse(claimed.scheduledAt) > STALE_AFTER_MS) {
      throw new Error('予定時刻から 6 時間以上経過していたため送信を止めました。内容を確認して「今すぐ送る」か取り消してください');
    }
    const input = { ...(claimed.payload as SendMessageInput), text: claimed.text, scheduledAt: null };
    const outcome = await sendToConversation(claimed.conversationId, input);
    d.update(schema.scheduledMessages)
      .set({ status: 'sent', attempts, sentMessageId: outcome.messageId, sentAt: new Date().toISOString(), error: null, updatedAt: new Date().toISOString() })
      .where(eq(schema.scheduledMessages.id, id))
      .run();
    logger.info({ id, conversationId: claimed.conversationId }, '予約した送信を実行しました');
    return { ok: true, outcome };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 500);
    const stale = msg.includes('6 時間以上');
    const givenUp = stale || opts.force || attempts >= MAX_ATTEMPTS;
    // あきらめるまでは pending に戻して次の分で再試行。あきらめたら failed にして要確認へ
    d.update(schema.scheduledMessages)
      .set({ status: givenUp ? 'failed' : 'pending', attempts, error: msg, updatedAt: new Date().toISOString() })
      .where(eq(schema.scheduledMessages.id, id))
      .run();
    logger.warn({ id, attempts, givenUp, err: msg }, '予約した送信に失敗');
    if (givenUp) {
      const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, claimed.conversationId)).get();
      upsertAlert({
        type: 'scheduled_send_failed',
        dedupeKey: `scheduled_send_failed:${id}:${attempts}`,
        title: `送信予約が失敗: ${conv?.counterpartName ?? conv?.subject ?? `会話 ${claimed.conversationId}`}`,
        body: `${msg}\n\n本文: ${claimed.text.slice(0, 120)}`,
        payload: { scheduledMessageId: id, conversationId: claimed.conversationId },
      });
    }
    return { ok: false, error: msg, givenUp };
  }
}

/** 毎分のジョブ: 時刻が来た予約を順に送る */
export async function runDueScheduled(now = new Date()): Promise<{ sent: number; failed: number }> {
  const due = db()
    .select({ id: schema.scheduledMessages.id })
    .from(schema.scheduledMessages)
    .where(and(eq(schema.scheduledMessages.status, 'pending'), lte(schema.scheduledMessages.scheduledAt, now.toISOString())))
    .orderBy(asc(schema.scheduledMessages.scheduledAt))
    .all();
  let sent = 0;
  let failed = 0;
  for (const { id } of due) {
    const r = await dispatchScheduled(id);
    if (r.ok) sent++;
    else failed++;
  }
  return { sent, failed };
}

/** 再起動で sending のまま残ったものを pending に戻す（起動時に 1 回） */
export function recoverStuckScheduled(): number {
  const rows = db().select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.status, 'sending')).all();
  for (const r of rows) {
    db().update(schema.scheduledMessages).set({ status: 'pending', updatedAt: new Date().toISOString() }).where(eq(schema.scheduledMessages.id, r.id)).run();
  }
  return rows.length;
}
