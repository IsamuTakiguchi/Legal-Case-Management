import { Fragment, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { LongText } from '../lib/LongText';
import { useDraft, DraftHint } from '../lib/draft';
import { ClientPicker } from '../lib/ClientPicker';
import { fmtDate, fmtRelative } from '../lib/format';
import { TaskDeadlines, NewTaskDeadlines, fmtDeadline } from '../lib/Deadline';
import { MemoBadge } from '../lib/Memo';
import { TASK_STATUSES, TASK_STATUS_LABEL, taskDeadline, isWaitingStatus, type TaskStatus } from '@lcm/shared';
import { useSort, readingKey, type SortOption } from '../lib/sort';
import { Icon } from '../lib/icons';
import { TaskEditForm, TaskEditButton } from '../lib/TaskEdit';
import { ChatworkTaskReply } from '../lib/ChatworkTaskReply';
import { ClientConfirmPanel } from '../lib/ClientConfirmPanel';

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
  chatworkReplyable?: boolean;
  /** Chatwork で振られたタスクの元のメッセージ（取り込み済みなら）。ここから依頼者に確認できる */
  confirmMessageId?: number | null;
  chatworkAssignedByName?: string | null;
  chatworkRepliedAt?: string | null;
  /** 時期未定の備忘のきっかけ（「和解の前」など）と、見直す日 */
  trigger?: string | null;
  reviewAt?: string | null;
  updatedAt: string;
}

/** 並べ替え。既定は「期限が早い順」（返信待ちは返信期限と締切の早いほう、対応中は締切。未設定は末尾） */
const deadlineOf = (t: Task) => taskDeadline(t);
const TASK_SORTS: SortOption<Task>[] = [
  { key: 'deadline', label: '期限が早い順', value: deadlineOf },
  { key: 'waiting', label: '待ちが長い順', value: (t) => t.waitingSince ?? null },
  { key: 'client', label: '依頼者のあいうえお順', value: (t) => (t.clientName ? readingKey(null, t.clientName) : null) },
  { key: 'title', label: 'タスク名', value: (t) => t.title },
  { key: 'updated', label: '更新が新しい順', value: (t) => t.updatedAt ?? null, desc: true },
];

type BulkAction = 'done' | 'open' | 'waiting_client' | 'waiting_other' | 'waiting_staff' | 'nudge' | 'delete';
const BULK_LABEL: Record<BulkAction, string> = {
  done: '完了にしました',
  open: '対応中に戻しました',
  waiting_client: '依頼者の返信待ちにしました',
  waiting_other: '相手方・裁判所待ちにしました',
  waiting_staff: '事務局の回答・作業待ちにしました',
  nudge: '催促済みにしました',
  delete: '削除しました',
};

/** 入力欄の 1 行目をタスク名、2 行目以降をメモにする */
export function splitTitleAndNote(text: string): { title: string; note: string | null } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const head = lines.findIndex((l) => l.trim());
  if (head < 0) return { title: text.trim(), note: null };
  const note = lines.slice(head + 1).join('\n').trim();
  return { title: lines[head]!.trim(), note: note || null };
}

