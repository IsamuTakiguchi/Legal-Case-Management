import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** 記録の「相手」「電話番号」の候補（過去の記録と、登録してある連絡先から） */
export interface ContactSuggestion {
  name: string;
  phone: string | null;
  hint: string;
}

const norm = (s: string) => s.replace(/[\s　]/g, '').toLowerCase();
const digits = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\D/g, '');

/** 入力中の相手・電話番号で候補を絞る（どちらも空なら上から順に） */
export function filterContactSuggestions(list: ContactSuggestion[], name: string, phone: string, max = 6): ContactSuggestion[] {
  const q = norm(name);
  const qd = digits(phone);
  return list
    .filter((s) => !(norm(s.name) === q && digits(s.phone ?? '') === qd))
    .filter((s) => !q || norm(s.name).includes(q) || norm(s.hint).includes(q))
    .filter((s) => !qd || digits(s.phone ?? '').includes(qd))
    .slice(0, max);
}

/**
 * 記録の入力欄の下に出す候補のボタン。押すと相手と電話番号を入れる（候補に番号が無ければ相手だけ）
 */
export function ContactSuggestions({ caseId, name, phone, onPick }: { caseId: number | null; name: string; phone: string; onPick: (s: ContactSuggestion) => void }) {
  const q = useQuery({
    queryKey: ['note-contact-suggestions', caseId ?? 0],
    queryFn: () => api.get<ContactSuggestion[]>(`/note-contact-suggestions${caseId ? `?caseId=${caseId}` : ''}`),
    staleTime: 60_000,
  });
  const items = filterContactSuggestions(q.data ?? [], name, phone);
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <span className="text-slate-500">候補:</span>
      {items.map((s) => (
        <button
          key={`${s.name}|${s.phone ?? ''}`}
          type="button"
          className="rounded-full border border-slate-200 bg-white px-2 py-0.5 hover:bg-slate-50"
          onClick={() => onPick(s)}
          title={`${s.hint}。押すと相手${s.phone ? 'と電話番号' : ''}を入れます`}
        >
          {s.name || '（名前なし）'}
          {s.phone && <span className="ml-1 tabular-nums text-slate-500">{s.phone}</span>}
          <span className="ml-1 text-slate-400">{s.hint}</span>
        </button>
      ))}
    </div>
  );
}
