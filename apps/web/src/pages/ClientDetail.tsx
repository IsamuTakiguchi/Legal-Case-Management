import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { channelBadge, channelLabel, fmtDateTime, fmtBytes } from '../lib/format';
import { ClientForm, type ClientRow } from './Clients';
import { EVENT_KIND_LABEL, TASK_STATUS_LABEL, type EventKind, type TaskStatus } from '@lcm/shared';
import { CaseStatusBadge } from './Cases';

interface Detail extends ClientRow {
  folder: string;
  cases: { id: number; title: string; caseTypeLabel: string; status: string; nextHearingAt: string | null; stage: string | null }[];
  conversations: { id: number; channel: string; subject: string | null; lastMessageAt: string | null; needsReply: boolean }[];
  tasks: { id: number; title: string; status: string; followUpAt: string | null }[];
  events: { id: number; title: string; startAt: string; kind: string }[];
}

export default function ClientDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const [edit, setEdit] = useState(false);
  const [newCase, setNewCase] = useState(false);
  const [sub, setSub] = useState('');
  const d = useQuery({ queryKey: ['client', id], queryFn: () => api.get<Detail>(`/clients/${id}`) });
  const files = useQuery({ queryKey: ['client-files', id, sub], queryFn: () => api.get<{ folder: string; items: { name: string; path: string; isFolder: boolean; size?: number; modifiedAt?: string; webUrl?: string }[] }>(`/clients/${id}/files?path=${encodeURIComponent(sub)}`), retry: false });
  const types = useQuery({ queryKey: ['case-types'], queryFn: () => api.get<{ key: string; label: string }[]>('/case-types') });
  const update = useMutation({
    mutationFn: (b: Partial<ClientRow>) => api.put(`/clients/${id}`, b),
    onSuccess: () => {
      setEdit(false);
      qc.invalidateQueries({ queryKey: ['client', id] });
    },
  });
  const [caseForm, setCaseForm] = useState({ title: '', caseType: 'general_civil', courtName: '', caseNumber: '' });
  const createCase = useMutation({
    mutationFn: () => api.post<{ id: number }>('/cases', { ...caseForm, clientId: Number(id) }),
    onSuccess: () => {
      setNewCase(false);
      qc.invalidateQueries({ queryKey: ['client', id] });
    },
  });
  const c = d.data;
  if (!c) return <div className="text-slate-500">読み込み中…</div>;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link to="/clients" className="text-sm text-slate-500 hover:underline">
          ← 依頼者
        </Link>
        <h1 className="text-xl font-bold">{c.name}</h1>
        {c.kana && <span className="text-sm text-slate-500">{c.kana}</span>}
        <button className="btn btn-sm ml-auto" onClick={() => setEdit(!edit)}>
          編集
        </button>
      </div>
      {edit && <ClientForm initial={c} onSubmit={(b) => update.mutate(b)} onCancel={() => setEdit(false)} busy={update.isPending} />}
      <div className="grid gap-4 md:grid-cols-2">
        <section className="card">
          <div className="mb-2 flex items-center">
            <h2 className="font-semibold">事件</h2>
            <button className="btn btn-sm ml-auto" onClick={() => setNewCase(!newCase)}>
              ＋ 事件を追加
            </button>
          </div>
          {newCase && (
            <form
              className="mb-3 grid gap-2 rounded border border-slate-200 p-2 text-sm md:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                createCase.mutate();
              }}
            >
              <input className="input md:col-span-2" placeholder="事件名（例: 山田 離婚調停）" required value={caseForm.title} onChange={(e) => setCaseForm({ ...caseForm, title: e.target.value })} />
              <select className="input" value={caseForm.caseType} onChange={(e) => setCaseForm({ ...caseForm, caseType: e.target.value })}>
                {types.data?.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
              <input className="input" placeholder="裁判所" value={caseForm.courtName} onChange={(e) => setCaseForm({ ...caseForm, courtName: e.target.value })} />
              <input className="input" placeholder="事件番号" value={caseForm.caseNumber} onChange={(e) => setCaseForm({ ...caseForm, caseNumber: e.target.value })} />
              <button className="btn btn-primary">作成</button>
            </form>
          )}
          <ul className="space-y-1 text-sm">
            {c.cases.map((k) => (
              <li key={k.id} className="flex items-center gap-2">
                <Link to={`/cases/${k.id}`} className="text-blue-700 hover:underline">
                  {k.title}
                </Link>
                <CaseStatusBadge status={k.status} />
                <span className="badge badge-gray">{k.caseTypeLabel}</span>
                {k.stage && <span className="text-xs text-slate-500">{k.stage}</span>}
                {k.nextHearingAt && <span className="ml-auto text-xs text-slate-500">次回 {fmtDateTime(k.nextHearingAt)}</span>}
              </li>
            ))}
            {c.cases.length === 0 && <li className="text-slate-500">事件は未登録です</li>}
          </ul>
        </section>
        <section className="card">
          <h2 className="mb-2 font-semibold">会話</h2>
          <ul className="space-y-1 text-sm">
            {c.conversations.map((v) => (
              <li key={v.id} className="flex items-center gap-2">
                <span className={channelBadge(v.channel)}>{channelLabel(v.channel)}</span>
                <Link to={`/inbox/${v.id}`} className="truncate hover:underline">
                  {v.subject ?? '（件名なし）'}
                </Link>
                {v.needsReply && <span className="badge badge-blue">要返信</span>}
                <span className="ml-auto shrink-0 text-xs text-slate-500">{fmtDateTime(v.lastMessageAt)}</span>
              </li>
            ))}
            {c.conversations.length === 0 && <li className="text-slate-500">まだやり取りがありません</li>}
          </ul>
        </section>
        <section className="card">
          <h2 className="mb-2 font-semibold">タスク</h2>
          <ul className="space-y-1 text-sm">
            {c.tasks
              .filter((t) => t.status !== 'done')
              .map((t) => (
                <li key={t.id} className="flex items-center gap-2">
                  <span>{t.title}</span>
                  <span className="badge badge-gray">{TASK_STATUS_LABEL[t.status as TaskStatus]}</span>
                </li>
              ))}
          </ul>
        </section>
        <section className="card">
          <h2 className="mb-2 font-semibold">予定</h2>
          <ul className="space-y-1 text-sm">
            {c.events.map((e) => (
              <li key={e.id} className="flex items-center gap-2">
                <span className="w-32 text-slate-500">{fmtDateTime(e.startAt)}</span>
                <span className="badge badge-gray">{EVENT_KIND_LABEL[e.kind as EventKind]}</span>
                <span>{e.title}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card md:col-span-2">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="font-semibold">依頼者フォルダ</h2>
            <span className="text-xs text-slate-500">{files.data?.folder ?? c.folder}</span>
            {sub && (
              <button className="btn btn-sm" onClick={() => setSub(sub.split('/').slice(0, -1).join('/'))}>
                ↑ 上へ
              </button>
            )}
          </div>
          {files.error && <div className="text-sm text-red-600">{(files.error as Error).message}</div>}
          <table className="w-full text-sm">
            <tbody>
              {files.data?.items.map((f) => (
                <tr key={f.path} className="border-t border-slate-100">
                  <td className="py-1">
                    {f.isFolder ? (
                      <button className="text-blue-700 hover:underline" onClick={() => setSub(sub ? `${sub}/${f.name}` : f.name)}>
                        📁 {f.name}
                      </button>
                    ) : f.webUrl ? (
                      <a href={f.webUrl} target="_blank" rel="noreferrer" className="hover:underline">
                        📄 {f.name}
                      </a>
                    ) : (
                      <span>📄 {f.name}</span>
                    )}
                  </td>
                  <td className="py-1 text-right text-xs text-slate-500">{fmtBytes(f.size)}</td>
                  <td className="py-1 text-right text-xs text-slate-500">{fmtDateTime(f.modifiedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
