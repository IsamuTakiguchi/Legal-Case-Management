import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDate, fmtRelative, toLocalInput, fromLocalInput } from '../lib/format';
import { TASK_STATUSES, TASK_STATUS_LABEL, type TaskStatus } from '@lcm/shared';

interface Task {
  id: number;
  title: string;
  note: string | null;
  status: TaskStatus;
  clientId: number | null;
  clientName: string | null;
  caseId: number | null;
  conversationId: number | null;
  waitingSince: string | null;
  followUpAt: string | null;
  dueAt: string | null;
  chatworkTaskId: number | null;
  updatedAt: string;
}

export default function Tasks() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<string>('active');
  const [title, setTitle] = useState('');
  const [newStatus, setNewStatus] = useState<TaskStatus>('open');
  const [sync, setSync] = useState(false);
  const list = useQuery({ queryKey: ['tasks', status], queryFn: () => api.get<Task[]>(`/tasks?status=${status}`), refetchInterval: 60_000 });
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => api.get<{ id: number; name: string }[]>('/clients') });
  const [clientId, setClientId] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['tasks'] });
  const create = useMutation({
    mutationFn: () => api.post('/tasks', { title, status: newStatus, clientId: clientId ? Number(clientId) : null, syncToChatwork: sync }),
    onSuccess: () => {
      setTitle('');
      refresh();
    },
  });
  const update = useMutation({ mutationFn: (v: { id: number; patch: Record<string, unknown> }) => api.put(`/tasks/${v.id}`, v.patch), onSuccess: refresh });
  const nudge = useMutation({ mutationFn: (id: number) => api.post(`/tasks/${id}/nudge`), onSuccess: refresh });
  const importCw = useMutation({ mutationFn: () => api.post<{ imported: number; completed: number }>('/tasks/import-chatwork'), onSuccess: refresh });
  const now = Date.now();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">タスク・返信待ち</h1>
        <select className="input ml-auto w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">未完了</option>
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {TASK_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <button className="btn btn-sm" onClick={() => importCw.mutate()} disabled={importCw.isPending}>
          Chatwork のタスクを取込
        </button>
        {importCw.data && <span className="text-xs text-slate-500">取込 {importCw.data.imported} / 完了反映 {importCw.data.completed}</span>}
      </div>
      <form
        className="card flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <input className="input flex-1" placeholder="新しいタスク" value={title} onChange={(e) => setTitle(e.target.value)} required />
        <select className="input w-auto" value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">依頼者なし</option>
          {clients.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select className="input w-auto" value={newStatus} onChange={(e) => setNewStatus(e.target.value as TaskStatus)}>
          {TASK_STATUSES.filter((s) => s !== 'done').map((s) => (
            <option key={s} value={s}>
              {TASK_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> Chatwork にも作成
        </label>
        <button className="btn btn-primary">追加</button>
      </form>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2">状態</th>
              <th className="px-3 py-2">タスク</th>
              <th className="px-3 py-2">依頼者</th>
              <th className="px-3 py-2">待ち開始 / フォロー期限</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((t) => {
              const over = t.followUpAt && new Date(t.followUpAt).getTime() < now && t.status !== 'done' && t.status !== 'open';
              return (
                <tr key={t.id} className={`border-t border-slate-100 ${over ? 'bg-orange-50' : ''}`}>
                  <td className="w-px whitespace-nowrap px-3 py-2">
                    <select className="input w-auto py-0.5 text-xs" value={t.status} onChange={(e) => update.mutate({ id: t.id, patch: { status: e.target.value } })}>
                      {TASK_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {TASK_STATUS_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="min-w-[14rem] px-3 py-2">
                    {t.conversationId ? (
                      <Link to={`/inbox/${t.conversationId}`} className="font-medium hover:underline">
                        {t.title}
                      </Link>
                    ) : (
                      <span className="font-medium">{t.title}</span>
                    )}
                    {t.chatworkTaskId && <span className="badge badge-chatwork ml-1">CW</span>}
                    {t.note && <div className="line-clamp-1 text-xs text-slate-500">{t.note}</div>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{t.clientId ? <Link to={`/clients/${t.clientId}`} className="hover:underline">{t.clientName}</Link> : ''}</td>
                  <td className="w-px whitespace-nowrap px-3 py-2 text-xs text-slate-600">
                    {t.waitingSince && <div>{fmtRelative(t.waitingSince)}から待ち</div>}
                    {t.status !== 'open' && t.status !== 'done' && (
                      <div className="flex flex-wrap items-center gap-1">
                        <span className={over ? 'font-semibold text-orange-600' : ''}>期限 {fmtDate(t.followUpAt)}</span>
                        <input type="datetime-local" className="input w-auto py-0 text-xs" value={toLocalInput(t.followUpAt)} onChange={(e) => update.mutate({ id: t.id, patch: { followUpAt: fromLocalInput(e.target.value) } })} />
                      </div>
                    )}
                    {t.dueAt && t.status === 'open' && <div>期日 {fmtDate(t.dueAt)}</div>}
                  </td>
                  <td className="w-px whitespace-nowrap px-3 py-2 text-right">
                    {(t.status === 'waiting_client' || t.status === 'waiting_other') && (
                      <div className="flex justify-end gap-1">
                        {t.conversationId && (
                          <Link to={`/inbox/${t.conversationId}`} className="btn btn-sm">
                            催促文を作成
                          </Link>
                        )}
                        <button className="btn btn-sm" onClick={() => nudge.mutate(t.id)}>
                          催促した
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {list.data?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-4 text-slate-500">
                  タスクはありません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
