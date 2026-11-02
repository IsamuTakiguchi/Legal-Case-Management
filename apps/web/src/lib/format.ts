import { CHANNEL_LABEL, isAllDayRange, type Channel } from '@lcm/shared';

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', weekday: 'short' });
}

/** 予定の日時。終日なら「10/30(金) 終日」（2 日以上なら「10/30(金)〜10/31 終日」）、それ以外は開始日時 */
export function fmtEventTime(startAt: string, endAt: string): string {
  if (!isAllDayRange(startAt, endAt)) return fmtDateTime(startAt);
  const md = (iso: string, weekday: boolean) => new Date(iso).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', ...(weekday ? { weekday: 'short' as const } : {}) });
  const last = new Date(new Date(endAt).getTime() - 86400_000).toISOString();
  const first = md(startAt, true);
  return md(last, false) === md(startAt, false) ? `${first} 終日` : `${first}〜${md(last, false)} 終日`;
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' });
}

export function fmtRelative(iso?: string | null): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'たった今';
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}日前`;
  return fmtDate(iso);
}

export function channelLabel(ch: string): string {
  return CHANNEL_LABEL[ch as Channel] ?? ch;
}

export function channelBadge(ch: string): string {
  return `badge badge-${ch}`;
}

export function fmtBytes(n?: number | null): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtYen(n?: number | null): string {
  if (n === null || n === undefined) return '';
  return `${n.toLocaleString('ja-JP')}円`;
}

/** datetime-local 入力用 (JST) */
export function toLocalInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return d.toISOString().slice(0, 16);
}

export function fromLocalInput(v: string): string {
  if (!v) return '';
  return new Date(`${v}:00+09:00`).toISOString();
}

export function todayLocalInput(hour = 10): string {
  const d = new Date(Date.now() + 9 * 3600_000);
  return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00`;
}
