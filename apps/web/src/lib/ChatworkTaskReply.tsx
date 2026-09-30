import { useState, type KeyboardEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from './api';
import { useDraft, DraftHint } from './draft';
import { fmtDateTime } from './format';
import { messageLink } from '@lcm/shared';

export interface ReplyableTask {
  id: number;
  status: string;
  chatworkReplyable?: boolean;
  chatworkAssignedByName?: string | null;
  chatworkRepliedAt?: string | null;
}

type After = 'keep' | 'done' | 'waiting_staff';
const QUICK = ['確認しました。', '対応しました。', '承知しました。対応します。'];

/**
 * Chatwork で事務局などから振られたタスクに、Chatwork の「返信」として返事を送る。
 * 返信は元のタスクのメッセージにつながるので、相手の Chatwork にもそのまま届く
 */
/** onSent: 送ったことを画面の上の方にも出したいとき（完了にすると行が一覧から消えるため） */
export function ChatworkTaskReply({ task, onDone, onSent }: { task: ReplyableTask; onDone: () => void; onSent?: (summary: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [after, setAfter] = useState<After>('keep');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; conversationId?: number | null; messageId?: number | null } | null>(null);
  const draft = useDraft(`task-cw-reply:${task.id}`, text, setText, '');
  const to = task.chatworkAssignedByName ? `${task.chatworkAssignedByName}さん` : '依頼した人';

  const send = useMutation({
    mutationFn: () => api.post<{ conversationId: number | null; messageId: number | null; to: string | null; status: string }>(`/tasks/${task.id}/chatwork-reply`, { text, after }),
    onSuccess: (r) => {
      draft.clear();
      setText('');
      const parts = [`Chatwork で ${r.to ? `${r.to}さん` : '相手'}に返信しました`];
      if (after === 'done') parts.push('タスクを完了にしました（Chatwork のタスクも完了）');
      if (after === 'waiting_staff') parts.push('事務局の回答・作業待ちにしました');
      setMsg({ kind: 'ok', text: parts.join('。'), conversationId: r.conversationId, messageId: r.messageId });
      onSent?.(parts.join('。'));
      setOpen(false);
      onDone();
    },
    onError: (e) => setMsg({ kind: 'err', text: (e as Error).message }),
  });

  if (!task.chatworkReplyable) return null;
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim() && !send.isPending) {
      e.preventDefault();
      send.mutate();
    }
  };

  return (
    <>
      <button type="button" className="ml-2 text-xs text-blue-700 hover:underline" onClick={() => setOpen((v) => !v)} title={`このタスクの Chatwork のメッセージに、${to}への返信として送ります`}>
        Chatwork で返信
      </button>
      {task.chatworkRepliedAt && !open && <span className="ml-2 text-[11px] text-slate-500">{fmtDateTime(task.chatworkRepliedAt)} に返信済み</span>}
      {msg && !open && (
        <div className={`fade-in w-full basis-full text-xs ${msg.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}>
          {msg.text}
          {msg.conversationId && (
            <Link className="ml-2 underline" to={messageLink(msg.conversationId, msg.messageId ?? undefined)}>
              会話で見る
            </Link>
          )}
        </div>
      )}
      {open && (
        <form
          className="fade-in mt-1 w-full basis-full space-y-1.5 rounded-md border border-blue-200 bg-blue-50/40 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
          onKeyDown={keys}
        >
          <div className="text-xs text-slate-600">{to}への返信（Chatwork のタスクのメッセージに「返信」としてつながります）</div>
          <div className="flex flex-wrap gap-1">
            {QUICK.map((q) => (
              <button key={q} type="button" className="btn btn-sm py-0 text-xs" onClick={() => setText((t) => (t.trim() ? `${t.trimEnd()}\n${q}` : q))}>
                {q}
              </button>
            ))}
          </div>
          <textarea className="input min-h-20 w-full text-sm" value={text} onChange={(e) => setText(e.target.value)} aria-label="Chatwork への返信" placeholder="返信の本文" autoFocus maxLength={10000} />
          <DraftHint handle={draft} />
          <div className="flex flex-wrap items-center gap-2">
            <select className="input w-auto py-1 text-xs" value={after} onChange={(e) => setAfter(e.target.value as After)} aria-label="返信したあとのタスク">
              <option value="keep">タスクはそのまま</option>
              <option value="done">返信したら完了にする（Chatwork のタスクも完了）</option>
              {task.status !== 'waiting_staff' && <option value="waiting_staff">返信したら「事務局の回答・作業待ち」にする</option>}
            </select>
            <button type="submit" className="btn btn-sm btn-primary ml-auto" disabled={!text.trim() || send.isPending}>
              {send.isPending ? '送信中…' : 'Chatwork で送る'}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>
              やめる
            </button>
          </div>
          {msg?.kind === 'err' && <div className="text-xs text-red-600">{msg.text}</div>}
        </form>
      )}
    </>
  );
}
