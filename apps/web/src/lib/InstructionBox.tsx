import { useLayoutEffect, useRef } from 'react';

/**
 * AI への指示の入力欄。1 行では足りないことが多いので、横幅いっぱい・複数行で、書いた分だけ縦に伸びる（最大 10 行ほど）。
 * Enter は改行。Ctrl（Mac は ⌘）+ Enter で onSubmit（下書きの作成など）を実行する
 */
export function InstructionBox({
  value,
  onChange,
  placeholder,
  onSubmit,
  className = '',
  rows = 2,
  ariaLabel = 'AI への指示',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  onSubmit?: () => void;
  className?: string;
  rows?: number;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // 中身に合わせて高さを変える（最小は rows 行、最大は約 10 行。それ以上はスクロール）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight + 2, line * 10 + 24)}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      className={`input w-full min-w-0 resize-y leading-relaxed ${className}`}
      rows={rows}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (onSubmit && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onSubmit();
        }
      }}
      placeholder={placeholder}
      aria-label={ariaLabel}
      title={onSubmit ? 'Ctrl（Mac は ⌘）+ Enter で実行' : undefined}
    />
  );
}
