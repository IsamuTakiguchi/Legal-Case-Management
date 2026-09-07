import { jstDate, toJstParts } from './dates.js';

export interface ParsedHoldSlot {
  startAt: string;
  endAt: string;
  /** 表示用（例: 12/21(月) 10:00〜11:30） */
  label: string;
  /** 終了が書かれておらず既定の長さで補ったか */
  endAssumed: boolean;
}

const WD = ['日', '月', '火', '水', '木', '金', '土'];

/** 全角の数字・記号を半角に寄せ、曜日の括弧を除く */
function normalize(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ':')
    .replace(/[／]/g, '/')
    .replace(/[〜～~\-－ー−–—]/g, '~')
    .replace(/[（(][日月火水木金土祝][）)]/g, ' ')
    .replace(/[　,、]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "10", "10:30", "10時", "10時半", "10時30分" → 分 */
function parseTime(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2})(?::(\d{1,2})|時(?:(\d{1,2})分?|(半))?)?$/);
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 23) return null;
  const min = m[4] ? 30 : Number(m[2] ?? m[3] ?? 0);
  if (min > 59) return null;
  return h * 60 + min;
}

const TIME = '\\d{1,2}(?::\\d{1,2}|時(?:\\d{1,2}分?|半)?)?';
const RANGE_RE = new RegExp(`(${TIME})\\s*~\\s*(${TIME})`, 'g');
const SINGLE_RE = new RegExp(`(?:^|\\s)(${TIME})(?=\\s|$)`, 'g');
const DATE_RE = /(?:(\d{4})[\/年])?(\d{1,2})[\/月](\d{1,2})日?/;

/**
 * 「12/21（月）10～11：30　13～15」のような 1 行を、候補日時（開始・終了）に分解する。
 * 複数行なら行ごとに日付を読む。日付の無い行は直前の日付を引き継ぐ。
 * 年は省略可（今日以降で最も近いその日付）。終了の無い時刻は defaultMinutes で補う。
 */
export function parseHoldText(text: string, opts: { now?: Date; defaultMinutes?: number } = {}): { slots: ParsedHoldSlot[]; errors: string[] } {
  const now = opts.now ?? new Date();
  const dur = opts.defaultMinutes ?? 60;
  const today = toJstParts(now);
  const slots: ParsedHoldSlot[] = [];
  const errors: string[] = [];
  let current: { y: number; m: number; d: number } | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalize(rawLine);
    if (!line) continue;
    let rest = line;
    const dm = line.match(DATE_RE);
    if (dm) {
      const m = Number(dm[2]);
      const d = Number(dm[3]);
      let y = dm[1] ? Number(dm[1]) : today.year;
      if (m < 1 || m > 12 || d < 1 || d > 31) {
        errors.push(`日付が読めません: ${rawLine.trim()}`);
        continue;
      }
      if (!dm[1]) {
        // 年の省略: 今日より前なら来年
        const cand = jstDate(y, m, d);
        const todayStart = jstDate(today.year, today.month, today.day);
        if (cand.getTime() < todayStart.getTime()) y += 1;
      }
      current = { y, m, d };
      rest = line.replace(dm[0], ' ');
    }
    if (!current) {
      errors.push(`日付がありません: ${rawLine.trim()}`);
      continue;
    }
    const found: { start: number; end: number | null }[] = [];
    let consumed = rest;
    for (const r of rest.matchAll(RANGE_RE)) {
      const s = parseTime(r[1]);
      const e = parseTime(r[2]);
      if (s === null || e === null) continue;
      // 「10~11:30」の 11 のように終了だけ時刻が短い場合、午前/午後の補正はしない（そのまま）
      found.push({ start: s, end: e > s ? e : null });
      consumed = consumed.replace(r[0], ' ');
    }
    for (const r of consumed.matchAll(SINGLE_RE)) {
      const s = parseTime(r[1]);
      if (s === null) continue;
      found.push({ start: s, end: null });
    }
    if (found.length === 0) {
      errors.push(`時刻が読めません: ${rawLine.trim()}`);
      continue;
    }
    for (const f of found.sort((a, b) => a.start - b.start)) {
      const start = jstDate(current.y, current.m, current.d, Math.floor(f.start / 60), f.start % 60);
      const endMin = f.end ?? f.start + dur;
      const end = jstDate(current.y, current.m, current.d, Math.floor(endMin / 60), endMin % 60);
      const p = toJstParts(start);
      const fmt = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
      slots.push({
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        label: `${p.month}/${p.day}(${WD[p.weekday]}) ${fmt(f.start)}〜${fmt(endMin)}`,
        endAssumed: f.end === null,
      });
    }
  }
  return { slots, errors };
}
