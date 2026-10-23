import { useEffect, useState } from 'react';

/**
 * 文字をクリップボードにコピーする。
 * navigator.clipboard が使えない・断られたとき（古いブラウザ、http の画面など）は、選択してコピーする昔の方法で試す
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 下の方法で試す
  }
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

/** 押すと text をコピーし、しばらく「コピーしました」と出すボタン */
export function CopyButton({ text, label = 'コピー', title, className = 'whitespace-nowrap text-xs text-blue-700 hover:underline' }: { text: string; label?: string; title?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 1800);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button type="button" className={className} title={title} onClick={async () => setState((await copyText(text)) ? 'done' : 'failed')} aria-live="polite">
      {state === 'done' ? '✓ コピーしました' : state === 'failed' ? 'コピーできませんでした' : label}
    </button>
  );
}
