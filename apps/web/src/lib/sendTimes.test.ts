import { describe, it, expect } from 'vitest';
import { quickSendTimes } from './sendTimes';

/** 日本時間の日時から Date を作る */
const jst = (s: string) => new Date(`${s}+09:00`);

describe('送信予約のよく使う時刻', () => {
  it('先頭に「1 時間後」があり、押した時点の 1 時間後になる', () => {
    const t = quickSendTimes(jst('2026-09-24T10:23:00'));
    expect(t[0]).toEqual({ key: 'in1h', label: '1 時間後（11:23）', value: '2026-09-24T11:23' });
  });

  it('夜遅くは日をまたぐので「明日」と添える', () => {
    const t = quickSendTimes(jst('2026-09-24T23:40:00'));
    expect(t[0]).toEqual({ key: 'in1h', label: '1 時間後（明日 0:40）', value: '2026-09-25T00:40' });
  });

  it('過ぎた「今日 12:00 / 17:00」は出さず、明日の分は残す', () => {
    const morning = quickSendTimes(jst('2026-09-24T09:00:00')).map((q) => q.key);
    expect(morning).toEqual(['in1h', 'today12', 'today17', 'tomorrow9', 'tomorrow10']);
    const evening = quickSendTimes(jst('2026-09-24T18:00:00')).map((q) => q.key);
    expect(evening).toEqual(['in1h', 'tomorrow9', 'tomorrow10']);
  });

  it('時刻が進んでも、見分け用の key は変わらない', () => {
    const a = quickSendTimes(jst('2026-09-24T10:00:00'))[0]!;
    const b = quickSendTimes(jst('2026-09-24T10:05:00'))[0]!;
    expect(a.key).toBe(b.key);
    expect(a.value).not.toBe(b.value);
  });
});
