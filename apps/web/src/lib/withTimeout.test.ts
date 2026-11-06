import { describe, it, expect, vi } from 'vitest';
import { withTimeout, ServerTimeoutError } from './api';

describe('サーバーの返事を待つ時間の上限', () => {
  it('時間内に返事が来ればそのまま返す', async () => {
    await expect(withTimeout(Promise.resolve(1), 1000)).resolves.toBe(1);
  });
  it('返事が来なければ、時間切れのエラーにする（「読み込み中」のまま止めない）', async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise(() => undefined), 20_000);
    vi.advanceTimersByTime(20_000);
    await expect(p).rejects.toBeInstanceOf(ServerTimeoutError);
    vi.useRealTimers();
  });
  it('つながらないなどの失敗は、そのまま伝える', async () => {
    await expect(withTimeout(Promise.reject(new TypeError('Failed to fetch')), 1000)).rejects.toThrow('Failed to fetch');
  });
});
