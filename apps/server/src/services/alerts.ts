import { and, eq, desc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { AlertType } from '@lcm/shared';

export function upsertAlert(opts: { type: AlertType; dedupeKey: string; title: string; body?: string; payload?: Record<string, unknown> }) {
  const existing = db().select().from(schema.alerts).where(eq(schema.alerts.dedupeKey, opts.dedupeKey)).get();
  if (existing) {
    if (existing.status === 'open') return existing;
    // 解決済みの同一キーは再オープンせず新規扱いにする（キーにタイムスタンプを含めて呼ぶこと）
    return existing;
  }
  return db()
    .insert(schema.alerts)
    .values({ type: opts.type, dedupeKey: opts.dedupeKey, title: opts.title, body: opts.body ?? null, payload: opts.payload ?? {} })
    .returning()
    .get();
}

export function openAlerts(type?: string) {
  const q = db()
    .select()
    .from(schema.alerts)
    .where(type ? and(eq(schema.alerts.status, 'open'), eq(schema.alerts.type, type)) : eq(schema.alerts.status, 'open'))
    .orderBy(desc(schema.alerts.createdAt));
  return q.all();
}

export function resolveAlert(id: number, status: 'resolved' | 'dismissed' = 'resolved') {
  db().update(schema.alerts).set({ status, resolvedAt: new Date().toISOString() }).where(eq(schema.alerts.id, id)).run();
}

export function resolveAlertsByKeyPrefix(prefix: string) {
  const rows = db().select().from(schema.alerts).where(eq(schema.alerts.status, 'open')).all();
  for (const r of rows) {
    if (r.dedupeKey?.startsWith(prefix)) resolveAlert(r.id);
  }
}

export function markNotified(ids: number[]) {
  const now = new Date().toISOString();
  for (const id of ids) db().update(schema.alerts).set({ notifiedAt: now }).where(eq(schema.alerts.id, id)).run();
}
