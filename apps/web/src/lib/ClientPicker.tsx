import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { readingKey } from './sort';

export interface ClientOption {
  id: number;
  name: string;
  kana?: string | null;
}

/** 依頼者一覧をあいうえお順（かな → 氏名）で返す */
export function sortClients<T extends ClientOption>(list: T[]): T[] {
  return [...list].sort((a, b) => readingKey(a.kana, a.name).localeCompare(readingKey(b.kana, b.name), 'ja'));
}

/** 依頼者一覧（あいうえお順）を取得する共通フック */
export function useClients() {
  const q = useQuery({ queryKey: ['clients'], queryFn: () => api.get<ClientOption[]>('/clients') });
  const sorted = useMemo(() => sortClients(q.data ?? []), [q.data]);
  return { ...q, sorted };
}

function matches(c: ClientOption, q: string): boolean {
  const n = q.replace(/[\s　]/g, '');
  if (!n) return true;
  const hira = (s: string) => s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  return c.name.replace(/[\s　]/g, '').includes(n) || hira(c.kana ?? '').includes(hira(n));
}

/**
 * 依頼者の選択（テキストで絞り込み ＋ あいうえお順のプルダウン）。
 * 絞り込みで 1 件に絞れたら自動でその依頼者を選ぶ。
 */
export function ClientPicker({
  value,
  onChange,
  emptyLabel = '依頼者を選択…',
  suggestions = [],
  className = '',
  selectClassName = 'w-56',
  autoFocus = false,
}: {
  value: string;
  onChange: (id: string) => void;
  emptyLabel?: string;
  /** 先頭に「候補」として出す依頼者 */
  suggestions?: ClientOption[];
  className?: string;
  selectClassName?: string;
  autoFocus?: boolean;
}) {
  const { sorted } = useClients();
  const [q, setQ] = useState('');
  const filtered = useMemo(() => sorted.filter((c) => matches(c, q)), [sorted, q]);
  // 絞り込みで 1 件になったら自動選択。選択中のものが絞り込みから外れても選択は保つ
  useEffect(() => {
    if (q && filtered.length === 1 && String(filtered[0].id) !== value) onChange(String(filtered[0].id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, filtered]);
  const selected = sorted.find((c) => String(c.id) === value);
  const list = selected && !filtered.some((c) => c.id === selected.id) ? [selected, ...filtered] : filtered;
  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      <input
        className="input w-36"
        placeholder="名前・かなで絞込"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus={autoFocus}
        aria-label="依頼者を絞り込み"
      />
      <select className={`input ${selectClassName}`} value={value} onChange={(e) => onChange(e.target.value)} aria-label="依頼者">
        <option value="">{emptyLabel}</option>
        {suggestions.length > 0 && !q && (
          <optgroup label="候補">
            {suggestions.map((s) => (
              <option key={`s${s.id}`} value={s.id}>
                {s.name}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label={q ? `「${q}」に一致（${filtered.length} 件）` : 'すべて（あいうえお順）'}>
          {list.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </optgroup>
      </select>
    </div>
  );
}
