import { useEffect, useState } from 'react';

export interface SortOption<T> {
  key: string;
  label: string;
  /** 比較用の値。文字列は日本語ロケールで比較 */
  value: (row: T) => string | number | null | undefined;
  /** 既定の向き */
  desc?: boolean;
}

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

/** 読み（かな）があればそれで、無ければ氏名でのあいうえお順。全角・半角空白は無視 */
export function readingKey(kana: string | null | undefined, name: string): string {
  const k = (kana ?? '').replace(/[\s　]/g, '');
  const n = name.replace(/[\s　]/g, '');
  // カタカナはひらがなに寄せて比較を安定させる
  const hira = (s: string) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  return hira(k || n);
}

export function sortRows<T>(rows: T[], opt: SortOption<T>, desc: boolean): T[] {
  const dir = desc ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = opt.value(a);
    const vb = opt.value(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1; // 空は常に末尾
    if (vb == null) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return collator.compare(String(va), String(vb)) * dir;
  });
}

/** 並べ替えの選択を localStorage に記憶する */
export function useSort<T>(storageKey: string, options: SortOption<T>[], defaultKey: string) {
  const read = () => {
    try {
      const v = JSON.parse(localStorage.getItem(`lcm-sort:${storageKey}`) ?? 'null') as { key: string; desc: boolean } | null;
      if (v && options.some((o) => o.key === v.key)) return v;
    } catch {
      /* ignore */
    }
    const o = options.find((x) => x.key === defaultKey) ?? options[0];
    return { key: o.key, desc: !!o.desc };
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    try {
      localStorage.setItem(`lcm-sort:${storageKey}`, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state, storageKey]);
  const option = options.find((o) => o.key === state.key) ?? options[0];
  const apply = (rows: T[]) => sortRows(rows, option, state.desc);
  const setKey = (key: string) => {
    const o = options.find((x) => x.key === key) ?? options[0];
    setState((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: !!o.desc }));
  };
  return { key: state.key, desc: state.desc, option, apply, setKey, options };
}

/** 列見出し用の並べ替えボタン */
export function SortHeader({ label, sortKey, current, desc, onClick, className = '' }: { label: string; sortKey: string; current: string; desc: boolean; onClick: (k: string) => void; className?: string }) {
  const active = current === sortKey;
  return (
    <button type="button" className={`inline-flex items-center gap-1 whitespace-nowrap hover:text-slate-800 ${active ? 'font-semibold text-slate-800' : ''} ${className}`} onClick={() => onClick(sortKey)} aria-sort={active ? (desc ? 'descending' : 'ascending') : 'none'}>
      {label}
      <span className="text-[10px] text-slate-400">{active ? (desc ? '▼' : '▲') : '⇅'}</span>
    </button>
  );
}
