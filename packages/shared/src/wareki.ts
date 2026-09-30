/** 和暦の元号（開始日の新しい順） */
const ERAS = [
  { name: '令和', short: 'R', start: '2019-05-01', base: 2018 },
  { name: '平成', short: 'H', start: '1989-01-08', base: 1988 },
  { name: '昭和', short: 'S', start: '1926-12-25', base: 1925 },
] as const;
const ERA_BY_KEY: Record<string, (typeof ERAS)[number]> = { 令和: ERAS[0], r: ERAS[0], 平成: ERAS[1], h: ERAS[1], 昭和: ERAS[2], s: ERAS[2] };

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function validIso(y: number, m: number, d: number): string | null {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * 日付の文字を YYYY-MM-DD にする。読めなければ null。
 * 「R5.9.10」「令和5年9月10日」「令和元年5月1日」「H31.4.30」「2023/9/10」「2023-09-10」「2023年9月10日」を読む
 */
export function parseJaDate(text: string | null | undefined): string | null {
  const t = (text ?? '').normalize('NFKC').trim().replace(/\s+/g, '').replace(/[（(][月火水木金土日][)）]$/, '');
  if (!t) return null;
  const era = /^(令和|平成|昭和|[RHSrhs])(元|\d{1,2})[.\-/年](\d{1,2})[.\-/月](\d{1,2})日?$/.exec(t);
  if (era) {
    const e = ERA_BY_KEY[era[1]!.length === 1 ? era[1]!.toLowerCase() : era[1]!]!;
    const y = era[2] === '元' ? 1 : Number(era[2]);
    return validIso(e.base + y, Number(era[3]), Number(era[4]));
  }
  const west = /^(\d{4})[.\-/年](\d{1,2})[.\-/月](\d{1,2})日?$/.exec(t);
  if (west) return validIso(Number(west[1]), Number(west[2]), Number(west[3]));
  return null;
}

/** YYYY-MM-DD を和暦に。style=long は「令和5年9月10日」、short は「R5.9.10」 */
export function formatWareki(iso: string | null | undefined, style: 'long' | 'short' = 'long'): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return '';
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const key = `${m[1]}-${m[2]}-${m[3]}`;
  const era = ERAS.find((e) => key >= e.start);
  if (!era) return style === 'long' ? `${y}年${mo}月${d}日` : `${y}.${mo}.${d}`;
  const ey = y - era.base;
  return style === 'long' ? `${era.name}${ey === 1 ? '元' : ey}年${mo}月${d}日` : `${era.short}${ey}.${mo}.${d}`;
}

/** YYYY-MM-DD の n 年後の同じ日（2/29 は 2/28 にする） */
export function addYearsIso(iso: string, years: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  const ny = y + years;
  const last = new Date(Date.UTC(ny, m, 0)).getUTCDate();
  return `${ny}-${pad(m)}-${pad(Math.min(d, last))}`;
}