export default function Tasks() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<string>(() => new URLSearchParams(location.search).get('status') ?? 'active');
  const [title, setTitle] = useState('');
  const [newStatus, setNewStatus] = useState<TaskStatus>('open');
  // 追加するときの期限。返信期限は null なら設定の営業日数、締切は null ならなし
  const [newFollowUp, setNewFollowUp] = useState<string | null>(null);
  const [newDue, setNewDue] = useState<string | null>(null);
  const [sync, setSync] = useState(false);
  const list = useQuery({ queryKey: ['tasks', status], queryFn: () => api.get<Task[]>(`/tasks?status=${status}`), refetchInterval: 60_000 });
  // 時期未定の備忘は、きっかけが来るまで未完了の数に入れない（件数だけ別に出す）
  const memos = useQuery({ queryKey: ['tasks', 'memo'], queryFn: () => api.get<Task[]>('/tasks?status=memo'), enabled: status !== 'memo', refetchInterval: 60_000 });
  const sort = useSort('tasks', TASK_SORTS, 'deadline');
  const rows = sort.apply(list.data ?? []);
  const [clientId, setClientId] = useState('');
  const [caseId, setCaseId] = useState('');
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
  // 書きかけのタスク名を自動保存する
  const titleDraft = useDraft('tasks:new-title', title, setTitle);
  // 入力欄は中身に合わせて背が伸びる（2 行から、最大 12 行くらいまで）
  const titleRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(72, Math.min(el.scrollHeight, 260))}px`;
  }, [title]);
  // 返信待ちのタスクは「返信期限」（いつまで待つか）と「締切」、対応中のタスクは「締切」
  const newWaiting = isWaitingStatus(newStatus);
  const create = useMutation({
    mutationFn: () => {
      const { title: name, note } = splitTitleAndNote(title);
      return api.post('/tasks', {
        title: name,
        note,
        status: newStatus,
        clientId: clientId ? Number(clientId) : null,
        caseId: caseId ? Number(caseId) : null,
        followUpAt: newWaiting ? newFollowUp : null,
        dueAt: newDue,
        syncToChatwork: sync,
      });
    },
    onSuccess: () => {
      setTitle('');
      setNewFollowUp(null);
      setNewDue(null);
      titleDraft.clear();
      refresh();
    },
  });
  const update = useMutation({ mutationFn: (v: { id: number; patch: Record<string, unknown> }) => api.put(`/tasks/${v.id}`, v.patch), onSuccess: refresh });
  // 中身（タスク名・メモ）を直しているタスク
  const [editingId, setEditingId] = useState<number | null>(null);
  // 事務局から振られた確認事項を、依頼者に確認するパネルを開いているタスク
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const nudge = useMutation({ mutationFn: (id: number) => api.post(`/tasks/${id}/nudge`), onSuccess: refresh });
  const snooze = useMutation({ mutationFn: (id: number) => api.post(`/tasks/${id}/memo-snooze`, { days: 14 }), onSuccess: refresh });
  const importCw = useMutation({ mutationFn: () => api.post<{ imported: number; completed: number }>('/tasks/import-chatwork'), onSuccess: refresh });
  const now = Date.now();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">タスク・返信待ち</h1>
        <select className="input ml-auto w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">未完了</option>
          <option value="waiting">連絡待ち（依頼者・相手方・事務局）</option>
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
        <button className="btn btn-sm" onClick={() => importCw.mutate()} disabled={importCw.isPending} title="Chatwork のタスクは 10 分ごとに自動で取り込みます。待たずに取り込みたいときに押してください">
          {importCw.isPending ? '取込中…' : 'Chatwork から今すぐ取込'}
        </button>
        {importCw.data ? (
          <span className="text-xs text-slate-500">
            取込 {importCw.data.imported} / 完了反映 {importCw.data.completed}
          </span>
        ) : (
          <span className="text-xs text-slate-400">Chatwork のタスクは 10 分ごとに自動で取り込みます</span>
        )}
      </div>
      {status !== 'memo' && (memos.data?.length ?? 0) > 0 && (
        <div className="text-xs text-slate-500">
          ⏳ 時期未定の備忘が {memos.data!.length} 件あります（きっかけが来るまでタスクの数には入れていません）{' '}
          <button type="button" className="text-blue-700 hover:underline" onClick={() => setStatus('memo')}>
            一覧を見る
          </button>
        </div>
      )}
      <form
        className="card flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) create.mutate();
        }}
      >
        <div className="w-full">
          <textarea
            ref={titleRef}
            className="input w-full resize-y"
            rows={2}
            placeholder={'新しいタスク（1 行目がタスク名、2 行目からはメモ）\n例: 山田様に中間報告\n　　診断書の再提出について確認する'}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              // 改行はそのまま。⌘／Ctrl＋Enter で追加できる
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && title.trim()) {
                e.preventDefault();
                create.mutate();
              }
            }}
            required
          />
          <DraftHint handle={titleDraft} />
        </div>
        <ClientPicker
          value={clientId}
          onChange={(v) => {
            setClientId(v);
            setCaseId('');
          }}
          emptyLabel="依頼者なし"
          selectClassName="w-48"
        />
        {clientId && <CaseSelect clientId={Number(clientId)} value={caseId} onChange={setCaseId} />}
        <select className="input w-auto" value={newStatus} onChange={(e) => setNewStatus(e.target.value as TaskStatus)}>
          {TASK_STATUSES.filter((s) => s !== 'done' && s !== 'memo').map((s) => (
            <option key={s} value={s}>
              {TASK_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <NewTaskDeadlines waiting={newWaiting} followUp={newFollowUp} onFollowUp={setNewFollowUp} due={newDue} onDue={setNewDue} />
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> Chatwork にも作成
        </label>
        <button className="btn btn-primary" disabled={create.isPending}>
          {create.isPending ? '追加中…' : '追加'}
        </button>
        <span className="text-xs text-slate-400">⌘／Ctrl＋Enter でも追加できます</span>
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
            <button className="btn btn-sm" onClick={() => bulk.mutate('waiting_staff')} disabled={bulk.isPending}>
              事務局待ちに
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
      {/* スマホでは表をやめて 1 件ずつのカードにする（横スクロールさせない）。md 以上は表 */}
      <div className="card p-0 md:overflow-x-auto">
        <table className="table-stack block w-full text-sm md:table">
          <thead className="hidden bg-slate-50 text-left text-xs text-slate-500 md:table-header-group">
            <tr>
              <th className="w-px px-3 py-2"></th>
              <th className="px-3 py-2">状態</th>
              <th className="px-3 py-2">タスク</th>
              <th className="px-3 py-2">依頼者 / 事件</th>
              <th className="px-3 py-2" title="締切: タスクそのものの締切（例: 答弁書の提出期限） ／ 返信期限: 返事を待つ期限（例: 依頼者の返事）">締切・返信期限</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="block md:table-row-group">
            {rows.map((t) => {
              const over = t.followUpAt && new Date(t.followUpAt).getTime() < now && t.status !== 'done' && t.status !== 'open';
              return (
                <Fragment key={t.id}>
                <tr className={`flex flex-wrap items-center border-t border-slate-100 py-1 first:border-t-0 md:table-row md:py-0 md:first:border-t ${selected.has(t.id) ? 'bg-blue-50' : over ? 'bg-orange-50' : ''}`}>
                  <td className="pl-3 pr-1 pt-1 md:w-px md:px-3 md:py-2">
                    <input type="checkbox" checked={selected.has(t.id)} onChange={(e) => toggle(t.id, e.target.checked)} aria-label="選択" />
                  </td>
                  <td className="min-w-0 flex-1 pr-3 pt-1 md:w-px md:whitespace-nowrap md:px-3 md:py-2">
                    <select className="input w-auto max-w-full py-0.5 text-xs" value={t.status} onChange={(e) => update.mutate({ id: t.id, patch: { status: e.target.value } })}>
                      {TASK_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {TASK_STATUS_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="w-full min-w-0 break-words px-3 py-1 md:w-auto md:min-w-[14rem] md:py-2">
                    {editingId === t.id ? (
                      <TaskEditForm
                        task={t}
                        onCancel={() => setEditingId(null)}
                        onDone={() => {
                          setEditingId(null);
                          refresh();
                        }}
                      />
                    ) : (
                      <>
                        {t.conversationId ? (
                          <Link to={`/inbox/${t.conversationId}`} className="font-medium hover:underline">
                            {t.title}
                          </Link>
                        ) : (
                          <span className="font-medium">{t.title}</span>
                        )}
                        {t.chatworkTaskId && <span className="badge badge-chatwork ml-1">CW</span>}
                        {t.status === 'memo' && t.trigger && (
                          <span className="ml-1">
                            <MemoBadge trigger={t.trigger} reviewAt={t.reviewAt} />
                          </span>
                        )}
                        <TaskEditButton className="ml-2" onClick={() => setEditingId(t.id)} />
                        <ChatworkTaskReply task={t} onDone={refresh} onSent={setMsg} />
                        {t.chatworkReplyable && t.chatworkAssignedByName && <div className="text-[11px] text-slate-500">{t.chatworkAssignedByName}さんから（Chatwork）</div>}
                        {t.note && <TaskNote text={t.note} />}
                      </>
                    )}
                  </td>
                  <td className="w-full min-w-0 px-3 py-0.5 md:w-auto md:max-w-[18rem] md:py-2">
                    <TaskLinks task={t} onSave={(patch) => update.mutate({ id: t.id, patch })} />
                  </td>
                  <td className="w-full px-3 py-0.5 text-xs text-slate-600 md:w-px md:whitespace-nowrap md:py-2">
                    {t.waitingSince && <div>{fmtRelative(t.waitingSince)}から待ち</div>}
                    {/* 締切は対応中でも返信待ちでも同じ欄（返信待ちにしても消えない）。返信待ちは返信期限も */}
                    <TaskDeadlines task={t} onChange={(patch) => update.mutate({ id: t.id, patch })} />
                    {/* 時期未定の備忘: 締切が決まるまでは見直す日を出し、「まだ未定」で先に延ばせる */}
                    {t.status === 'memo' && (
                      <div className="mt-0.5 flex flex-wrap items-center gap-1">
                        <span className={t.reviewAt && new Date(t.reviewAt).getTime() < now ? 'font-semibold text-orange-600' : 'text-slate-500'}>見直し {t.reviewAt ? fmtDeadline(t.reviewAt) : '未設定'}</span>
                        <button className="btn btn-sm px-1.5 py-0 text-[11px]" disabled={snooze.isPending} onClick={() => snooze.mutate(t.id)} title="まだ時期が決まっていないので、2 週間後にまた見直します">
                          まだ未定
                        </button>
                        <button className="btn btn-sm px-1.5 py-0 text-[11px]" disabled={update.isPending} onClick={() => update.mutate({ id: t.id, patch: { status: 'open' } })} title="きっかけが来たので、対応中のタスクにします（締切を入れてもタスクになります）">
                          タスクにする
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="w-full px-3 pb-1.5 pt-0.5 empty:hidden md:w-px md:whitespace-nowrap md:py-2 md:text-right">
                    <div className="flex flex-wrap gap-1 empty:hidden md:flex-nowrap md:justify-end">
                      {t.conversationId && (
                        <Link to={`/inbox/${t.conversationId}`} className="btn btn-sm" title="このタスクの元になった会話を開きます">
                          {isWaitingStatus(t.status) ? '催促文を作成' : '会話を開く'}
                        </Link>
                      )}
                      {t.confirmMessageId && t.status !== 'done' && (
                        <button
                          className="btn btn-sm"
                          onClick={() => setConfirmingId(confirmingId === t.id ? null : t.id)}
                          title="事務局から振られた確認事項を、自分から依頼者に確認する文に書き直して、Gmail・LINE・Chatwork で依頼者に送ります。送ると、このタスクを「依頼者の返信待ち」にします"
                        >
                          📨 依頼者に確認
                        </button>
                      )}
                      {isWaitingStatus(t.status) && (
                        <button className="btn btn-sm" onClick={() => nudge.mutate(t.id)}>
                          催促した
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                {confirmingId === t.id && t.confirmMessageId && (
                  <tr className="block md:table-row">
                    <td colSpan={6} className="block px-3 pb-3 md:table-cell">
                      <ClientConfirmPanel
                        messageId={t.confirmMessageId}
                        waitingTaskDefault={false}
                        onClose={() => setConfirmingId(null)}
                        onSent={() => {
                          // 依頼者に確認したので、このタスクを依頼者の返信待ちにする（返信期限は設定の営業日数後）
                          if (t.status !== 'waiting_client') update.mutate({ id: t.id, patch: { status: 'waiting_client' } });
                          else refresh();
                        }}
                      />
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
            {list.data?.length === 0 && (
              <tr className="block md:table-row">
                <td colSpan={6} className="block px-4 py-4 text-slate-500 md:table-cell">
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

/** 依頼者の事件を選ぶプルダウン（終了以外） */
function CaseSelect({ clientId, value, onChange, className = 'w-56' }: { clientId: number; value: string; onChange: (v: string) => void; className?: string }) {
  const cases = useQuery({ queryKey: ['cases', 'client', clientId, 'open'], queryFn: () => api.get<{ id: number; title: string }[]>(`/cases?clientId=${clientId}&status=open`) });
  return (
    <select className={`input ${className}`} value={value} onChange={(e) => onChange(e.target.value)} aria-label="事件">
      <option value="">事件なし</option>
      {cases.data?.map((k) => (
        <option key={k.id} value={k.id}>
          {k.title}
        </option>
      ))}
    </select>
  );
}

/** 依頼者・事件へのリンクと、その場での紐付け変更 */
function TaskLinks({ task, onSave }: { task: Task; onSave: (patch: { clientId: number | null; caseId: number | null }) => void }) {
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState(task.clientId ? String(task.clientId) : '');
  const [caseId, setCaseId] = useState(task.caseId ? String(task.caseId) : '');
  if (editing) {
    return (
      <div className="fade-in space-y-1">
        <ClientPicker
          value={clientId}
          onChange={(v) => {
            setClientId(v);
            setCaseId('');
          }}
          emptyLabel="依頼者なし"
          selectClassName="w-48"
        />
        {clientId && <CaseSelect clientId={Number(clientId)} value={caseId} onChange={setCaseId} className="w-48" />}
        <div className="flex gap-1">
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              onSave({ clientId: clientId ? Number(clientId) : null, caseId: caseId ? Number(caseId) : null });
              setEditing(false);
            }}
          >
            紐付ける
          </button>
          <button className="btn btn-sm" onClick={() => setEditing(false)}>
            やめる
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="group">
      {task.clientId ? (
        <Link to={`/clients/${task.clientId}`} className="block truncate text-[var(--accent)] hover:underline" title="依頼者ページを開く">
          {task.clientName}
        </Link>
      ) : (
        <span className="text-xs text-slate-400">依頼者なし</span>
      )}
      {task.caseId && (
        <Link to={`/cases/${task.caseId}`} className="block truncate text-xs text-slate-500 hover:text-[var(--accent)] hover:underline" title="事件ページを開く">
          <Icon name="scale" className="mr-0.5 inline h-3 w-3 align-[-1px]" />
          {task.caseTitle ?? '事件'}
        </Link>
      )}
      <button
        type="button"
        className="mt-0.5 text-[11px] text-slate-400 hover:text-[var(--accent)] hover:underline"
        onClick={() => {
          setClientId(task.clientId ? String(task.clientId) : '');
          setCaseId(task.caseId ? String(task.caseId) : '');
          setEditing(true);
        }}
      >
        {task.clientId || task.caseId ? '紐付けを変更' : '依頼者・事件に紐付け'}
      </button>
    </div>
  );
}

/** タスクのメモ。短ければ全文、長文（目安 300 字 or 8 行超）は折りたたんで「続きを表示」で開く */
function TaskNote({ text }: { text: string }) {
  return <LongText text={text} className="text-xs text-slate-500" buttonClassName="" />;
}
