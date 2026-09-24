/**
 * 送信予約の「よく使う時刻」。値は datetime-local 用の日本時間（YYYY-MM-DDTHH:MM）。
 *
 * 「1 時間後」は、押したその時点から 1 時間後にする（画面を開いたままでもずれない）。
 */
export interface QuickSendTime {
  /** ボタンの見分け用（値は時刻が進むと変わるので、選択中かどうかはこれで見る） */
  key: string;
  label: string;
  value: string;
}

export function quickSendTimes(now = new Date()): QuickSendTime[] {
  const jstNow = new Date(now.getTime() + 9 * 3600_000);
  const day = (offset: number) => new Date(jstNow.getTime() + offset * 86400_000).toISOString().slice(0, 10);
  const at = (d: string, h: number) => `${d}T${String(h).padStart(2, '0')}:00`;
  const nowLocal = jstNow.toISOString().slice(0, 16);
  const out: QuickSendTime[] = [];

  // 1 時間後（分まで）。日をまたぐときは「明日」と添える
  const inHour = new Date(jstNow.getTime() + 3600_000).toISOString().slice(0, 16);
  const hm = `${Number(inHour.slice(11, 13))}:${inHour.slice(14, 16)}`;
  out.push({ key: 'in1h', label: `1 時間後（${inHour.slice(0, 10) === day(0) ? '' : '明日 '}${hm}）`, value: inHour });

  if (at(day(0), 12) > nowLocal) out.push({ key: 'today12', label: '今日 12:00', value: at(day(0), 12) });
  if (at(day(0), 17) > nowLocal) out.push({ key: 'today17', label: '今日 17:00', value: at(day(0), 17) });
  out.push({ key: 'tomorrow9', label: '明日 9:00', value: at(day(1), 9) });
  out.push({ key: 'tomorrow10', label: '明日 10:00', value: at(day(1), 10) });
  return out;
}
