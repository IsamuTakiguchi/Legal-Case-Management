import { describe, it, expect } from 'vitest';
import { badgeCount, badgeSource, badgeToApply } from './badge';

describe('アイコンに出す件数', () => {
  it('設定に応じて数を決める', () => {
    // 未読 1（まだ開いていない）・未返信 3（読んだが返していないものを含む）・要確認 5
    const c = { inbox: 3, unread: 1, alerts: 5 };
    expect(badgeCount(c, 'inbox_unread')).toBe(1);
    expect(badgeCount(c, 'inbox')).toBe(3);
    expect(badgeCount(c, 'inbox_alerts')).toBe(8);
    expect(badgeCount(c, 'off')).toBe(0);
  });

  it('未設定・知らない値は「受信箱の未返信だけ」にする', () => {
    expect(badgeSource(undefined)).toBe('inbox');
    expect(badgeSource('')).toBe('inbox');
    expect(badgeSource('なにか')).toBe('inbox');
    expect(badgeSource('inbox_unread')).toBe('inbox_unread');
    expect(badgeSource('inbox_alerts')).toBe('inbox_alerts');
    expect(badgeSource('off')).toBe('off');
  });

  it('古いサーバーから未読が返らなくても落ちない', () => {
    expect(badgeCount({ inbox: 3, alerts: 5 }, 'inbox_unread')).toBe(0);
  });

  it('0 件のときは 0（呼び出し側で消す）', () => {
    expect(badgeCount({ inbox: 0, unread: 0, alerts: 0 }, 'inbox_alerts')).toBe(0);
  });
});

describe('アイコンに書くかどうか', () => {
  const counts = { inbox: 3, unread: 2, alerts: 5 };

  it('件数がまだ来ていないときは書かない', () => {
    expect(badgeToApply(undefined, true, 'inbox')).toBeNull();
  });

  it('設定がまだ来ていないときは書かない（「表示しない」なのに数を出さないため）', () => {
    expect(badgeToApply(counts, false, 'inbox')).toBeNull();
    // 既定の inbox で 3 を書いてしまうと、そこでアプリを閉じたときに 3 が残る
    expect(badgeToApply(counts, false, 'off')).toBeNull();
    expect(badgeToApply(counts, false, 'inbox_unread')).toBeNull();
  });

  it('両方そろったら、設定どおりの数を書く', () => {
    expect(badgeToApply(counts, true, 'inbox')).toBe(3);
    expect(badgeToApply(counts, true, 'inbox_unread')).toBe(2);
    expect(badgeToApply(counts, true, 'inbox_alerts')).toBe(8);
    // 0 も「書かない」ではなく「消す」なので null にはしない
    expect(badgeToApply(counts, true, 'off')).toBe(0);
    expect(badgeToApply({ inbox: 0, unread: 0, alerts: 0 }, true, 'inbox')).toBe(0);
  });
});
