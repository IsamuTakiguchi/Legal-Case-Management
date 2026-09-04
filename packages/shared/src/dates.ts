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
