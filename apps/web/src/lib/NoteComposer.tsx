import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from './api';
import { useDraftGroup, DraftHint } from './draft';
import { DUE_HINT, FOLLOW_HINT } from './Deadline';
import { toLocalInput, fromLocalInput } from './format';
import { CASE_NOTE_KINDS, CASE_NOTE_KIND_LABEL, WAITING_FOR_LABEL, jstYmd, type CaseNoteKind, type WaitingFor } from '@lcm/shared';

export function dueYmd(due?: string | null): string | null {
  if (!due) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return due;
  const d = new Date(due);
  return Number.isNaN(d.getTime()) ? null : jstYmd(d);
}

/** 次のアクション 1 件の締切・返信期限の入力（AI が読み取った日付が最初から入る。空ならなし） */
export function ActionDeadlineInputs({ due, replyBy, onChange }: { due: string; replyBy: string; onChange: (patch: { due?: string; replyBy?: string }) => void }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600">
      <label className="flex items-center gap-1" title={DUE_HINT}>
        締切
        <input type="date" className="input w-auto py-0.5 text-xs" value={due} onChange={(e) => onChange({ due: e.target.value })} aria-label="締切" />
      </label>
      <label className="flex items-center gap-1" title={FOLLOW_HINT}>
        返信期限
        <input type="date" className="input w-auto py-0.5 text-xs" value={replyBy} onChange={(e) => onChange({ replyBy: e.target.value })} aria-label="返信期限" />
      </label>
    </span>
  );
}

/** 電話の伝言への折り返しとして記録するとき（タスクから使う） */
export interface NoteCallback {
  taskId: number;
  /** 伝言の本文（AI の整理に参考として渡す） */
  context: string;
  counterpart?: string | null;
  phone?: string | null;
}

/**
 * 事件の記録を追加するフォーム（走り書き → AI で要旨・発言・決定事項・次のアクションに整理 → 保存）。
 * callback を渡すと、電話の伝言への折り返しとして記録する（種別は電話、伝言を記録に添え、タスクを完了にできる）
 */
