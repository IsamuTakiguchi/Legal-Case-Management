import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useState } from 'react';
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
  const filter = { channel: params.get('channel') ?? '', needsReply: params.get('needsReply') ?? '', unlinked: params.get('unlinked') ?? '', q: params.get('q') ?? '', archived: params.get('archived') ?? '' };
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
      <div className="card p-0">
        {query.isLoading && <div className="p-4 text-slate-500">読み込み中…</div>}
        {query.data?.length === 0 && <div className="p-4 text-slate-500">会話はありません。設定画面で各チャネルを接続してください。</div>}
        <ul className="divide-y divide-slate-100">
          {query.data?.map((c) => (
            <li key={c.id}>
              <Link to={`/inbox/${c.id}`} className={`flex items-start gap-3 px-3 py-3 hover:bg-slate-50 md:px-4 ${c.unread ? 'bg-blue-50/40' : ''}`}>
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
