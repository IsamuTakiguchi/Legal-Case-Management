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

const STATUS_LABEL: Record<string, string> = { pending: '保存中', stored: '保存済', unassigned: '振り分け待ち', held: '未保存', failed: '失敗', ignored: '不要' };
const STATUS_BADGE: Record<string, string> = { stored: 'badge-gray', failed: 'badge-chatwork', ignored: 'badge-gray', held: 'badge-blue', unassigned: 'badge-orange', pending: 'badge-orange' };

export default function Files() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('held');
  const [channel, setChannel] = useState('');
  const list = useQuery({ queryKey: ['attachments', status, channel], queryFn: () => api.get<Att[]>(`/attachments?status=${status}&channel=${channel}`) });
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => api.get<{ id: number; name: string }[]>('/clients') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['attachments'] });
  const [msg, setMsg] = useState('');
  const assign = useMutation({ mutationFn: (v: { id: number; clientId: number }) => api.post(`/attachments/${v.id}/assign`, { clientId: v.clientId }), onSuccess: refresh, onError: (e) => setMsg((e as Error).message) });
  const save = useMutation({ mutationFn: (v: { id: number; clientId?: number | null }) => api.post(`/attachments/${v.id}/save`, { clientId: v.clientId ?? null }), onSuccess: refresh, onError: (e) => setMsg((e as Error).message) });
  const ignore = useMutation({ mutationFn: (id: number) => api.post(`/attachments/${id}/ignore`), onSuccess: refresh, onError: (e) => setMsg((e as Error).message) });
  const retry = useMutation({ mutationFn: (id: number) => api.post(`/attachments/${id}/retry`), onSuccess: refresh });
  const [pick, setPick] = useState<Record<number, string>>({});
  const clientName = (id: number | null) => clients.data?.find((c) => c.id === id)?.name ?? null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">受信ファイル</h1>
        <select className="input ml-auto w-auto" value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="">全チャネル</option>
          <option value="line">LINE公式</option>
          <option value="chatwork">Chatwork</option>
          <option value="gmail">Gmail</option>
        </select>
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="held">未保存（保存するか選ぶ）</option>
          <option value="unassigned">振り分け待ち</option>
          <option value="failed">失敗</option>
          <option value="stored">保存済</option>
          <option value="ignored">不要にしたもの</option>
          <option value="">すべて</option>
        </select>
      </div>
      {status === 'held' && (
        <p className="text-xs text-slate-500">
          受信したままで OneDrive には保存していないファイルです。必要なものだけ「保存」を押してください（依頼者が分かっている会話なら、その依頼者の受領資料フォルダに入ります）。要らないものは「不要」で一覧から外れます。LINE の画像・ファイルは LINE 側の保持期間が短いため、受信時にアプリ内へ控えを取ってあります。設定 → 基本設定 → 「受信ファイルの扱い」で自動保存の範囲を変えられます。
        </p>
      )}
      {msg && <div className="text-xs text-red-600">{msg}</div>}
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
                  {a.status !== 'ignored' ? (
                    <a className="font-medium text-blue-700 hover:underline" href={`/api/attachments/${a.id}/download`} title={a.status === 'stored' ? 'OneDrive から取得' : '保存せずに中身を取得'}>
                      {a.filename}
                    </a>
                  ) : (
                    <span className="font-medium text-slate-500">{a.filename}</span>
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
                  <span className={`badge ${STATUS_BADGE[a.status] ?? 'badge-gray'}`}>{STATUS_LABEL[a.status] ?? a.status}</span>
                  {a.clientId && a.status !== 'stored' && <div className="text-xs text-slate-500">依頼者: {clientName(a.clientId) ?? a.clientId}</div>}
                  {a.error && <div className="line-clamp-2 text-xs text-red-600">{a.error}</div>}
                </td>
                <td className="px-3 py-2 text-xs text-slate-600">{a.storedPath}</td>
                <td className="px-3 py-2">
                  {(a.status === 'held' || a.status === 'unassigned' || a.status === 'failed') && (
                    <div className="flex flex-wrap items-center gap-1">
                      {a.status === 'held' && a.clientId && (
                        <button className="btn btn-primary btn-sm" onClick={() => save.mutate({ id: a.id })} disabled={save.isPending}>
                          {clientName(a.clientId) ?? '依頼者'} のフォルダに保存
                        </button>
                      )}
                      <select className="input w-40 py-0.5 text-xs" value={pick[a.id] ?? ''} onChange={(e) => setPick({ ...pick, [a.id]: e.target.value })}>
                        <option value="">{a.status === 'held' && a.clientId ? '別の依頼者…' : '依頼者を選ぶ…'}</option>
                        {clients.data?.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <button className="btn btn-sm" disabled={!pick[a.id]} onClick={() => (a.status === 'unassigned' ? assign : save).mutate({ id: a.id, clientId: Number(pick[a.id]) })}>
                        {a.status === 'unassigned' ? '移動' : '保存'}
                      </button>
                      {a.status === 'failed' && (
                        <button className="btn btn-sm" onClick={() => retry.mutate(a.id)}>
                          再取得
                        </button>
                      )}
                      <button className="btn btn-sm text-slate-500" onClick={() => ignore.mutate(a.id)} disabled={ignore.isPending} title="保存せずに一覧から外す">
                        不要
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {list.data?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-4 text-slate-500">
                  {status === 'held' ? '未保存のファイルはありません' : 'ファイルはありません'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
