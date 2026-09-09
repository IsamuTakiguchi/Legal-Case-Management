import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { ClientPicker } from '../lib/ClientPicker';
import { fmtDate, fmtRelative } from '../lib/format';
import { DeadlineEditor } from '../lib/Deadline';
import { TASK_STATUSES, TASK_STATUS_LABEL, type TaskStatus } from '@lcm/shared';
import { useSort, readingKey, type SortOption } from '../lib/sort';
import { Icon } from '../lib/icons';

interface Task {
  id: number;
  title: string;
  note: string | null;
  status: TaskStatus;
  clientId: number | null;
  clientName: string | null;
  caseId: number | null;
  caseTitle: string | null;
  conversationId: number | null;
  waitingSince: string | null;
  followUpAt: string | null;
  dueAt: string | null;
  chatworkTaskId: number | null;
  updatedAt: string;
}

/** 並べ替え。既定は「期限が早い順」（返信待ちはフォロー期限、対応中は期日。未設定は末尾） */
const deadlineOf = (t: Task) => (t.status === 'waiting_client' || t.status === 'waiting_other' ? (t.followUpAt ?? t.dueAt) : (t.dueAt ?? t.followUpAt)) ?? null;
const TASK_SORTS: SortOption<Task>[] = [
  { key: 'deadline', label: '期限が早い順', value: deadlineOf },
  { key: 'waiting', label: '待ちが長い順', value: (t) => t.waitingSince ?? null },
  { key: 'client', label: '依頼者のあいうえお順', value: (t) => (t.clientName ? readingKey(null, t.clientName) : null) },
  { key: 'title', label: 'タスク名', value: (t) => t.title },
  { key: 'updated', label: '更新が新しい順', value: (t) => t.updatedAt ?? null, desc: true },
];

type BulkAction = 'done' | 'open' | 'waiting_client' | 'waiting_other' | 'nudge' | 'delete';
const BULK_LABEL: Record<BulkAction, string> = {
  done: '完了にしました',
  open: '対応中に戻しました',
  waiting_client: '依頼者の返信待ちにしました',
  waiting_other: '相手方・裁判所待ちにしました',
  nudge: '催促済みにしました',
  delete: '削除しました',
};

