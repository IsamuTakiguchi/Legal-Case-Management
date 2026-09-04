import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { env } from '../config.js';
import { upsertAlert } from './alerts.js';

function monthKey(d = new Date()): string {
  const jst = new Date(d.getTime() + 9 * 3600_000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function lineQuotaStatus(): { month: string; used: number; limit: number; remaining: number } {
  const month = monthKey();
  const row = db().select().from(schema.lineQuota).where(eq(schema.lineQuota.month, month)).get();
  const used = row?.pushCount ?? 0;
  const limit = env().LINE_MONTHLY_PUSH_LIMIT;
  return { month, used, limit, remaining: Math.max(0, limit - used) };
}

export function recordLinePush(count = 1) {
  const month = monthKey();
  db()
    .insert(schema.lineQuota)
    .values({ month, pushCount: count })
    .onConflictDoUpdate({ target: schema.lineQuota.month, set: { pushCount: (db().select().from(schema.lineQuota).where(eq(schema.lineQuota.month, month)).get()?.pushCount ?? 0) + count } })
    .run();
  const st = lineQuotaStatus();
  if (st.limit > 0 && st.used >= st.limit * 0.9) {
    upsertAlert({
      type: 'line_quota',
      dedupeKey: `line_quota:${month}`,
      title: `LINE の月間送信数が上限に接近（${st.used}/${st.limit}）`,
      body: '上限に達すると LINE からの返信ができなくなります。プランの見直しを検討してください。',
    });
  }
}

export function assertLineQuota() {
  const st = lineQuotaStatus();
  if (st.limit > 0 && st.used >= st.limit) throw new Error(`LINE の月間送信上限（${st.limit}通）に達しています`);
}
