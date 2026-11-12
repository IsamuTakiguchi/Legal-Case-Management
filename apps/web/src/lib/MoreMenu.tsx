import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface MoreMenuItem {
  label: string;
  onClick: () => void;
  title?: string;
  /** 削除など、取り消せない操作（赤で出す） */
  danger?: boolean;
  hidden?: boolean;
}

/**
 * 「…」を押すと出る操作の一覧。たまにしか使わない操作をまとめて、行をすっきりさせる。
 * 外側を押す・Esc で閉じる
 */
export function MoreMenu({ items, label = '…', title = 'ほかの操作', className = '', align = 'right' }: { items: MoreMenuItem[]; label?: string; title?: string; className?: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  // スクロールする欄の中でも切れないよう、画面に対する位置で出す（下に入らなければ上に出す）
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left?: number; right?: number } | null>(null);
  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom > 220;
    const vert = below ? { top: r.bottom + 4 } : { bottom: window.innerHeight - r.top + 4 };
    const horiz = align === 'right' ? { right: Math.max(8, window.innerWidth - r.right) } : { left: Math.max(8, r.left) };
    setPos({ ...vert, ...horiz });
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    // スクロールしたら閉じる（ボタンから離れた所に残らないように）
    const onScroll = () => setOpen(false);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const shown = items.filter((i) => !i.hidden);
  if (!shown.length) return null;
  return (
    <span ref={ref} className={`relative inline-block ${className}`}>
      <button
        ref={btn}
        type="button"
        className="rounded px-1.5 text-sm leading-5 hover:bg-black/5"
        onClick={() => {
          if (!open) place();
          setOpen((v) => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
      >
        {label}
      </button>
      {open &&
        pos &&
        // 画面の一番外（body）に出す。ガラス風の欄（backdrop-filter）の中だと、位置がその欄を基準にずれるため
        createPortal(
        <span ref={menuRef} role="menu" style={pos} className="fade-in fixed z-[60] flex min-w-[11rem] flex-col rounded-lg border border-slate-200 bg-[var(--surface)] py-1 text-left text-sm text-slate-700 shadow-lg">
          {shown.map((i) => (
            <button
              key={i.label}
              type="button"
              role="menuitem"
              className={`whitespace-nowrap px-3 py-1.5 text-left hover:bg-slate-50 ${i.danger ? 'text-red-600' : ''}`}
              title={i.title}
              onClick={() => {
                setOpen(false);
                i.onClick();
              }}
            >
              {i.label}
            </button>
          ))}
        </span>,
        document.body,
      )}
    </span>
  );
}
