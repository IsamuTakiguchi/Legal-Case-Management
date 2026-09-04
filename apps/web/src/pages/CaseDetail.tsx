import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDateTime, fmtDate, fmtYen, toLocalInput, fromLocalInput } from '../lib/format';
import { CASE_NOTE_KINDS, CASE_NOTE_KIND_LABEL, WAITING_FOR_LABEL, CREDITOR_EVENT_CHANNELS, CREDITOR_EVENT_CHANNEL_LABEL, CREDITOR_IMPORT_FIELD_LABEL, EVENT_KIND_LABEL, TASK_STATUS_LABEL, type CaseNoteKind, type WaitingFor, type EventKind, type TaskStatus } from '@lcm/shared';

interface Note {
  id: number;
  kind: string;
  occurredAt: string;
  counterpart: string | null;
  rawText: string | null;
  gist: string | null;
  decisions: string[];
  nextActions: { title: string; due?: string | null; taskId?: number | null }[];
  waitingFor: string | null;
  createdBy: string;
}
interface CaseData {
  id: number;
  title: string;
  caseType: { key: string; label: string; hasCreditors: boolean; creditorStages: string[] } | null;
  client: { id: number; name: string } | null;
  courtName: string | null;
  caseNumber: string | null;
  status: string;
  stage: string | null;
  policy: string | null;
  policyUpdatedAt: string | null;
  summary: string | null;
  summaryGeneratedAt: string | null;
  nextHearingAt: string | null;
  notes: Note[];
  tasks: { id: number; title: string; status: string }[];
  events: { id: number; title: string; startAt: string; kind: string }[];
}
interface TimelineItem {
  at: string;
  type: string;
  title: string;
  body?: string | null;
  ref?: Record<string, unknown>;
}

