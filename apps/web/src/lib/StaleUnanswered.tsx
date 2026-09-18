import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { fmtDate } from './format';
import { CHANNEL_LABEL } from '@lcm/shared';

export interface StaleInfo {
  days: number;
  /** いま未返信になっている会話の数（メニューとアイコンに出る数） */
  total: number;
  /** そのうち、最終受信が days 日以上前のもの */
  stale: number;
  byChannel: Record<string, number>;
  oldest: string | null;
}

const DAY_CHOICES = [7, 30, 90, 180];

/**
 * 「しばらく動きのない未返信」の案内と後始末。
 *
 * メニューとアイコンに出る数は未返信の会話の数なので、取り込みの不具合などで
 * 古いやり取りがまとめて未返信になっていると、数が実態より大きくなる。
 * 何がその数を作っているかを見せて、まとめて片付けられるようにする。
 */
export function StaleUnanswered({ compact }: { compact?: boolean }) {
  const qc = useQueryClient();
  const [days, setDays] = useState(30);
  const [msg, setMsg] = useState('');
  const info = useQuery({ queryKey: ['stale-unanswered', days], queryFn: () => api.get<StaleInfo>(`/conversations/stale?days=${days}`), retry: false });
  const clear = useMutation({
    mutationFn: (action: 'resolve' | 'archive') => api.post<{ updated: number }>('/conversations/stale/clear', { days, action }),
    onSuccess: (r, action) => {
      setMsg(`${r.updated} 件を${action === 'archive' ? 'アーカイブしました' : '対応済みにしました'}`);
      qc.invalidateQueries({ queryKey: ['stale-unanswered'] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['nav-counts'] });
    },
    onError: (e) => setMsg((e as Error).message),
  });
  const d = info.data;
  if (!d) return null;
  // 片付けるものが無いときは、内訳だけ知りたい設定画面でだけ出す
  if (d.stale === 0 && compact) return null;

  const breakdown = Object.entries(d.byChannel)
    .map(([ch, n]) => `${CHANNEL_LABEL[ch as keyof typeof CHANNEL_LABEL] ?? ch} ${n} 件`)
    .join('、');

  return (
    <div className={`fade-in space-y-1.5 rounded border border-amber-200 bg-amber-50/50 p-2 text-sm ${compact ? '' : 'mb-2'}`}>
      <div>
        未返信は <span className="font-semibold tabular-nums">{d.total}</span> 件（この数がメニューとアイコンに出ます）。
        {d.stale > 0 && (
          <>
            {' '}
            そのうち <span className="font-semibold tabular-nums">{d.stale}</span> 件は、最後の受信から {d.days} 日以上たっています。
          </>
        )}
      </div>
      {d.stale > 0 && (
        <div className="text-xs text-slate-600">
          {breakdown}
          {d.oldest && `／いちばん古いもの: ${fmtDate(d.oldest)}`}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-slate-600">
          期間
          <select className="input w-auto py-0.5" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DAY_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n} 日以上前
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn btn-sm"
          disabled={d.stale === 0 || clear.isPending}
          title="要返信を外して既読にします。会話自体は受信箱に残ります"
          onClick={() => {
            if (window.confirm(`最後の受信から ${d.days} 日以上たっている未返信 ${d.stale} 件を、対応済みにします。よろしいですか？`)) clear.mutate('resolve');
          }}
        >
          {clear.isPending ? '処理中…' : 'まとめて対応済みにする'}
        </button>
        <button
          className="btn btn-sm"
          disabled={d.stale === 0 || clear.isPending}
          title="受信箱から外します（「アーカイブ」で見られます）"
          onClick={() => {
            if (window.confirm(`最後の受信から ${d.days} 日以上たっている未返信 ${d.stale} 件を、アーカイブします。よろしいですか？`)) clear.mutate('archive');
          }}
        >
          まとめてアーカイブ
        </button>
        {msg && <span className="fade-in text-xs text-slate-600">{msg}</span>}
      </div>
      <div className="text-xs text-slate-500">
        中身を確かめてから決めたいときは、受信箱で「未返信のみ」にして、古い順のものを個別に開いてください。まとめて処理しても、会話とメッセージは消えません。
      </div>
    </div>
  );
}
