import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { channelBadge, channelLabel, fmtRelative } from '../lib/format';

interface ConversationListItem {
  id: number;
  channel: string;
  subject: string | null;
  counterpartName: string | null;
  counterpartAddress: string | null;
  clientId: number | null;
  client: { id: number; name: string } | null;
  lastMessageAt: string | null;
  unread: number;
  needsReply: boolean;
  lastMessage: { body: string; direction: string; sentAt: string } | null;
}

export default function Inbox() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const filter = { channel: params.get('channel') ?? '', needsReply: params.get('needsReply') ?? '', unlinked: params.get('unlinked') ?? '', q: params.get('q') ?? '', archived: params.get('archived') ?? '', outbound: params.get('outbound') ?? '' };
  const query = useQuery({
    queryKey: ['conversations', filter],
    queryFn: () => api.get<ConversationListItem[]>(`/conversations?${new URLSearchParams(Object.fromEntries(Object.entries(filter).filter(([, v]) => v))).toString()}`),
    refetchInterval: 30_000,
  });
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next);
  };
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [msg, setMsg] = useState('');
  // 絞り込みを変えたら選択を解除
  useEffect(() => setSelected(new Set()), [filter.channel, filter.needsReply, filter.unlinked, filter.q, filter.archived, filter.outbound]);
  const ids = query.data?.map((c) => c.id) ?? [];
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const bulk = useMutation({
    mutationFn: (action: 'resolve' | 'archive' | 'unarchive' | 'read') => api.post<{ updated: number }>('/conversations/bulk', { ids: [...selected], action }),
    onSuccess: (r, action) => {
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      const label = action === 'resolve' ? '対応済みにしました' : action === 'archive' ? 'アーカイブしました' : action === 'unarchive' ? 'アーカイブを解除しました' : '既読にしました';
      setMsg(`${r.updated} 件を${label}`);
    },
    onError: (e) => setMsg((e as Error).message),
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">受信箱</h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select className="input w-auto" value={filter.channel} onChange={(e) => set('channel', e.target.value)}>
            <option value="">全チャネル</option>
            <option value="line">LINE公式</option>
            <option value="chatwork">Chatwork</option>
            <option value="gmail">Gmail</option>
          </select>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={filter.needsReply === '1'} onChange={(e) => set('needsReply', e.target.checked ? '1' : '')} /> 未返信のみ
          </label>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={filter.unlinked === '1'} onChange={(e) => set('unlinked', e.target.checked ? '1' : '')} /> 未紐付けのみ
          </label>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={filter.archived === '1'} onChange={(e) => set('archived', e.target.checked ? '1' : '')} /> アーカイブ
          </label>
          <label className="flex items-center gap-1 text-sm" title="相手からの受信が無く、自分が送っただけの会話も一覧に出します">
            <input type="checkbox" checked={filter.outbound === '1'} onChange={(e) => set('outbound', e.target.checked ? '1' : '')} /> 送信のみの会話も表示
          </label>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              set('q', q);
            }}
          >
            <input className="input md:w-56" placeholder="本文を検索（3文字以上）" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
        </div>
      </div>
      {(query.data?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? new Set(ids) : new Set())} /> すべて選択
          </label>
          {selected.size > 0 ? (
            <>
              <span className="text-slate-600">{selected.size} 件を選択中</span>
              {filter.archived !== '1' && (
                <>
                  <button className="btn btn-sm" onClick={() => bulk.mutate('resolve')} disabled={bulk.isPending} title="要返信を外して既読にします">
                    対応済みにする
                  </button>
                  <button className="btn btn-sm" onClick={() => bulk.mutate('archive')} disabled={bulk.isPending} title="受信箱から外します（「アーカイブ」で見られます）">
                    アーカイブ
                  </button>
                </>
              )}
              {filter.archived === '1' && (
                <button className="btn btn-sm" onClick={() => bulk.mutate('unarchive')} disabled={bulk.isPending}>
                  アーカイブを解除
                </button>
              )}
              <button className="btn btn-sm text-slate-500" onClick={() => setSelected(new Set())}>
                選択解除
              </button>
            </>
          ) : (
            <span className="text-xs text-slate-400">チェックを付けると、まとめて対応済み・アーカイブにできます</span>
          )}
          {msg && <span className="ml-auto text-xs text-slate-600">{msg}</span>}
        </div>
      )}
      <div className="card p-0">
        {query.isLoading && <div className="p-4 text-slate-500">読み込み中…</div>}
        {query.data?.length === 0 && <div className="p-4 text-slate-500">会話はありません。設定画面で各チャネルを接続してください。</div>}
        <ul className="divide-y divide-slate-100">
          {query.data?.map((c) => (
            <li key={c.id} className={`flex items-start ${selected.has(c.id) ? 'bg-blue-50' : ''}`}>
              <label className="flex shrink-0 cursor-pointer items-center self-stretch px-2 md:px-3" title="選択">
                <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
              </label>
              <Link to={`/inbox/${c.id}`} className={`flex min-w-0 flex-1 items-start gap-3 py-3 pr-3 hover:bg-slate-50 md:pr-4 ${c.unread ? 'bg-blue-50/40' : ''}`}>
                <span className="hidden shrink-0 md:block">
                  <span className={`${channelBadge(c.channel)} mt-0.5 w-20 justify-center`}>{channelLabel(c.channel)}</span>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 md:hidden">
                      <span className={channelBadge(c.channel)}>{channelLabel(c.channel)}</span>
                    </span>
                    <span className={`min-w-0 truncate ${c.unread ? 'font-bold' : 'font-medium'}`}>{c.client?.name ?? c.counterpartName ?? c.counterpartAddress ?? '（不明）'}</span>
                    <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-slate-400">{fmtRelative(c.lastMessageAt)}</span>
                  </div>
                  {(!c.clientId || c.needsReply || c.unread > 0 || c.subject) && (
                    <div className="mt-0.5 flex items-center gap-2">
                      {!c.clientId && <span className="badge badge-orange shrink-0 whitespace-nowrap">未紐付け</span>}
                      {c.needsReply && <span className="badge badge-blue shrink-0 whitespace-nowrap">要返信</span>}
                      {c.unread > 0 && <span className="badge badge-blue shrink-0">{c.unread}</span>}
                      {c.subject && <span className="min-w-0 truncate text-xs text-slate-500">{c.subject}</span>}
                    </div>
                  )}
                  <div className="truncate text-sm text-slate-600">
                    {c.lastMessage?.direction === 'out' && <span className="text-slate-400">自分: </span>}
                    {c.lastMessage?.body}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
