import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface RoomOption {
  roomId: number;
  name: string;
  type: string;
}

/** 比較用にそろえる（空白を取り、全角半角・大文字小文字・カタカナの違いを無視する） */
function norm(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\s　]/g, '')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

function matches(r: RoomOption, q: string): boolean {
  const n = norm(q);
  if (!n) return true;
  return norm(r.name).includes(n) || String(r.roomId).includes(n);
}

/** Chatwork の参加ルーム一覧（名前順）を取得する共通フック */
export function useChatworkRooms() {
  const q = useQuery({ queryKey: ['chatwork-rooms'], queryFn: () => api.get<RoomOption[]>('/chatwork/rooms'), staleTime: 5 * 60_000 });
  const sorted = useMemo(() => [...(q.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'ja')), [q.data]);
  return { ...q, sorted };
}

/**
 * Chatwork ルームの選択（テキストで絞り込み ＋ 名前順のプルダウン）。
 * 絞り込みで 1 件になったら自動でそのルームを選ぶ。ルーム名でも ID でも探せる。
 */
export function RoomPicker({
  value,
  onChange,
  emptyLabel = 'ルームを選択…',
  className = '',
  selectClassName = 'min-w-0 flex-1',
}: {
  value: string;
  onChange: (roomId: string) => void;
  emptyLabel?: string;
  className?: string;
  selectClassName?: string;
}) {
  const { sorted, isLoading } = useChatworkRooms();
  const [q, setQ] = useState('');
  const filtered = useMemo(() => sorted.filter((r) => matches(r, q)), [sorted, q]);
  // 絞り込みで 1 件になったら自動選択。選択中のものが絞り込みから外れても選択は保つ
  useEffect(() => {
    if (q && filtered.length === 1 && String(filtered[0]!.roomId) !== value) onChange(String(filtered[0]!.roomId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, filtered]);
  const selected = sorted.find((r) => String(r.roomId) === value);
  const list = selected && !filtered.some((r) => r.roomId === selected.roomId) ? [selected, ...filtered] : filtered;
  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      <input className="input w-32 shrink-0" placeholder="ルーム名で絞込" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Chatwork ルームを絞り込み" />
      <select className={`input ${selectClassName}`} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Chatwork ルーム">
        <option value="">{emptyLabel}</option>
        <optgroup label={q ? `「${q}」に一致（${filtered.length} 件）` : `すべて（${sorted.length} 件・名前順）`}>
          {list.map((r) => (
            <option key={r.roomId} value={r.roomId}>
              {r.name}
            </option>
          ))}
        </optgroup>
        {/* 一覧に無い ID が入っているとき（未接続・退出したルームなど）も選択を保つ */}
        {value && !selected && <option value={value}>ルーム {value}</option>}
      </select>
      {!isLoading && sorted.length === 0 && <span className="w-full text-xs text-slate-400">Chatwork に接続すると、参加しているルームが一覧に出ます</span>}
    </div>
  );
}