export default function Tasks() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<string>(() => new URLSearchParams(location.search).get('status') ?? 'active');
  const [title, setTitle] = useState('');
  const [newStatus, setNewStatus] = useState<TaskStatus>('open');
  const [sync, setSync] = useState(false);
  const list = useQuery({ queryKey: ['tasks', status], queryFn: () => api.get<Task[]>(`/tasks?status=${status}`), refetchInterval: 60_000 });
  const sort = useSort('tasks', TASK_SORTS, 'deadline');
  const rows = sort.apply(list.data ?? []);
  const [clientId, setClientId] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [msg, setMsg] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['tasks'] });
  const toggle = (id: number, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allSelected = rows.length > 0 && rows.every((t) => selected.has(t.id));
  const bulk = useMutation({
    mutationFn: (action: BulkAction) => api.post<{ updated: number }>('/tasks/bulk', { ids: [...selected], action }),
    onSuccess: (r, action) => {
      setMsg(`${r.updated} 件を${BULK_LABEL[action]}`);
      setSelected(new Set());
      refresh();
    },
    onError: (e) => setMsg((e as Error).message),
  });
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
        <select className="input w-auto" value={sort.key} onChange={(e) => sort.setKey(e.target.value)} aria-label="並べ替え">
          {TASK_SORTS.map((o) => (
            <option key={o.key} value={o.key}>
              並べ替え: {o.label}
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
        <ClientPicker value={clientId} onChange={setClientId} emptyLabel="依頼者なし" selectClassName="w-48" />
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
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((t) => t.id)) : new Set())} /> すべて選択
        </label>
        {selected.size > 0 ? (
          <div className="fade-in flex flex-wrap items-center gap-1">
            <span className="text-slate-600">{selected.size} 件を選択中</span>
            <button className="btn btn-sm btn-primary" onClick={() => bulk.mutate('done')} disabled={bulk.isPending}>
              完了にする
            </button>
            <button className="btn btn-sm" onClick={() => bulk.mutate('open')} disabled={bulk.isPending}>
              対応中に戻す
            </button>
            <button className="btn btn-sm" onClick={() => bulk.mutate('waiting_client')} disabled={bulk.isPending}>
              依頼者待ちに
            </button>
            <button className="btn btn-sm" onClick={() => bulk.mutate('waiting_other')} disabled={bulk.isPending}>
              相手方待ちに
            </button>
            <button className="btn btn-sm" onClick={() => bulk.mutate('nudge')} disabled={bulk.isPending} title="返信待ちのタスクのフォロー期限を延ばします">
              催促した
            </button>
            <button className="btn btn-sm text-red-600" onClick={() => confirm(`${selected.size} 件のタスクを削除しますか？`) && bulk.mutate('delete')} disabled={bulk.isPending}>
              削除
            </button>
            <button className="btn btn-sm text-slate-500" onClick={() => setSelected(new Set())}>
              選択解除
            </button>
          </div>
        ) : (
          <span className="text-xs text-slate-400">チェックを付けると、まとめて完了・状態変更・催促済み・削除にできます</span>
        )}
        {msg && <span className="fade-in ml-auto text-xs text-slate-600">{msg}</span>}
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="w-px px-3 py-2"></th>
              <th className="px-3 py-2">状態</th>
              <th className="px-3 py-2">タスク</th>
              <th className="px-3 py-2">依頼者 / 事件</th>
              <th className="px-3 py-2">待ち開始 / フォロー期限</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const over = t.followUpAt && new Date(t.followUpAt).getTime() < now && t.status !== 'done' && t.status !== 'open';
              return (
                <tr key={t.id} className={`border-t border-slate-100 ${selected.has(t.id) ? 'bg-blue-50' : over ? 'bg-orange-50' : ''}`}>
                  <td className="w-px px-3 py-2">
                    <input type="checkbox" checked={selected.has(t.id)} onChange={(e) => toggle(t.id, e.target.checked)} aria-label="選択" />
                  </td>
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
                    {t.note && <TaskNote text={t.note} />}
                  </td>
                  <td className="max-w-[16rem] px-3 py-2">
                    {t.clientId && (
                      <Link to={`/clients/${t.clientId}`} className="block truncate text-[var(--accent)] hover:underline" title="依頼者ページを開く">
                        {t.clientName}
                      </Link>
                    )}
                    {t.caseId && (
                      <Link to={`/cases/${t.caseId}`} className="block truncate text-xs text-slate-500 hover:text-[var(--accent)] hover:underline" title="事件ページを開く">
                        <Icon name="scale" className="mr-0.5 inline h-3 w-3 align-[-1px]" />
                        {t.caseTitle ?? '事件'}
                      </Link>
                    )}
                  </td>
                  <td className="w-px whitespace-nowrap px-3 py-2 text-xs text-slate-600">
                    {t.waitingSince && <div>{fmtRelative(t.waitingSince)}から待ち</div>}
                    {t.status !== 'open' && t.status !== 'done' && <DeadlineEditor compact value={t.followUpAt} onChange={(iso) => update.mutate({ id: t.id, patch: { followUpAt: iso } })} />}
                    {t.dueAt && t.status === 'open' && <div>期日 {fmtDate(t.dueAt)}</div>}
                  </td>
                  <td className="w-px whitespace-nowrap px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      {t.conversationId && (
                        <Link to={`/inbox/${t.conversationId}`} className="btn btn-sm" title="このタスクの元になった会話を開きます">
                          {t.status === 'waiting_client' || t.status === 'waiting_other' ? '催促文を作成' : '会話を開く'}
                        </Link>
                      )}
                      {(t.status === 'waiting_client' || t.status === 'waiting_other') && (
                        <button className="btn btn-sm" onClick={() => nudge.mutate(t.id)}>
                          催促した
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {list.data?.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-4 text-slate-500">
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

/** タスクのメモ。短ければ全文、長文（目安 300 字 or 8 行超）は折りたたんで「続きを表示」で開く */
function TaskNote({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 300 || text.split('\n').length > 8;
  return (
    <div className="text-xs text-slate-500">
      <div className={`whitespace-pre-wrap ${long && !open ? 'line-clamp-4' : ''}`}>{text}</div>
      {long && (
        <button type="button" className="mt-0.5 text-blue-700 hover:underline" onClick={() => setOpen(!open)}>
          {open ? '折りたたむ' : '続きを表示'}
        </button>
      )}
    </div>
  );
}
