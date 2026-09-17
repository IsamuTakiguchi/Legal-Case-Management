import { describe, it, expect } from 'vitest';
import { badgeCount, badgeSource } from './badge';

describe('アイコンに出す件数', () => {
  it('設定に応じて数を決める', () => {
    const c = { inbox: 3, alerts: 5 };
    expect(badgeCount(c, 'inbox')).toBe(3);
    expect(badgeCount(c, 'inbox_alerts')).toBe(8);
    expect(badgeCount(c, 'off')).toBe(0);
  });

  it('未設定・知らない値は「受信箱の未返信だけ」にする', () => {
    expect(badgeSource(undefined)).toBe('inbox');
    expect(badgeSource('')).toBe('inbox');
    expect(badgeSource('なにか')).toBe('inbox');
    expect(badgeSource('inbox_alerts')).toBe('inbox_alerts');
    expect(badgeSource('off')).toBe('off');
  });

  it('0 件のときは 0（呼び出し側で消す）', () => {
    expect(badgeCount({ inbox: 0, alerts: 0 }, 'inbox_alerts')).toBe(0);
  });
});
