import { describe, it, expect } from 'vitest';
import { messageLink } from '@lcm/shared';

describe('メッセージへの行き先', () => {
  it('メッセージを名指しすると、会話を開いてそこまで動かす', () => {
    expect(messageLink(12, 345)).toBe('/inbox/12?message=345');
  });

  it('メッセージが分からなければ会話だけを開く（最新・未読の先頭が出る）', () => {
    expect(messageLink(12)).toBe('/inbox/12');
    expect(messageLink(12, null)).toBe('/inbox/12');
  });
});
