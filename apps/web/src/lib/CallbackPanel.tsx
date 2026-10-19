import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from './api';
import { fmtDateTime } from './format';
import { NoteComposer } from './NoteComposer';

interface CallbackCtx {
  taskId: number;
  title: string;
  message: string;
  from: string | null;
  receivedAt: string;
  phones: { number: string; who: string | null }[];
  callerName: string | null;
  callerPhone?: string | null;
  clientName: string | null;
  cases: { id: number; title: string; clientName: string | null }[];
  defaultCaseId: number | null;
}

/**
 * 電話の伝言（事務局から振られたタスク）を見ながら折り返し電話をして、そのやり取りを事件の記録に残す。
 * 伝言・番号（タップで発信）を上に出し、その下で通話の内容を走り書き → AI で整理 → 記録として保存する
 */
export function CallbackPanel({ taskId, onClose, onSaved }: { taskId: number; onClose: () => void; onSaved: (msg: string) => void }) {
  const ctx = useQuery({ queryKey: ['task-callback', taskId], queryFn: () => api.get<CallbackCtx>(`/tasks/${taskId}/callback`) });
  // 候補に無い事件を選ぶとき（進行中の事件の一覧から）
  const [showAll, setShowAll] = useState(false);
  const all = useQuery({ queryKey: ['cases', 'open'], queryFn: () => api.get<{ id: number; title: string; clientName: string }[]>('/cases?status=open'), enabled: showAll });
  const [caseId, setCaseId] = useState('');
  const d = ctx.data;
  useEffect(() => {
    if (!d) return;
    setCaseId(d.defaultCaseId ? String(d.defaultCaseId) : '');
    if (!d.cases.length) setShowAll(true);
  }, [d]);
  const options = [...(d?.cases ?? []), ...(showAll ? (all.data ?? []).filter((c) => !d?.cases.some((x) => x.id === c.id)) : [])];
  return (
    <section className="fade-in card space-y-3 border-green-200 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">📞 折り返し電話</h3>
        <button className="btn btn-sm ml-auto" onClick={onClose}>
          閉じる
        </button>
      </div>
      {ctx.isLoading && <div className="loading-text text-slate-500">読み込み中…</div>}
      {ctx.error && <div className="text-xs text-red-600">{(ctx.error as Error).message}</div>}
      {d && (
        <>
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2">
            <div className="mb-1 text-xs text-slate-500">
              伝言{d.from ? `（${d.from}さんから・${fmtDateTime(d.receivedAt)}）` : `（${fmtDateTime(d.receivedAt)}）`}
            </div>
            <div className="whitespace-pre-wrap break-words">{d.message}</div>
          </div>
          {d.phones.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {d.phones.map((p) => (
                // スマホならタップでそのまま発信できる
                <a key={p.number} href={`tel:${p.number.replace(/[^\d+]/g, '')}`} className="btn btn-sm" title="タップで発信（スマホ）">
                  📞 {p.number}
                  {p.who && <span className="ml-1 text-xs text-slate-500">{p.who}</span>}
                </a>
              ))}
            </div>
          )}
          <label className="flex w-full min-w-0 flex-wrap items-center gap-1">
            <span className="shrink-0 whitespace-nowrap">記録する事件</span>
            <select className="input w-full min-w-0 sm:w-auto sm:flex-1" value={caseId} onChange={(e) => setCaseId(e.target.value)}>
              <option value="">（事件を選んでください）</option>
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.clientName ? `${c.clientName}：` : ''}
                  {c.title}
                </option>
              ))}
            </select>
            {!showAll && (
              <button className="btn btn-sm" onClick={() => setShowAll(true)} title="候補に無ければ、進行中の事件から選べます">
                ほかの事件
              </button>
            )}
            {caseId && (
              <Link to={`/cases/${caseId}`} className="text-xs text-blue-700 hover:underline">
                事件を開く
              </Link>
            )}
          </label>
          <NoteComposer
            caseId={Number(caseId) || 0}
            callback={{ taskId, context: d.message, counterpart: d.callerName ?? d.clientName, phone: d.callerPhone ?? d.phones[0]?.number ?? null }}
            onSaved={(_note, extra) => onSaved(extra?.taskStatus === 'done' ? '折り返しを記録し、タスクを完了にしました' : '折り返しを記録しました')}
          />
        </>
      )}
    </section>
  );
}
