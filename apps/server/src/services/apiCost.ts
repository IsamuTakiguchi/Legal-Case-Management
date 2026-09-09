import { and, gte, lt, desc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getSetting } from './settings.js';
import { logger } from '../logger.js';

/**
 * Claude の料金表（米ドル／100 万トークン）。Anthropic の公開価格（2026-06 時点）。
 * キャッシュ書込は入力の 1.25 倍、キャッシュ読出は入力の 0.1 倍（Fable 5.1 は 0.25 ドル）。
 * 料金改定があればここを直す
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}
const PRICES: { prefix: string; price: ModelPrice }[] = [
  { prefix: 'claude-fable-5-1', price: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 } },
  { prefix: 'claude-mythos-5-1', price: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 } },
  { prefix: 'claude-fable-5', price: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 } },
  { prefix: 'claude-mythos-5', price: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 } },
  { prefix: 'claude-opus-5', price: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  { prefix: 'claude-opus-4-8', price: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  { prefix: 'claude-opus-4-7', price: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  { prefix: 'claude-opus-4-6', price: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  { prefix: 'claude-opus-4', price: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 } },
  { prefix: 'claude-sonnet-5', price: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 } },
  { prefix: 'claude-sonnet-4-6', price: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
  { prefix: 'claude-sonnet-4', price: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
  { prefix: 'claude-haiku-4-5', price: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
  { prefix: 'claude-haiku', price: { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 } },
];
const FALLBACK = PRICES.find((p) => p.prefix === 'claude-opus-5')!.price;

export function priceFor(model: string): { price: ModelPrice; estimated: boolean } {
  const hit = PRICES.find((p) => model.startsWith(p.prefix));
  return hit ? { price: hit.price, estimated: false } : { price: FALLBACK, estimated: true };
}

export interface UsageTokens {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** トークン数から米ドルの料金を計算する */
export function costUsd(model: string, t: UsageTokens): { usd: number; estimated: boolean } {
  const { price, estimated } = priceFor(model);
  const usd = (t.input * price.input + t.output * price.output + t.cacheWrite * price.cacheWrite + t.cacheRead * price.cacheRead) / 1_000_000;
  return { usd, estimated };
}

/** API 呼び出し 1 回分を記録する（失敗しても本処理は止めない） */
export function recordUsage(opts: { model: string; purpose: string; tokens: UsageTokens; provider?: string }): void {
  try {
    const { usd, estimated } = costUsd(opts.model, opts.tokens);
    db()
      .insert(schema.apiUsage)
      .values({
        provider: opts.provider ?? 'anthropic',
        model: opts.model,
        purpose: opts.purpose,
        inputTokens: opts.tokens.input,
        outputTokens: opts.tokens.output,
        cacheWriteTokens: opts.tokens.cacheWrite,
        cacheReadTokens: opts.tokens.cacheRead,
        costUsd: usd,
        estimated,
      })
      .run();
  } catch (err) {
    logger.warn({ err }, 'API 利用の記録に失敗');
  }
}

/** JST の月の範囲（ISO, UTC） */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1, -9)).toISOString();
  const to = new Date(Date.UTC(y, m, 1, -9)).toISOString();
  return { from, to };
}

export function currentMonthJst(now = new Date()): string {
  const j = new Date(now.getTime() + 9 * 3600_000);
  return `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface UsageBucket {
  calls: number;
  usd: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  estimated: boolean;
}

function emptyBucket(): UsageBucket {
  return { calls: 0, usd: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, estimated: false };
}

function add(b: UsageBucket, r: typeof schema.apiUsage.$inferSelect) {
  b.calls++;
  b.usd += r.costUsd;
  b.input += r.inputTokens;
  b.output += r.outputTokens;
  b.cacheWrite += r.cacheWriteTokens;
  b.cacheRead += r.cacheReadTokens;
  if (r.estimated) b.estimated = true;
}

/** 月ごとのまとめ（今月の用途別・モデル別・日別と、過去 n か月の合計） */
export function usageSummary(month = currentMonthJst(), months = 6) {
  const { from, to } = monthRange(month);
  const rows = db()
    .select()
    .from(schema.apiUsage)
    .where(and(gte(schema.apiUsage.createdAt, from), lt(schema.apiUsage.createdAt, to)))
    .orderBy(desc(schema.apiUsage.createdAt))
    .all();
  const total = emptyBucket();
  const byPurpose = new Map<string, UsageBucket>();
  const byModel = new Map<string, UsageBucket>();
  const byDay = new Map<string, UsageBucket>();
  for (const r of rows) {
    add(total, r);
    const p = byPurpose.get(r.purpose) ?? emptyBucket();
    add(p, r);
    byPurpose.set(r.purpose, p);
    const m = byModel.get(r.model) ?? emptyBucket();
    add(m, r);
    byModel.set(r.model, m);
    const day = new Date(new Date(r.createdAt).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
    const d = byDay.get(day) ?? emptyBucket();
    add(d, r);
    byDay.set(day, d);
  }
  const history: { month: string; calls: number; usd: number; estimated: boolean }[] = [];
  for (let i = 0; i < months; i++) {
    const mo = shiftMonth(month, -i);
    const r = monthRange(mo);
    const rs = db()
      .select()
      .from(schema.apiUsage)
      .where(and(gte(schema.apiUsage.createdAt, r.from), lt(schema.apiUsage.createdAt, r.to)))
      .all();
    const b = emptyBucket();
    for (const x of rs) add(b, x);
    history.push({ month: mo, calls: b.calls, usd: b.usd, estimated: b.estimated });
  }
  const rate = Number(getSetting('usd_jpy_rate')) || 150;
  const sortDesc = (m: Map<string, UsageBucket>) => [...m.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.usd - a.usd);
  return {
    month,
    rate,
    total,
    byPurpose: sortDesc(byPurpose),
    byModel: sortDesc(byModel),
    byDay: [...byDay.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
    history,
    recent: rows.slice(0, 30).map((r) => ({ id: r.id, at: r.createdAt, model: r.model, purpose: r.purpose, input: r.inputTokens, output: r.outputTokens, cacheWrite: r.cacheWriteTokens, cacheRead: r.cacheReadTokens, usd: r.costUsd })),
  };
}
