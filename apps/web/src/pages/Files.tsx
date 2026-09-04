import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { channelBadge, channelLabel, fmtDateTime, fmtBytes } from '../lib/format';

interface Att {
  id: number;
  filename: string;
  size: number | null;
  status: string;
  storedPath: string | null;
  error: string | null;
  clientId: number | null;
  createdAt: string;
  message: { id: number; conversationId: number; channel: string; senderName: string | null; sentAt: string; body: string };
}

const STATUS_LABEL: Record<string, string> = { pending: '保存中', stored: '保存済', unassigned: '振り分け待ち', failed: '失敗' };

export default function Files() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const list = useQuery({ queryKey: ['attachments', status], queryFn: () => api.get<Att[]>(`/attachments${status ? `?status=${status}` : ''}`) });
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => api.get<{ id: number; name: string }[]>('/clients') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['attachments'] });
  const assign = useMutation({ mutationFn: (v: { id: number; clientId: number }) => api.post(`/attachments/${v.id}/assign`, { clientId: v.clientId }), onSuccess: refresh });
  const retry = useMutation({ mutationFn: (id: number) => api.post(`/attachments/${id}/retry`), onSuccess: refresh });
  const [pick, setPick] = useState<Record<number, string>>({});
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-bold">受信ファイル</h1>
        <select className="input ml-auto w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">すべて</option>
          <option value="unassigned">振り分け待ち</option>
          <option value="failed">失敗</option>
          <option value="stored">保存済</option>
        </select>
      </div>
      <div className="card p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2">ファイル</th>
              <th className="px-3 py-2">受信元</th>
              <th className="px-3 py-2">状態</th>
              <th className="px-3 py-2">保存先</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((a) => (
              <tr key={a.id} className="border-t border-slate-100">
                <td className="px-3 py-2">
                  {a.status === 'stored' ? (
                    <a className="font-medium text-blue-700 hover:underline" href={`/api/attachments/${a.id}/download`}>
                      {a.filename}
                    </a>
                  ) : (
                    <span className="font-medium">{a.filename}</span>
                  )}
                  <div className="text-xs text-slate-400">{fmtBytes(a.size)}</div>
                </td>
                <td className="px-3 py-2 text-xs">
                  <span className={channelBadge(a.message.channel)}>{channelLabel(a.message.channel)}</span> {a.message.senderName ?? ''}
                  <div className="text-slate-400">{fmtDateTime(a.message.sentAt)}</div>
                  <Link to={`/inbox/${a.message.conversationId}`} className="text-blue-700 hover:underline">
                    会話を開く
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <span className={`badge ${a.status === 'stored' ? 'badge-gray' : a.status === 'failed' ? 'badge-chatwork' : 'badge-orange'}`}>{STATUS_LABEL[a.status] ?? a.status}</span>
                  {a.error && <div className="line-clamp-2 text-xs text-red-600">{a.error}</div>}
                </td>
                <td className="px-3 py-2 text-xs text-slate-600">{a.storedPath}</td>
                <td className="px-3 py-2">
                  {(a.status === 'unassigned' || a.status === 'failed') && (
                    <div className="flex items-center gap-1">
                      <select className="input w-40 py-0.5 text-xs" value={pick[a.id] ?? ''} onChange={(e) => setPick({ ...pick, [a.id]: e.target.value })}>
                        <option value="">依頼者…</option>
                        {clients.data?.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <button className="btn btn-primary btn-sm" disabled={!pick[a.id]} onClick={() => assign.mutate({ id: a.id, clientId: Number(pick[a.id]) })}>
                        移動
                      </button>
                      {a.status === 'failed' && (
                        <button className="btn btn-sm" onClick={() => retry.mutate(a.id)}>
                          再取得
                        </button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {list.data?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-4 text-slate-500">
                  ファイルはありません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