export function NoteComposer({
  caseId,
  onSaved,
  callback,
}: {
  caseId: number;
  onSaved: (note?: { id: number; kind: string }, extra?: { taskStatus?: string }) => void;
  callback?: NoteCallback;
}) {
  const [kind, setKind] = useState<CaseNoteKind>('phone');
  const [counterpart, setCounterpart] = useState(callback?.counterpart ?? '');
  const [phone, setPhone] = useState(callback?.phone ?? '');
  // 折り返しを記録したら、伝言のタスクを完了にする（Chatwork のタスクも完了になる）
  const [completeTask, setCompleteTask] = useState(true);
  const [occurredAt, setOccurredAt] = useState(toLocalInput(new Date().toISOString()));
  const [raw, setRaw] = useState('');
  const [theirSaid, setTheirSaid] = useState('');
  const [ourSaid, setOurSaid] = useState('');
  const [preview, setPreview] = useState<{ gist: string; theirSaid: string[]; ourSaid: string[]; phone: string | null; decisions: string[]; nextActions: { title: string; due: string | null; replyBy?: string | null }[]; waitingFor: WaitingFor; counterpart: string | null } | null>(null);
  const lines = (t: string) => t.split(/\n/).map((x) => x.replace(/^[・\-\s]+/, '').trim()).filter(Boolean);
  // タスク化の方法: アクションごと／1 つにまとめる／作らない。タスク化するアクションはチェックで選ぶ
  const [taskMode, setTaskMode] = useState<'each' | 'single' | 'none'>('single');
  const [taskPick, setTaskPick] = useState<Set<number>>(new Set());
  const [err, setErr] = useState('');
  // 書きかけのメモはこの端末に自動保存する（保存前に画面を離れても消えない）
  const noteDraft = useDraftGroup(callback ? `task:${callback.taskId}:callback` : `case:${caseId}:note:new`, {
    counterpart: { value: counterpart, set: setCounterpart },
    phone: { value: phone, set: setPhone },
    raw: { value: raw, set: setRaw },
    theirSaid: { value: theirSaid, set: setTheirSaid },
    ourSaid: { value: ourSaid, set: setOurSaid },
  });
  const structure = useMutation({
    mutationFn: () => api.post<NonNullable<typeof preview>>(`/cases/${caseId}/notes/structure`, { rawText: raw, kind, counterpart: counterpart || null, phone: phone || null, context: callback?.context ?? null }),
    onSuccess: (r) => {
      setPreview(r);
      setTaskPick(new Set(r.nextActions.map((_, i) => i)));
      setTheirSaid(r.theirSaid.map((x) => `・${x}`).join('\n'));
      setOurSaid(r.ourSaid.map((x) => `・${x}`).join('\n'));
      if (!phone && r.phone) setPhone(r.phone);
    },
    onError: (e) => setErr((e as Error).message),
  });
  const save = useMutation({
    mutationFn: async () => {
      const body = {
        kind,
        counterpart: counterpart || preview?.counterpart || null,
        phone: phone || preview?.phone || null,
        occurredAt: fromLocalInput(occurredAt),
        rawText: raw,
        gist: preview?.gist ?? null,
        theirSaid: lines(theirSaid),
        ourSaid: lines(ourSaid),
        decisions: preview?.decisions ?? [],
        nextActions: preview?.nextActions ?? [],
        waitingFor: preview?.waitingFor ?? null,
        createTasks: preview && taskMode !== 'none' && taskPick.size > 0 ? taskMode : false,
        taskIndexes: [...taskPick],
      };
      if (!callback) return { note: await api.post<{ id: number; kind: string }>(`/cases/${caseId}/notes`, body), taskStatus: undefined };
      const r = await api.post<{ note: { id: number; kind: string }; taskStatus: string }>(`/tasks/${callback.taskId}/callback`, { ...body, caseId, completeTask });
      return r;
    },
    onSuccess: (r) => {
      setRaw('');
      setTheirSaid('');
      setOurSaid('');
      setPhone('');
      noteDraft.clear();
      setPreview(null);
      setErr('');
      onSaved(r.note, { taskStatus: r.taskStatus });
    },
    onError: (e) => setErr((e as Error).message),
  });
  return (
    <section className="card space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">{callback ? '折り返し電話の記録' : '記録を追加'}</h2>
        {!callback && (
          <select className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value as CaseNoteKind)}>
            {CASE_NOTE_KINDS.filter((k) => k !== 'policy').map((k) => (
              <option key={k} value={k}>
                {CASE_NOTE_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        )}
        <input className="input w-40" placeholder="相手（例: 相手方代理人）" value={counterpart} onChange={(e) => setCounterpart(e.target.value)} />
        {kind === 'phone' && <input type="tel" className="input w-40" placeholder="電話番号" value={phone} onChange={(e) => setPhone(e.target.value)} />}
        <input type="datetime-local" className="input w-auto" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
      </div>
      <textarea
        className="input min-h-28"
        placeholder={
          callback
            ? '通話の内容を走り書きで OK。例: 和解案の件で折り返し。300万なら応じるとのこと。依頼者に持ち帰り、来週金曜までに回答すると伝えた。伝言の内容は記録に自動で添えます。'
            : '走り書きで OK。例: 相手方代理人から電話。和解案として300万を提示。依頼者に持ち帰り、来週金曜までに回答。証拠の追加提出は不要とのこと。'
        }
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
      />
      <DraftHint handle={noteDraft} />
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <label className="label">相手が言ったこと（1 行 1 項目。AI 整理で自動入力、手で直せます）</label>
          <textarea className="input min-h-20 text-sm" value={theirSaid} onChange={(e) => setTheirSaid(e.target.value)} placeholder="・和解案として 300 万円を提示&#10;・証拠の追加提出は不要" />
        </div>
        <div>
          <label className="label">こちらが言ったこと</label>
          <textarea className="input min-h-20 text-sm" value={ourSaid} onChange={(e) => setOurSaid(e.target.value)} placeholder="・依頼者に持ち帰って検討する&#10;・来週金曜までに回答する" />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn" onClick={() => structure.mutate()} disabled={!raw.trim() || structure.isPending}>
          {structure.isPending ? '整理中…' : 'AI で要旨・発言の整理・決定事項・次のアクションに整理'}
        </button>
        <select className="input w-full min-w-0 text-sm sm:w-auto" value={taskMode} onChange={(e) => setTaskMode(e.target.value as typeof taskMode)} title="AI が挙げた次のアクションをどうタスクにするか">
          <option value="single">次のアクションを 1 つのタスクにまとめる</option>
          <option value="each">次のアクションごとにタスクを作る</option>
          <option value="none">タスクにしない</option>
        </select>
        {callback && (
          <label className="flex items-center gap-1 text-sm" title="Chatwork から振られたタスクなら、Chatwork のタスクも完了になります">
            <input type="checkbox" checked={completeTask} onChange={(e) => setCompleteTask(e.target.checked)} /> 伝言のタスクを完了にする
          </label>
        )}
        <button className="btn btn-primary ml-auto" onClick={() => save.mutate()} disabled={!raw.trim() || !caseId || save.isPending}>
          {callback ? '記録を保存' : '保存'}
        </button>
      </div>
      {err && <div className="fade-in text-sm text-red-600">{err}</div>}
      {preview && (
        <div className="rounded border border-blue-200 bg-blue-50 p-3 text-sm">
          <div>
            <b>要旨:</b> {preview.gist}
          </div>
          {preview.decisions.length > 0 && (
            <div>
              <b>決定事項:</b> {preview.decisions.join(' / ')}
            </div>
          )}
          {preview.nextActions.length > 0 && (
            <div>
              <b>次のアクション:</b>
              {taskMode !== 'none' && <span className="ml-2 text-xs text-slate-500">チェックしたものを{taskMode === 'single' ? '1 つのタスクにまとめます' : 'それぞれタスクにします'}</span>}
              <ul className="ml-1 mt-1 space-y-1.5">
                {preview.nextActions.map((a, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={taskPick.has(i)}
                      disabled={taskMode === 'none'}
                      onChange={(e) =>
                        setTaskPick((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(i);
                          else next.delete(i);
                          return next;
                        })
                      }
                      aria-label="タスク化する"
                    />
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className="block">{a.title}</span>
                      {/* 期限は AI が読み取った日付が入る。直してから保存できる */}
                      <ActionDeadlineInputs
                        due={dueYmd(a.due) ?? ''}
                        replyBy={dueYmd(a.replyBy) ?? ''}
                        onChange={(p) =>
                          setPreview((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  nextActions: prev.nextActions.map((x, j) =>
                                    j === i ? { ...x, ...(p.due !== undefined ? { due: p.due || null } : {}), ...(p.replyBy !== undefined ? { replyBy: p.replyBy || null } : {}) } : x,
                                  ),
                                }
                              : prev,
                          )
                        }
                      />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <b>待ち:</b> {WAITING_FOR_LABEL[preview.waitingFor]}
          </div>
        </div>
      )}
    </section>
  );
}

