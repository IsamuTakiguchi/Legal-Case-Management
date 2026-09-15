import { useState, type ReactNode } from 'react';

/** 長文とみなす目安（これを超えると折りたたむ） */
export function isLongText(text: string, opts: { chars?: number; lines?: number } = {}): boolean {
  return text.length > (opts.chars ?? 300) || text.split('\n').length > (opts.lines ?? 8);
}

/**
 * Chatwork のように、長い本文は途中で省略し「続きを表示」で全文を出す。
 * 短い本文はそのまま全部出す（ボタンも出さない）。
 */
export function LongText({
  text,
  className = '',
  buttonClassName = 'text-xs',
  clamp = 'line-clamp-4',
  stopPropagation = false,
  moreLabel = '続きを表示',
  lessLabel = '折りたたむ',
  children,
  footer,
  onExpand,
}: {
  /** 長文かどうかの判定に使う本文 */
  text: string;
  className?: string;
  buttonClassName?: string;
  /** 折りたたむときの行数（Tailwind の line-clamp-*） */
  clamp?: string;
  /** 一覧の行など、クリックが親に伝わると困るときに true */
  stopPropagation?: boolean;
  moreLabel?: string;
  lessLabel?: string;
  /** 本文の代わりに描く中身（送信者名を頭に付けるときなど）。省略すると text をそのまま描く */
  children?: ReactNode;
  /** 開いているときだけ本文の下に出す内容 */
  footer?: ReactNode;
  /** 初めて開いたときに呼ぶ（全文をあとから読み込むとき用） */
  onExpand?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const long = isLongText(text);
  return (
    <div className={className}>
      <div className={`whitespace-pre-wrap break-words ${long && !open ? clamp : ''}`}>{children ?? text}</div>
      {open && footer}
      {long && (
        <button
          type="button"
          className={`mt-0.5 text-blue-700 hover:underline ${buttonClassName}`}
          onClick={(e) => {
            if (stopPropagation) {
              e.preventDefault();
              e.stopPropagation();
            }
            if (!open) onExpand?.();
            setOpen(!open);
          }}
        >
          {open ? lessLabel : moreLabel}
        </button>
      )}
    </div>
  );
}
