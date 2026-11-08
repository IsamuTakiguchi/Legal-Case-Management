import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { NEW_TASK_STATUSES, TASK_STATUS_LABEL, isWaitingStatus } from '@lcm/shared';
import { api } from './api';

/**
 * 受け取ったメッセージ 1 通を、そのままタスクにする欄（メール・LINE・Chatwork 共通）。
 * 題名はメールなら件名、それ以外は本文の最初の行を入れておき、直してから登録する。本文はタスクのメモに残る
 */
export function MessageTaskForm({
  messageId,
  defaultTitle,
  cases = [],
  defaultCaseId = null,
  onClose,
  onDone,
}: {
  messageId: number;
  defaultTitle: string;
  /** この会話の事件（2 件以上あれば、どの事件のタスクかを選べる） */
  cases?: { id: number; title: string }[];
  defaultCaseId?: number | null;
  onClose?: () => void;
  onDone: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(defaultTitle.slice(0, 120));
  const [status, setStatus] = useState<string>('open');
  const [due, setDue] = useState('');
  const [replyBy, setReplyBy] = useState('');
  const [caseId, setCaseId] = useState(defaultCaseId ? String(defaultCaseId) : '');
  const [sync, setSync] = useState(false);
  const [err, setErr] = useState('');
  const task = useMutation({
    mutationFn: () =>
      api.post<{ id: number; title: string }>(`/messages/${messageId}/task`, {
        title: title.trim(),
        status,
        due: due || null,
        replyBy: isWaitingStatus(status) ? replyBy || null : null,
        syncToChatwork: sync,
        ...(cases.length >= 2 ? { caseId: caseId ? Number(caseId) : null } : {}),
      }),
    onSuccess: (r) => {
      setErr('');
      qc.invalidateQueries({ queryKey: ['tasks'] });
      onDone(`「${r.title}」をタスクにしました`);
    },
    onError: (e) => setErr((e as Error).message),
  });
  return (
    <div className="fade-in mt-1 space-y-1.5 rounded border border-blue-200 bg-white p-2 text-xs text-slate-700">
      <div className="flex items-center gap-2">
        <span className="font-semibold">このメッセージをタスクにする</span>
        {onClose && (
          <button type="button" className="ml-auto text-slate-400 hover:text-slate-700" onClick={onClose}>
            閉じる
          </button>
        )}
      </div>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="タスク名（例: 戸籍謄本の取り寄せ）" aria-label="タスク名" />
      <div className="flex flex-wrap items-center gap-2">
        <select className="input w-auto py-0.5" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="状態">
          {NEW_TASK_STATUSES.map((st) => (
            <option key={st} value={st}>
              {TASK_STATUS_LABEL[st]}
            </option>
          ))}
        </select>
        {isWaitingStatus(status) && (
          <label className="flex items-center gap-1" title="返事をいつまで待つか。空なら設定の営業日数後">
            返信期限 <input type="date" className="input w-auto py-0.5" value={replyBy} onChange={(e) => setReplyBy(e.target.value)} aria-label="返信期限" />
          </label>
        )}
        <label className="flex items-center gap-1" title="そのタスク自体の締切（日付だけ）。空ならなし">
          締切 <input type="date" className="input w-auto py-0.5" value={due} onChange={(e) => setDue(e.target.value)} aria-label="締切" />
        </label>
        {cases.length >= 2 && (
          <label className="flex min-w-0 items-center gap-1">
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
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> 担当事務局の Chatwork タスクにも登録
        </label>
        <button type="button" className="btn btn-primary btn-sm ml-auto" onClick={() => task.mutate()} disabled={!title.trim() || task.isPending}>
          {task.isPending ? '登録中…' : 'タスクにする'}
        </button>
      </div>
      {err && <div className="fade-in text-red-600">{err}</div>}
      <div className="text-slate-400">メッセージの本文はタスクのメモに残り、この会話・依頼者・事件に紐付きます。返信待ちにすると、この会話に返事が届いたときに知らせます。</div>
    </div>
  );
}
