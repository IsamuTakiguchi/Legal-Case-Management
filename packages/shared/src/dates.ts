/** Asia/Tokyo 固定の日付ユーティリティ（依存ライブラリなし） */
export const JST_OFFSET_MINUTES = 9 * 60;

export function toJstParts(d: Date) {
  const t = new Date(d.getTime() + JST_OFFSET_MINUTES * 60_000);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    weekday: t.getUTCDay(), // 0=Sun
  };
}

/** JST の年月日時分から Date を作る */
export function jstDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - JST_OFFSET_MINUTES * 60_000);
}

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** 例: 4月10日(木)14時 / 14時30分 */
export function formatJaDateTime(d: Date, opts: { withWeekday?: boolean } = {}): string {
  const p = toJstParts(d);
  const wd = opts.withWeekday === false ? '' : `(${WEEKDAY_JA[p.weekday]})`;
  const min = p.minute === 0 ? '' : `${p.minute}分`;
  return `${p.month}月${p.day}日${wd}${p.hour}時${min}`;
}

export function formatJaDate(d: Date): string {
  const p = toJstParts(d);
  return `${p.year}年${p.month}月${p.day}日(${WEEKDAY_JA[p.weekday]})`;
}

export function yyyymmdd(d: Date): string {
  const p = toJstParts(d);
  return `${p.year}${String(p.month).padStart(2, '0')}${String(p.day).padStart(2, '0')}`;
}

export function isJstWeekend(d: Date): boolean {
  const w = toJstParts(d).weekday;
  return w === 0 || w === 6;
}

/** 日本の祝日は外部データに依存するため、営業日判定は土日のみ（設定で祝日リストを追加可能） */
export function addBusinessDays(from: Date, days: number, holidays: Set<string> = new Set()): Date {
  let cur = new Date(from.getTime());
  let remaining = days;
  while (remaining > 0) {
    cur = new Date(cur.getTime() + 24 * 3600_000);
    if (isJstWeekend(cur)) continue;
    const p = toJstParts(cur);
    const key = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
    if (holidays.has(key)) continue;
    remaining--;
  }
  return cur;
}

export function startOfJstDay(d: Date): Date {
  const p = toJstParts(d);
  return jstDate(p.year, p.month, p.day, 0, 0);
}

// ---- タスクの締切・返信期限（時刻を決めない「日付だけ」の期限） ----

/**
 * 日付だけの期限は、その日の終わり（JST 23:59:59.999）として持つ。
 * 画面からは秒・ミリ秒まで入らないので、この時刻なら「時刻を決めていない」とみなす
 */
export function dateOnlyDeadline(ymd: string): string {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) - JST_OFFSET_MINUTES * 60_000).toISOString();
}

/** 日付だけの期限か（時刻を決めていない） */
export function isDateOnlyDeadline(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return false;
  const j = new Date(t.getTime() + JST_OFFSET_MINUTES * 60_000);
  return j.getUTCHours() === 23 && j.getUTCMinutes() === 59 && j.getUTCSeconds() === 59 && j.getUTCMilliseconds() === 999;
}

/** JST の YYYY-MM-DD */
export function jstYmd(d: Date): string {
  const p = toJstParts(d);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * AI が読み取った期限（YYYY-MM-DD）の年を直す。
 * 「11/10」のように年の無い日付を去年と読んでしまうことがあるので、
 * 今日より 90 日以上前になっていれば、90 日以内に入るまで 1 年ずつ進める（直近の過去の期限はそのまま）
 */
export function fixDueYear(ymd: string | null | undefined, now = new Date()): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd ?? '');
  if (!m) return null;
  let y = Number(m[1]);
  const limit = jstYmd(new Date(now.getTime() - 90 * 86400_000));
  const at = (yy: number) => `${yy}-${m[2]}-${m[3]}`;
  while (at(y) < limit) y++;
  return at(y);
}

/** 「2026-11-10」→「11/10(火)」（年が今年でなければ、または withYear なら「2027/1/5(火)」） */
export function shortYmd(ymd: string | null | undefined, now = new Date(), withYear = false): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd ?? '');
  if (!m) return '';
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const wd = WEEKDAY_JA[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return y === toJstParts(now).year && !withYear ? `${mo}/${d}(${wd})` : `${y}/${mo}/${d}(${wd})`;
}

/**
 * 次のアクション・タスク案の期限の表示（「締切 11/10(火)・返信期限 11/5(木)」）。無ければ空。
 * 保存する文（タスクのメモなど）には withYear で年を付ける（来年読んでも分かるように）
 */
export function actionDeadlinesLabel(a: { due?: string | null; replyBy?: string | null }, opts: { now?: Date; withYear?: boolean } = {}): string {
  const f = (x: string) => shortYmd(x, opts.now ?? new Date(), opts.withYear);
  return [a.due ? `締切 ${f(a.due)}` : '', a.replyBy ? `返信期限 ${f(a.replyBy)}` : ''].filter(Boolean).join('・');
}
