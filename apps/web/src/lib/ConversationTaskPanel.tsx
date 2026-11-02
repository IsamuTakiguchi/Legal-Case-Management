import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { NEW_TASK_STATUSES, TASK_STATUS_LABEL, isWaitingStatus } from '@lcm/shared';
import { api } from './api';

interface DraftTask {
  title: string;
  due: string;
  replyBy: string;
  status: string;
  note: string;
  use: boolean;
}

interface Suggestion {
  tasks: { title: string; due: string | null; replyBy?: string | null; status: string; note: string }[];
  comment: string;
  cases: { id: number; title: string }[];
  defaultCaseId: number | null;
}

const EMPTY_DRAFT: DraftTask = { title: '', due: '', replyBy: '', status: 'open', note: '', use: true };

/**
 * 会話のやり取りから、追いかけるタスクを登録する。
 * 開くと AI がタスクの案（題名・状態・締切・返信期限・メモ）を作り、直してから登録する。AI が使えなくても手で書いて登録できる
 */
export function ConversationTaskPanel({ conversationId, onClose, onDone }: { conversationId: number; onClose: () => void; onDone: (msg: string) => void }) {
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<DraftTask[] | null>(null);
  const [comment, setComment] = useState('');
  const [cases, setCases] = useState<{ id: number; title: string }[]>([]);
  const [caseId, setCaseId] = useState('');
  const [sync, setSync] = useState(false);
  const [msg, setMsg] = useState('');
  const suggest = useMutation({
    mutationFn: () => api.post<Suggestion>(`/conversations/${conversationId}/task-suggestions`),
    onSuccess: (r) => {
      setDrafts(r.tasks.length ? r.tasks.map((t) => ({ title: t.title, due: t.due ?? '', replyBy: t.replyBy ?? '', status: t.status, note: t.note ?? '', use: true })) : [{ ...EMPTY_DRAFT }]);
      setComment(r.comment ?? '');
      setCases(r.cases);
      setCaseId(r.defaultCaseId ? String(r.defaultCaseId) : '');
      setMsg(r.tasks.length ? '' : 'やり取りからは、タスクにするものが見当たりませんでした。必要なら題名を書いて登録できます');
    },
    onError: (e) => {
      // AI が使えないときも、手で書いて登録できるようにする
      setDrafts((prev) => prev ?? [{ ...EMPTY_DRAFT }]);
      setMsg(`案を作れませんでした（${(e as Error).message}）。題名を書いて登録できます`);
    },
  });
  // 開いたらまず案を出す
  useEffect(() => {
    suggest.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setDraft = (i: number, patch: Partial<DraftTask>) => setDrafts((prev) => (prev ?? []).map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const chosen = (drafts ?? []).filter((d) => d.use && d.title.trim());
  const create = useMutation({
    mutationFn: () =>
      api.post<{ tasks: { id: number; title: string }[] }>(`/conversations/${conversationId}/tasks`, {
        caseId: caseId ? Number(caseId) : null,
        syncToChatwork: sync,
        tasks: chosen.map((d) => ({ title: d.title.trim(), due: d.due || null, replyBy: isWaitingStatus(d.status) ? d.replyBy || null : null, status: d.status, note: d.note.trim() || null })),
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      onDone(`${r.tasks.map((t) => `「${t.title}」`).join('、')} をタスクにしました`);
    },
    onError: (e) => setMsg((e as Error).message),
  });
  return (
    <section className="fade-in card space-y-2 border-blue-200 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">会話からタスクを登録</h3>
        <button className="btn btn-sm" onClick={() => suggest.mutate()} disabled={suggest.isPending}>
          {suggest.isPending ? '読み取り中…' : 'AI で作り直す'}
        </button>
        <button className="btn btn-sm ml-auto" onClick={onClose}>
          閉じる
        </button>
      </div>
      <div className="text-xs text-slate-500">
        {suggest.isPending ? 'やり取りから、頼まれたこと・約束したこと・返事を待っていることを読み取っています…' : 'やり取りから作った案です。題名・状態・期限を直してから登録できます'}
      </div>
      {drafts && (
        <>
          {drafts.map((dft, i) => (
            <div key={i} className={`space-y-1 rounded border p-2 ${dft.use ? 'border-blue-200 bg-white' : 'border-slate-100 opacity-60'}`}>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={dft.use} onChange={(e) => setDraft(i, { use: e.target.checked })} aria-label="このタスクを登録する" />
                <input className="input min-w-0 flex-1" value={dft.title} onChange={(e) => setDraft(i, { title: e.target.value })} placeholder="タスク名（例: 戸籍謄本の取り寄せ）" aria-label="タスク名" />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <select className="input w-auto py-0.5" value={dft.status} onChange={(e) => setDraft(i, { status: e.target.value })} aria-label="状態">
                  {NEW_TASK_STATUSES.map((st) => (
                    <option key={st} value={st}>
                      {TASK_STATUS_LABEL[st]}
                    </option>
                  ))}
                </select>
                {isWaitingStatus(dft.status) && (
                  <label className="flex items-center gap-1" title="返事をいつまで待つか。空なら設定の営業日数後">
                    返信期限 <input type="date" className="input w-auto py-0.5" value={dft.replyBy} onChange={(e) => setDraft(i, { replyBy: e.target.value })} aria-label="返信期限" />
                  </label>
                )}
                <label className="flex items-center gap-1" title="そのタスク自体の締切。空ならなし">
                  締切 <input type="date" className="input w-auto py-0.5" value={dft.due} onChange={(e) => setDraft(i, { due: e.target.value })} aria-label="締切" />
                </label>
                <button className="text-slate-400 hover:text-red-600" onClick={() => setDrafts((prev) => (prev ?? []).filter((_, j) => j !== i))}>
                  この案を消す
                </button>
              </div>
              <input className="input text-xs" value={dft.note} onChange={(e) => setDraft(i, { note: e.target.value })} placeholder="メモ（背景・頼まれた内容など）" aria-label="メモ" />
            </div>
          ))}
          <button className="text-xs text-blue-700 hover:underline" onClick={() => setDrafts((prev) => [...(prev ?? []), { ...EMPTY_DRAFT }])}>
            ＋ タスクを追加
          </button>
          {comment && <div className="text-xs text-slate-500">{comment}</div>}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {cases.length > 0 && (
              <label className="flex w-full min-w-0 items-center gap-1 sm:w-auto">
                <span className="shrink-0">事件</span>
                <select className="input w-full min-w-0 py-0.5 sm:w-auto" value={caseId} onChange={(e) => setCaseId(e.target.value)} aria-label="タスクを付ける事件">
                  <option value="">（事件に付けない）</option>
                  {cases.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> 担当事務局の Chatwork タスクにも登録
            </label>
            <button className="btn btn-primary btn-sm ml-auto" disabled={create.isPending || chosen.length === 0} onClick={() => create.mutate()}>
              {create.isPending ? '登録中…' : chosen.length > 1 ? `${chosen.length} 件をタスクにする` : 'タスクにする'}
            </button>
          </div>
        </>
      )}
      {msg && <div className="fade-in text-xs text-slate-700">{msg}</div>}
      <div className="text-xs text-slate-400">作ったタスクは、この会話・依頼者・事件に紐付きます。返信待ちのタスクは、この会話に返事が届くと知らせます。</div>
    </section>
  );
}
