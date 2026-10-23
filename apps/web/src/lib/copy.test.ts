import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyText } from './copy';

afterEach(() => vi.unstubAllGlobals());

describe('コピー', () => {
  it('クリップボードに書き込む', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyText('山田様より電話\n和解案は 300 万')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('山田様より電話\n和解案は 300 万');
  });

  it('クリップボードに断られたら、選択してコピーする方法で試す', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) } });
    const ta = { value: '', style: {} as Record<string, string>, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn() };
    const execCommand = vi.fn(() => true);
    vi.stubGlobal('document', { createElement: () => ta, body: { appendChild: vi.fn() }, execCommand });
    expect(await copyText('元メモ')).toBe(true);
    expect(ta.value).toBe('元メモ');
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(ta.remove).toHaveBeenCalled();
  });

  it('どちらも使えなければ false', async () => {
    vi.stubGlobal('navigator', {});
    expect(await copyText('x')).toBe(false);
  });
});