export default function CaseDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'overview' | 'timeline' | 'creditors'>('overview');
  const d = useQuery({ queryKey: ['case', id], queryFn: () => api.get<CaseData>(`/cases/${id}`) });
  const types = useQuery({ queryKey: ['case-types'], queryFn: () => api.get<{ key: string; label: string }[]>('/case-types') });
  const c = d.data;
  const [form, setForm] = useState({ title: '', caseType: '', courtName: '', caseNumber: '', stage: '', policy: '', status: 'active' });
  useEffect(() => {
    if (c) setForm({ title: c.title, caseType: c.caseType?.key ?? 'general_civil', courtName: c.courtName ?? '', caseNumber: c.caseNumber ?? '', stage: c.stage ?? '', policy: c.policy ?? '', status: c.status });
  }, [c]);
  const save = useMutation({ mutationFn: () => api.put(`/cases/${id}`, form), onSuccess: () => qc.invalidateQueries({ queryKey: ['case', id] }) });
  const summary = useMutation({ mutationFn: () => api.post(`/cases/${id}/summary`), onSuccess: () => qc.invalidateQueries({ queryKey: ['case', id] }) });
  if (!c) return <div className="text-slate-500">読み込み中…</div>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/cases" className="text-sm text-slate-500 hover:underline">
          ← 事件
        </Link>
        <h1 className="text-xl font-bold">{c.title}</h1>
        {c.client && (
          <Link to={`/clients/${c.client.id}`} className="text-sm text-blue-700 hover:underline">
            {c.client.name}
          </Link>
        )}
        <span className="badge badge-gray">{c.caseType?.label}</span>
        {c.nextHearingAt && <span className="text-sm text-slate-600">次回期日: {fmtDateTime(c.nextHearingAt)}</span>}
      </div>
      <div className="flex gap-1 border-b border-slate-200">
        {(['overview', 'timeline', ...(c.caseType?.hasCreditors ? ['creditors'] : [])] as const).map((t) => (
          <button key={t} className={`px-3 py-2 text-sm ${tab === t ? 'border-b-2 border-blue-600 font-semibold text-blue-700' : 'text-slate-600'}`} onClick={() => setTab(t as typeof tab)}>
            {t === 'overview' ? '概要・記録' : t === 'timeline' ? 'タイムライン' : '債権者'}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
          <div className="space-y-4">
            <NoteComposer caseId={c.id} onSaved={() => qc.invalidateQueries({ queryKey: ['case', id] })} />
            <section className="card">
              <h2 className="mb-2 font-semibold">記録（電話・打合せ・メモ）</h2>
              <ul className="space-y-3">
                {c.notes
                  .filter((n) => n.kind !== 'policy')
                  .map((n) => (
                    <NoteView key={n.id} n={n} onDeleted={() => qc.invalidateQueries({ queryKey: ['case', id] })} />
                  ))}
                {c.notes.length === 0 && <li className="text-sm text-slate-500">記録はまだありません</li>}
              </ul>
            </section>
          </div>
          <aside className="space-y-4">
            <section className="card space-y-2 text-sm">
              <h2 className="font-semibold">事件情報</h2>
              <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              <select className="input" value={form.caseType} onChange={(e) => setForm({ ...form, caseType: e.target.value })}>
                {types.data?.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
              <input className="input" placeholder="裁判所" value={form.courtName} onChange={(e) => setForm({ ...form, courtName: e.target.value })} />
              <input className="input" placeholder="事件番号" value={form.caseNumber} onChange={(e) => setForm({ ...form, caseNumber: e.target.value })} />
              <input className="input" placeholder="現在の段階（例: 第2回弁論準備、受任通知送付済）" value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })} />
              <select className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="active">進行中</option>
                <option value="closed">終了</option>
              </select>
              <div>
                <label className="label">方針メモ {c.policyUpdatedAt && <span className="font-normal text-slate-400">（更新 {fmtDate(c.policyUpdatedAt)}）</span>}</label>
                <textarea className="input min-h-32" value={form.policy} onChange={(e) => setForm({ ...form, policy: e.target.value })} placeholder="今後の方針、争点、依頼者の希望など" />
              </div>
              <button className="btn btn-primary w-full justify-center" onClick={() => save.mutate()} disabled={save.isPending}>
                保存
              </button>
            </section>
            <section className="card text-sm">
              <div className="mb-2 flex items-center">
                <h2 className="font-semibold">進捗サマリー</h2>
                <button className="btn btn-sm ml-auto" onClick={() => summary.mutate()} disabled={summary.isPending}>
                  {summary.isPending ? '生成中…' : 'AI で更新'}
                </button>
              </div>
              {c.summary ? <div className="whitespace-pre-wrap text-slate-700">{c.summary}</div> : <div className="text-slate-500">未生成</div>}
              {c.summaryGeneratedAt && <div className="mt-1 text-xs text-slate-400">生成 {fmtDateTime(c.summaryGeneratedAt)}</div>}
            </section>
            <section className="card text-sm">
              <h2 className="mb-2 font-semibold">未了タスク</h2>
              <ul className="space-y-1">
                {c.tasks
                  .filter((t) => t.status !== 'done')
                  .map((t) => (
                    <li key={t.id}>
                      {t.title} <span className="badge badge-gray">{TASK_STATUS_LABEL[t.status as TaskStatus]}</span>
                    </li>
                  ))}
                {c.tasks.filter((t) => t.status !== 'done').length === 0 && <li className="text-slate-500">なし</li>}
              </ul>
            </section>
            <section className="card text-sm">
              <div className="mb-2 flex items-center">
                <h2 className="font-semibold">予定</h2>
                <Link to={`/forms?caseType=${c.caseType?.key ?? ''}&caseId=${c.id}`} className="btn btn-sm ml-auto">
                  この類型の書式を探す
                </Link>
              </div>
              <ul className="space-y-1">
                {c.events.slice(0, 8).map((e) => (
                  <li key={e.id} className="flex gap-2">
                    <span className="w-28 text-slate-500">{fmtDateTime(e.startAt)}</span>
                    <span className="badge badge-gray">{EVENT_KIND_LABEL[e.kind as EventKind]}</span>
                    <span>{e.title}</span>
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      )}
      {tab === 'timeline' && <Timeline caseId={c.id} />}
      {tab === 'creditors' && <Creditors caseId={c.id} stages={c.caseType?.creditorStages ?? []} />}
    </div>
  );
}

