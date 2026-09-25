import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from './api';

export interface EditableTask {
  id: number;
  title: string;
  note?: string | null;
  chatworkTaskId?: number | null;
}

/**
 * タスクの中身（タスク名・メモ）を直すフォーム。
 * タスク一覧・事件ページ・会話画面で同じものを使う。Ctrl+Enter で保存、Esc でやめる
 */
export function TaskEditForm({ task, onDone, onCancel, compact = false }: { task: EditableTask; onDone: () => void; onCancel: () => void; compact?: boolean }) {
  const [title, setTitle] = useState(task.title);
  const [note, setNote] = useState(task.note ?? '');
  const [err, setErr] = useState<string | null>(null);
  // メモ欄は中身に合わせて背が伸びる
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = noteRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(compact ? 52 : 64, Math.min(el.scrollHeight, 320))}px`;
  }, [note, compact]);

  const changed = title.trim() !== task.title || (note.trim() || null) !== (task.note?.trim() || null);
  const save = useMutation({
    mutationFn: () => api.put(`/tasks/${task.id}`, { title: title.trim(), note: note.trim() || null }),
    onSuccess: onDone,
    onError: (e) => setErr((e as Error).message),
  });
  const submit = () => {
    if (!title.trim()) {
      setErr('タスク名を入力してください');
      return;
    }
    if (!changed) {
      onCancel();
      return;
    }
    save.mutate();
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onCancel();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      className="fade-in space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={keys}
    >
      <input className={`input w-full ${compact ? 'py-1 text-xs' : ''}`} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="タスク名" placeholder="タスク名" maxLength={500} autoFocus />
      <textarea ref={noteRef} className={`input w-full ${compact ? 'text-xs' : 'text-sm'}`} value={note} onChange={(e) => setNote(e.target.value)} aria-label="メモ" placeholder="メモ（経緯・やること・連絡先など。空でもかまいません）" />
      {task.chatworkTaskId ? <div className="text-[11px] text-slate-500">Chatwork 側のタスクの本文は変わりません（Chatwork はタスクの書き換えに対応していないため）。</div> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="submit" className="btn btn-sm btn-primary" disabled={save.isPending || !title.trim()}>
          {save.isPending ? '保存中…' : '保存'}
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          やめる
        </button>
        {!compact && <span className="text-[11px] text-slate-400">Ctrl+Enter で保存 ／ Esc でやめる</span>}
        {err && <span className="text-xs text-red-600">{err}</span>}
      </div>
    </form>
  );
}

/** 一覧の行に置く「編集」ボタン */
export function TaskEditButton({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  return (
    <button type="button" className={`text-xs text-blue-700 hover:underline ${className}`} onClick={onClick} title="タスク名とメモを直します">
      編集
    </button>
  );
}