function NoteComposer({ caseId, onSaved }: { caseId: number; onSaved: () => void }) {
  const [kind, setKind] = useState<CaseNoteKind>('phone');
  const [counterpart, setCounterpart] = useState('');
  const [occurredAt, setOccurredAt] = useState(toLocalInput(new Date().toISOString()));
  const [raw, setRaw] = useState('');
  const [preview, setPreview] = useState<{ gist: string; decisions: string[]; nextActions: { title: string; due: string | null }[]; waitingFor: WaitingFor; counterpart: string | null } | null>(null);
  const [createTasks, setCreateTasks] = useState(true);
  const [err, setErr] = useState('');
  const structure = useMutation({
    mutationFn: () => api.post<typeof preview>(`/cases/${caseId}/notes/structure`, { rawText: raw, kind, counterpart: counterpart || null }),
    onSuccess: (r) => setPreview(r),
    onError: (e) => setErr((e as Error).message),
  });
  const save = useMutation({
    mutationFn: () =>
      api.post(`/cases/${caseId}/notes`, {
        kind,
        counterpart: counterpart || preview?.counterpart || null,
        occurredAt: fromLocalInput(occurredAt),
        rawText: raw,
        gist: preview?.gist ?? null,
        decisions: preview?.decisions ?? [],
        nextActions: preview?.nextActions ?? [],
        waitingFor: preview?.waitingFor ?? null,
        createTasks: createTasks && !!preview,
      }),
    onSuccess: () => {
      setRaw('');
      setPreview(null);
      setErr('');
      onSaved();
    },
    onError: (e) => setErr((e as Error).message),
  });
  return (
    <section className="card space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">記録を追加</h2>
        <select className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value as CaseNoteKind)}>
          {CASE_NOTE_KINDS.filter((k) => k !== 'policy').map((k) => (
            <option key={k} value={k}>
              {CASE_NOTE_KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <input className="input w-40" placeholder="相手（例: 相手方代理人）" value={counterpart} onChange={(e) => setCounterpart(e.target.value)} />
        <input type="datetime-local" className="input w-auto" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
      </div>
      <textarea className="input min-h-28" placeholder="走り書きで OK。例: 相手方代理人から電話。和解案として300万を提示。依頼者に持ち帰り、来週金曜までに回答。証拠の追加提出は不要とのこと。" value={raw} onChange={(e) => setRaw(e.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn" onClick={() => structure.mutate()} disabled={!raw.trim() || structure.isPending}>
          {structure.isPending ? '整理中…' : 'AI で要旨・決定事項・次のアクションに整理'}
        </button>
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={createTasks} onChange={(e) => setCreateTasks(e.target.checked)} /> 次のアクションをタスク化
        </label>
        <button className="btn btn-primary ml-auto" onClick={() => save.mutate()} disabled={!raw.trim() || save.isPending}>
          保存
        </button>
      </div>
      {err && <div className="text-sm text-red-600">{err}</div>}
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
              <ul className="ml-4 list-disc">
                {preview.nextActions.map((a, i) => (
                  <li key={i}>
                    {a.title}
                    {a.due ? `（期限 ${a.due}）` : ''}
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

function NoteView({ n, onDeleted }: { n: Note; onDeleted: () => void }) {
  const del = useMutation({ mutationFn: () => api.del(`/case-notes/${n.id}`), onSuccess: onDeleted });
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded border border-slate-100 p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="badge badge-gray">{CASE_NOTE_KIND_LABEL[n.kind as CaseNoteKind] ?? n.kind}</span>
        <span className="text-slate-500">{fmtDateTime(n.occurredAt)}</span>
        {n.counterpart && <span className="text-slate-600">{n.counterpart}</span>}
        {n.waitingFor && n.waitingFor !== 'none' && <span className="badge badge-orange">{WAITING_FOR_LABEL[n.waitingFor as WaitingFor]}待ち</span>}
        {n.createdBy === 'ai' && <span className="text-xs text-slate-400">AI 整理</span>}
        <button className="ml-auto text-xs text-slate-400 hover:text-red-600" onClick={() => confirm('削除しますか？') && del.mutate()}>
          削除
        </button>
      </div>
      <div className="mt-1 whitespace-pre-wrap">{n.gist ?? n.rawText}</div>
      {n.decisions.length > 0 && <div className="mt-1 text-slate-700">決定: {n.decisions.join(' / ')}</div>}
      {n.nextActions.length > 0 && (
        <ul className="mt-1 ml-4 list-disc text-slate-700">
          {n.nextActions.map((a, i) => (
            <li key={i}>
              {a.title}
              {a.due ? `（${a.due}）` : ''}
              {a.taskId ? <span className="badge badge-blue ml-1">タスク化済</span> : null}
            </li>
          ))}
        </ul>
      )}
      {n.gist && n.rawText && (
        <button className="mt-1 text-xs text-slate-400 hover:underline" onClick={() => setOpen(!open)}>
          {open ? '元メモを隠す' : '元メモを表示'}
        </button>
      )}
      {open && <div className="mt-1 whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-600">{n.rawText}</div>}
    </li>
  );
}

function Timeline({ caseId }: { caseId: number }) {
  const t = useQuery({ queryKey: ['timeline', caseId], queryFn: () => api.get<TimelineItem[]>(`/cases/${caseId}/timeline`) });
  return (
    <div className="card">
      <ul className="space-y-2 text-sm">
        {t.data?.map((i, idx) => (
          <li key={idx} className="flex gap-3 border-b border-slate-100 pb-2">
            <span className="w-32 shrink-0 text-slate-500">{fmtDateTime(i.at)}</span>
            <span className={`badge ${i.type.startsWith('message:in') ? 'badge-blue' : i.type.startsWith('message:out') ? 'badge-gray' : i.type.startsWith('event') ? 'badge-orange' : 'badge-gray'}`}>{typeLabel(i.type)}</span>
            <div className="min-w-0">
              {i.ref?.conversationId ? (
                <Link to={`/inbox/${i.ref.conversationId}`} className="font-medium hover:underline">
                  {i.title}
                </Link>
              ) : (
                <div className="font-medium">{i.title}</div>
              )}
              {i.body && <div className="line-clamp-2 text-slate-600">{i.body}</div>}
            </div>
          </li>
        ))}
        {t.data?.length === 0 && <li className="text-slate-500">記録がありません</li>}
      </ul>
    </div>
  );
}

function typeLabel(t: string): string {
  const [a, b] = t.split(':');
  if (a === 'message') return b === 'in' ? '受信' : '送信';
  if (a === 'note') return CASE_NOTE_KIND_LABEL[b as CaseNoteKind] ?? b;
  if (a === 'event') return EVENT_KIND_LABEL[b as EventKind] ?? b;
  if (a === 'task') return 'タスク';
  return t;
}

// ---- 債権者 ----
interface Creditor {
  id: number;
  name: string;
  kana: string | null;
  kind: string | null;
  address: string | null;
  phone: string | null;
  fax: string | null;
  emails: string[];
  contactPerson: string | null;
  claimAmount: number | null;
  claimKind: string | null;
  stage: string | null;
  lastContactAt: string | null;
  nextAction: string | null;
  nextActionDue: string | null;
  note: string | null;
  lastEvent: { channel: string; summary: string; occurredAt: string } | null;
}
interface Dashboard {
  total: number;
  byStage: Record<string, number>;
  unstaged: number;
  overdue: Creditor[];
  stale: Creditor[];
  totalClaim: number;
  stages: string[];
}

function Creditors({ caseId, stages }: { caseId: number; stages: string[] }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['creditors', caseId], queryFn: () => api.get<{ creditors: Creditor[]; dashboard: Dashboard }>(`/cases/${caseId}/creditors`) });
  const [selected, setSelected] = useState<number[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [filterStage, setFilterStage] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['creditors', caseId] });
  const bulk = useMutation({ mutationFn: (ev: Record<string, unknown>) => api.post('/creditors/bulk-event', { creditorIds: selected, event: ev }), onSuccess: () => { setSelected([]); refresh(); } });
  const [bulkStage, setBulkStage] = useState('');
  const [bulkSummary, setBulkSummary] = useState('');
  const [bulkChannel, setBulkChannel] = useState('post');
  if (!q.data) return <div className="text-slate-500">読み込み中…</div>;
  const { creditors, dashboard } = q.data;
  const rows = filterStage ? creditors.filter((c) => (filterStage === '__none' ? !c.stage : c.stage === filterStage)) : creditors;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <div className="card py-2">
          <div className="text-xs text-slate-500">債権者数</div>
          <div className="text-xl font-bold">{dashboard.total}</div>
        </div>
        <div className="card py-2">
          <div className="text-xs text-slate-500">債権額合計</div>
          <div className="text-xl font-bold">{fmtYen(dashboard.totalClaim)}</div>
        </div>
        <div className="card py-2">
          <div className="text-xs text-slate-500">期限超過</div>
          <div className={`text-xl font-bold ${dashboard.overdue.length ? 'text-orange-600' : ''}`}>{dashboard.overdue.length}</div>
        </div>
        <div className="card py-2">
          <div className="text-xs text-slate-500">30日以上接触なし</div>
          <div className="text-xl font-bold">{dashboard.stale.length}</div>
        </div>
        <div className="card py-2">
          <div className="text-xs text-slate-500">段階未設定</div>
          <div className="text-xl font-bold">{dashboard.unstaged}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        <button className={`btn btn-sm ${!filterStage ? 'btn-primary' : ''}`} onClick={() => setFilterStage('')}>
          すべて
        </button>
        {stages.map((s) => (
          <button key={s} className={`btn btn-sm ${filterStage === s ? 'btn-primary' : ''}`} onClick={() => setFilterStage(s)}>
            {s} <span className="ml-1 rounded bg-slate-200 px-1 text-slate-700">{dashboard.byStage[s] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-sm" onClick={() => setShowNew(!showNew)}>
          ＋ 債権者を追加
        </button>
        <button className="btn btn-sm" onClick={() => setShowImport(!showImport)}>
          Excel 取込
        </button>
        <a className="btn btn-sm" href={`/api/cases/${caseId}/creditors/export`}>
          Excel 出力
        </a>
        {selected.length > 0 && (
          <div className="ml-auto flex flex-wrap items-center gap-1 rounded border border-blue-200 bg-blue-50 p-2 text-xs">
            <span className="font-semibold">{selected.length} 件を一括:</span>
            <select className="input w-auto" value={bulkStage} onChange={(e) => setBulkStage(e.target.value)}>
              <option value="">段階を変更しない</option>
              {stages.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <select className="input w-auto" value={bulkChannel} onChange={(e) => setBulkChannel(e.target.value)}>
              {CREDITOR_EVENT_CHANNELS.filter((c) => c !== 'stage').map((c) => (
                <option key={c} value={c}>
                  {CREDITOR_EVENT_CHANNEL_LABEL[c]}
                </option>
              ))}
            </select>
            <input className="input w-48" placeholder="記録内容（例: 受任通知を発送）" value={bulkSummary} onChange={(e) => setBulkSummary(e.target.value)} />
            <button className="btn btn-primary btn-sm" onClick={() => bulk.mutate({ channel: bulkChannel, direction: 'out', summary: bulkSummary || (bulkStage ? `段階を「${bulkStage}」へ` : '記録'), stageAfter: bulkStage || null })}>
              記録する
            </button>
          </div>
        )}
      </div>
      {showNew && <CreditorForm caseId={caseId} stages={stages} onDone={() => { setShowNew(false); refresh(); }} />}
      {showImport && <ExcelImport caseId={caseId} onDone={() => { setShowImport(false); refresh(); }} />}
      <div className="card p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-2 py-2">
                <input type="checkbox" checked={selected.length === rows.length && rows.length > 0} onChange={(e) => setSelected(e.target.checked ? rows.map((r) => r.id) : [])} />
              </th>
              <th className="px-2 py-2">債権者</th>
              <th className="px-2 py-2">債権額</th>
              <th className="px-2 py-2">段階</th>
              <th className="px-2 py-2">最終接触</th>
              <th className="px-2 py-2">次のアクション</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const over = c.nextActionDue && new Date(c.nextActionDue).getTime() < Date.now();
              return (
                <>
                  <tr key={c.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-2 py-2">
                      <input type="checkbox" checked={selected.includes(c.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, c.id] : selected.filter((x) => x !== c.id))} />
                    </td>
                    <td className="px-2 py-2">
                      <button className="font-medium text-blue-700 hover:underline" onClick={() => setOpen(open === c.id ? null : c.id)}>
                        {c.name}
                      </button>
                      {c.kind && <span className="ml-1 text-xs text-slate-500">{c.kind}</span>}
                    </td>
                    <td className="px-2 py-2">{fmtYen(c.claimAmount)}</td>
                    <td className="px-2 py-2">{c.stage ? <span className="badge badge-blue">{c.stage}</span> : <span className="text-slate-400">未設定</span>}</td>
                    <td className="px-2 py-2 text-xs text-slate-500">
                      {c.lastContactAt ? fmtDate(c.lastContactAt) : '—'}
                      {c.lastEvent && <div className="line-clamp-1">{CREDITOR_EVENT_CHANNEL_LABEL[c.lastEvent.channel as keyof typeof CREDITOR_EVENT_CHANNEL_LABEL]} {c.lastEvent.summary}</div>}
                    </td>
                    <td className="px-2 py-2 text-xs">
                      {c.nextAction}
                      {c.nextActionDue && <span className={`ml-1 ${over ? 'font-semibold text-orange-600' : 'text-slate-500'}`}>（{fmtDate(c.nextActionDue)}）</span>}
                    </td>
                  </tr>
                  {open === c.id && (
                    <tr key={`${c.id}-d`}>
                      <td colSpan={6} className="bg-slate-50 px-4 py-3">
                        <CreditorDetail c={c} stages={stages} caseId={caseId} onChange={refresh} />
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-4 text-slate-500">
                  債権者が登録されていません。Excel 取込または手動追加してください。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CreditorForm({ caseId, stages, initial, onDone }: { caseId: number; stages: string[]; initial?: Creditor; onDone: () => void }) {
  const [f, setF] = useState<Partial<Creditor>>(initial ?? { emails: [] });
  const save = useMutation({
    mutationFn: () => (initial ? api.put(`/creditors/${initial.id}`, { ...f, caseId }) : api.post('/creditors', { ...f, caseId })),
    onSuccess: onDone,
  });
  const set = (k: keyof Creditor, v: unknown) => setF({ ...f, [k]: v });
  return (
    <form
      className="card grid gap-2 text-sm md:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <input className="input" required placeholder="債権者名" value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} />
      <input className="input" placeholder="種別（金融機関/公租公課/取引先…）" value={f.kind ?? ''} onChange={(e) => set('kind', e.target.value)} />
      <input className="input" type="number" placeholder="債権額" value={f.claimAmount ?? ''} onChange={(e) => set('claimAmount', e.target.value ? Number(e.target.value) : null)} />
      <input className="input" placeholder="住所" value={f.address ?? ''} onChange={(e) => set('address', e.target.value)} />
      <input className="input" placeholder="電話" value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
      <input className="input" placeholder="FAX" value={f.fax ?? ''} onChange={(e) => set('fax', e.target.value)} />
      <input className="input" placeholder="メール（カンマ区切り）" value={(f.emails ?? []).join(', ')} onChange={(e) => set('emails', e.target.value.split(/[,、\s]+/).filter(Boolean))} />
      <input className="input" placeholder="担当者" value={f.contactPerson ?? ''} onChange={(e) => set('contactPerson', e.target.value)} />
      <select className="input" value={f.stage ?? ''} onChange={(e) => set('stage', e.target.value || null)}>
        <option value="">段階未設定</option>
        {stages.map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      <input className="input" placeholder="次のアクション" value={f.nextAction ?? ''} onChange={(e) => set('nextAction', e.target.value)} />
      <input className="input" type="date" value={f.nextActionDue?.slice(0, 10) ?? ''} onChange={(e) => set('nextActionDue', e.target.value || null)} />
      <input className="input" placeholder="備考" value={f.note ?? ''} onChange={(e) => set('note', e.target.value)} />
      <div className="flex gap-2 md:col-span-3">
        <button className="btn btn-primary">保存</button>
        <button type="button" className="btn" onClick={onDone}>
          閉じる
        </button>
      </div>
    </form>
  );
}

function CreditorDetail({ c, stages, caseId, onChange }: { c: Creditor; stages: string[]; caseId: number; onChange: () => void }) {
  const qc = useQueryClient();
  const events = useQuery({ queryKey: ['creditor-events', c.id], queryFn: () => api.get<{ id: number; occurredAt: string; channel: string; direction: string | null; summary: string; stageAfter: string | null; conversationId: number | null }[]>(`/creditors/${c.id}/events`) });
  const [edit, setEdit] = useState(false);
  const [ev, setEv] = useState({ channel: 'phone', direction: 'out', summary: '', stageAfter: '' });
  const add = useMutation({
    mutationFn: () => api.post(`/creditors/${c.id}/events`, { ...ev, stageAfter: ev.stageAfter || null }),
    onSuccess: () => {
      setEv({ ...ev, summary: '', stageAfter: '' });
      qc.invalidateQueries({ queryKey: ['creditor-events', c.id] });
      onChange();
    },
  });
  const del = useMutation({ mutationFn: () => api.del(`/creditors/${c.id}`), onSuccess: onChange });
  return (
    <div className="space-y-3 text-sm">
      <div className="grid gap-1 text-xs text-slate-600 md:grid-cols-3">
        <div>住所: {c.address ?? '—'}</div>
        <div>電話: {c.phone ?? '—'} / FAX: {c.fax ?? '—'}</div>
        <div>メール: {c.emails.join(', ') || '—'}</div>
        <div>担当: {c.contactPerson ?? '—'}</div>
        <div>債権種別: {c.claimKind ?? '—'}</div>
        <div>備考: {c.note ?? '—'}</div>
      </div>
      <div className="flex gap-2">
        <button className="btn btn-sm" onClick={() => setEdit(!edit)}>
          編集
        </button>
        <button className="btn btn-sm" onClick={() => confirm('この債権者を削除しますか？') && del.mutate()}>
          削除
        </button>
      </div>
      {edit && <CreditorForm caseId={caseId} stages={stages} initial={c} onDone={() => { setEdit(false); onChange(); }} />}
      <div className="rounded border border-slate-200 bg-white p-2">
        <div className="mb-1 text-xs font-semibold">やり取りを記録</div>
        <div className="flex flex-wrap gap-1">
          <select className="input w-auto" value={ev.channel} onChange={(e) => setEv({ ...ev, channel: e.target.value })}>
            {CREDITOR_EVENT_CHANNELS.filter((x) => x !== 'stage').map((x) => (
              <option key={x} value={x}>
                {CREDITOR_EVENT_CHANNEL_LABEL[x]}
              </option>
            ))}
          </select>
          <select className="input w-auto" value={ev.direction} onChange={(e) => setEv({ ...ev, direction: e.target.value })}>
            <option value="out">こちらから</option>
            <option value="in">先方から</option>
          </select>
          <input className="input flex-1" placeholder="内容" value={ev.summary} onChange={(e) => setEv({ ...ev, summary: e.target.value })} />
          <select className="input w-auto" value={ev.stageAfter} onChange={(e) => setEv({ ...ev, stageAfter: e.target.value })}>
            <option value="">段階そのまま</option>
            {stages.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <button className="btn btn-primary btn-sm" onClick={() => add.mutate()} disabled={!ev.summary}>
            記録
          </button>
        </div>
      </div>
      <ul className="space-y-1 text-xs">
        {events.data?.map((e) => (
          <li key={e.id} className="flex gap-2">
            <span className="w-28 text-slate-500">{fmtDateTime(e.occurredAt)}</span>
            <span className="badge badge-gray">{CREDITOR_EVENT_CHANNEL_LABEL[e.channel as keyof typeof CREDITOR_EVENT_CHANNEL_LABEL] ?? e.channel}</span>
            {e.direction && <span className="text-slate-500">{e.direction === 'in' ? '受' : '送'}</span>}
            {e.conversationId ? (
              <Link to={`/inbox/${e.conversationId}`} className="hover:underline">
                {e.summary}
              </Link>
            ) : (
              <span>{e.summary}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExcelImport({ caseId, onDone }: { caseId: number; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ headers: string[]; rows: string[][]; mapping: Record<string, number>; fields: string[] } | null>(null);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [result, setResult] = useState<string>('');
  const doPreview = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append('file', file!);
      return api.upload<typeof preview>(`/cases/${caseId}/creditors/import/preview`, fd);
    },
    onSuccess: (p) => {
      setPreview(p);
      setMapping(p!.mapping);
    },
    onError: (e) => setResult((e as Error).message),
  });
  const doImport = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append('file', file!);
      fd.append('mapping', JSON.stringify(mapping));
      return api.upload<{ created: number; updated: number }>(`/cases/${caseId}/creditors/import`, fd);
    },
    onSuccess: (r) => {
      setResult(`取込完了: 新規 ${r.created} 件、更新 ${r.updated} 件`);
      onDone();
    },
    onError: (e) => setResult((e as Error).message),
  });
  return (
    <div className="card space-y-2 text-sm">
      <div className="flex items-center gap-2">
        <input type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button className="btn btn-sm" onClick={() => doPreview.mutate()} disabled={!file}>
          列を確認
        </button>
      </div>
      {preview && (
        <>
          <div className="grid gap-1 md:grid-cols-4">
            {preview.fields.map((f) => (
              <label key={f} className="flex items-center gap-1 text-xs">
                <span className="w-16">{CREDITOR_IMPORT_FIELD_LABEL[f as keyof typeof CREDITOR_IMPORT_FIELD_LABEL]}</span>
                <select className="input" value={mapping[f] ?? ''} onChange={(e) => setMapping({ ...mapping, [f]: Number(e.target.value) })}>
                  <option value="">（なし）</option>
                  {preview.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `列${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="max-h-40 overflow-auto rounded border border-slate-200">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  {preview.headers.map((h, i) => (
                    <th key={i} className="bg-slate-50 px-1 py-0.5 text-left">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 5).map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j} className="border-t px-1 py-0.5">
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => doImport.mutate()} disabled={mapping.name === undefined}>
            この対応で取り込む（同名・同住所は更新）
          </button>
        </>
      )}
      {result && <div className="text-xs text-slate-700">{result}</div>}
    </div>
  );
}
