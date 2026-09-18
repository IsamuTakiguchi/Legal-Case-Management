import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useDraftRecord, useDraftGroup, useDraft, DraftHint } from '../lib/draft';
import { RoomPicker } from '../lib/RoomPicker';
import { HoldForm, fmtEventRange, type RescheduleTarget } from '../lib/HoldForm';
import { LongText } from '../lib/LongText';
import { TaskDeadlineSelect } from '../lib/Deadline';
import { StaffAskPanel } from '../lib/StaffAskPanel';
import { fmtDateTime, fmtDate, fmtYen, toLocalInput, fromLocalInput, channelLabel } from '../lib/format';
import { CASE_NOTE_KINDS, CASE_NOTE_KIND_LABEL, WAITING_FOR, WAITING_FOR_LABEL, EVENT_KINDS, CREDITOR_EVENT_CHANNELS, CREDITOR_EVENT_CHANNEL_LABEL, CREDITOR_IMPORT_FIELD_LABEL, EVENT_KIND_LABEL, TASK_STATUS_LABEL, CASE_STATUSES, CASE_STATUS_LABEL, CASE_CONTACT_ROLES, CASE_CONTACT_ROLE_LABEL, type CaseNoteKind, type WaitingFor, type EventKind, type TaskStatus } from '@lcm/shared';
import { CaseStatusBadge } from './Cases';

interface Note {
  id: number;
  kind: string;
  occurredAt: string;
  counterpart: string | null;
  phone: string | null;
  rawText: string | null;
  gist: string | null;
  theirSaid: string[];
  ourSaid: string[];
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
  staffId: number | null;
  chatworkRoomId: number | null;
  staff: { id: number; name: string } | null;
  notes: Note[];
  tasks: { id: number; title: string; status: string; dueAt: string | null; followUpAt: string | null }[];
  events: { id: number; title: string; startAt: string; endAt: string; kind: string; location: string | null; status: string | null }[];
}
/** 次のアクションの期限。YYYY-MM-DD でも ISO でも「9/20(日)」の形にする */
function fmtDue(due?: string | null): string {
  if (!due) return '';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T00:00:00+09:00` : due);
  return Number.isNaN(d.getTime()) ? due : fmtDate(d.toISOString());
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
  // ダッシュボードの「最近の動き」から #note-ID で開かれたら、その記録まで運ぶ
  const loaded = !!d.data;
  useEffect(() => {
    const hash = location.hash;
    if (!loaded || !/^#note-\d+$/.test(hash)) return;
    const t = setTimeout(() => document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
    return () => clearTimeout(t);
  }, [loaded]);
  // 期日の記録を保存した直後（または記録の「依頼者に期日連絡」）に開く連絡パネル
  const [noticeNoteId, setNoticeNoteId] = useState<number | null>(null);
  // 「予定」から選んだ、日程変更（リスケ）する予定
  const [rescheduling, setRescheduling] = useState<RescheduleTarget | null>(null);
  const holds = useCaseHolds(id ? Number(id) : null);
  const types = useQuery({ queryKey: ['case-types'], queryFn: () => api.get<{ key: string; label: string }[]>('/case-types') });
  const c = d.data;
  const [form, setForm] = useState({ title: '', caseType: '', courtName: '', caseNumber: '', stage: '', policy: '', status: 'active', staffId: '', chatworkRoomId: '' });
  useEffect(() => {
    if (c) setForm({ title: c.title, caseType: c.caseType?.key ?? 'general_civil', courtName: c.courtName ?? '', caseNumber: c.caseNumber ?? '', stage: c.stage ?? '', policy: c.policy ?? '', status: c.status, staffId: c.staffId ? String(c.staffId) : '', chatworkRoomId: c.chatworkRoomId ? String(c.chatworkRoomId) : '' });
  }, [c]);
  // 入力途中の内容はこの端末に自動保存する（保存前に画面を離れても消えない）
  const caseBase = c
    ? { title: c.title, caseType: c.caseType?.key ?? 'general_civil', courtName: c.courtName ?? '', caseNumber: c.caseNumber ?? '', stage: c.stage ?? '', policy: c.policy ?? '', status: c.status, staffId: c.staffId ? String(c.staffId) : '', chatworkRoomId: c.chatworkRoomId ? String(c.chatworkRoomId) : '' }
    : null;
  const caseDraft = useDraftRecord(id ? `case:${id}:edit` : null, form, setForm, caseBase);
  const staffList = useQuery({ queryKey: ['staff'], queryFn: () => api.get<{ id: number; name: string }[]>('/staff') });
  const save = useMutation({
    mutationFn: () => api.put(`/cases/${id}`, { ...form, staffId: form.staffId ? Number(form.staffId) : null, chatworkRoomId: form.chatworkRoomId ? Number(form.chatworkRoomId) : null }),
    onSuccess: () => {
      caseDraft.clear();
      qc.invalidateQueries({ queryKey: ['case', id] });
      qc.invalidateQueries({ queryKey: ['cases'] });
    },
  });
  const summary = useMutation({ mutationFn: () => api.post(`/cases/${id}/summary`), onSuccess: () => qc.invalidateQueries({ queryKey: ['case', id] }) });
  if (!c) return <div className="loading-text text-slate-500">読み込み中…</div>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/cases" className="text-sm text-slate-500 hover:underline">
          ← 事件
        </Link>
        <h1 className="text-xl font-bold">{c.title}</h1>
        <CaseStatusBadge status={c.status} />
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
            <NoteComposer
              caseId={c.id}
              onSaved={(note) => {
                qc.invalidateQueries({ queryKey: ['case', id] });
                if (note?.kind === 'court') setNoticeNoteId(note.id);
              }}
            />
            {noticeNoteId && (
              <HearingNoticePanel
                noteId={noticeNoteId}
                onClose={() => setNoticeNoteId(null)}
                onSent={() => {
                  setNoticeNoteId(null);
                  qc.invalidateQueries({ queryKey: ['case', id] });
                  qc.invalidateQueries({ queryKey: ['timeline', c.id] });
                }}
              />
            )}
            <CaseHolds
              caseId={c.id}
              clientId={c.client?.id ?? null}
              clientName={c.client?.name ?? null}
              caseTitle={c.title}
              reschedule={rescheduling}
              onRescheduleClose={() => setRescheduling(null)}
            />
            <section className="card">
              <h2 className="mb-2 font-semibold">記録（電話・打合せ・メモ）</h2>
              <ul className="space-y-3">
                {c.notes
                  .filter((n) => n.kind !== 'policy')
                  .map((n) => (
                    <NoteView key={n.id} n={n} onDeleted={() => qc.invalidateQueries({ queryKey: ['case', id] })} onNotice={n.kind === 'court' ? () => setNoticeNoteId(n.id) : undefined} />
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
                {CASE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {CASE_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
              <div>
                <label className="label">担当事務局</label>
                <select className="input" value={form.staffId} onChange={(e) => setForm({ ...form, staffId: e.target.value })}>
                  <option value="">（未設定）</option>
                  {staffList.data?.map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.name}
                    </option>
                  ))}
                </select>
                <div className="mt-0.5 text-xs text-slate-400">この事件から作る Chatwork タスクは担当者に振ります。メンバーは設定 → 事務局メンバーで登録</div>
              </div>
              <div>
                <label className="label">事件専用の Chatwork ルーム</label>
                <RoomPicker value={form.chatworkRoomId} onChange={(v) => setForm({ ...form, chatworkRoomId: v })} emptyLabel="（なし。全体ルームの伝言は本文の依頼者名で振り分け）" />
                <div className="mt-0.5 text-xs text-slate-400">このルームのメッセージはすべてこの事件の記録に入ります</div>
              </div>
              <div>
                <label className="label">方針メモ {c.policyUpdatedAt && <span className="font-normal text-slate-400">（更新 {fmtDate(c.policyUpdatedAt)}）</span>}</label>
                <textarea className="input min-h-32" value={form.policy} onChange={(e) => setForm({ ...form, policy: e.target.value })} placeholder="今後の方針、争点、依頼者の希望など" />
                <DraftHint handle={caseDraft} />
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
            <ContactsSection caseId={c.id} />
            <section className="card text-sm">
              <h2 className="mb-2 font-semibold">未了タスク</h2>
              <ul className="mb-3 space-y-1">
                {c.tasks
                  .filter((t) => t.status !== 'done')
                  .map((t) => {
                    const limit = t.status === 'open' ? (t.dueAt ?? t.followUpAt) : (t.followUpAt ?? t.dueAt);
                    const over = limit ? new Date(limit).getTime() < Date.now() : false;
                    return (
                      <li key={t.id} className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1">{t.title}</span>
                        <span className="badge badge-gray">{TASK_STATUS_LABEL[t.status as TaskStatus]}</span>
                        {limit && (
                          <span className={`whitespace-nowrap text-xs ${over ? 'font-semibold text-orange-600' : 'text-slate-500'}`}>
                            {t.status === 'open' ? '期日' : '期限'} {fmtDate(limit)}
                          </span>
                        )}
                      </li>
                    );
                  })}
                {c.tasks.filter((t) => t.status !== 'done').length === 0 && <li className="text-slate-500">なし</li>}
              </ul>
              <CaseTaskForm
                caseId={c.id}
                hasStaff={!!c.staff}
                onDone={() => {
                  qc.invalidateQueries({ queryKey: ['case', id] });
                  qc.invalidateQueries({ queryKey: ['tasks'] });
                }}
              />
            </section>
            <section className="card text-sm">
              <div className="mb-2 flex items-center">
                <h2 className="font-semibold">予定</h2>
                <Link to={`/forms?caseType=${c.caseType?.key ?? ''}&caseId=${c.id}`} className="btn btn-sm ml-auto">
                  この類型の書式を探す
                </Link>
              </div>
              <ul className="space-y-1">
                {c.events.slice(0, 8).map((e) => {
                  const resch = holds.data?.find((h) => h.rescheduleOf?.eventId === e.id);
                  const future = new Date(e.startAt).getTime() > Date.now();
                  return (
                    <li key={e.id} className="flex flex-wrap items-center gap-2">
                      <span className="w-28 text-slate-500">{fmtDateTime(e.startAt)}</span>
                      <span className="badge badge-gray">{EVENT_KIND_LABEL[e.kind as EventKind]}</span>
                      <span className="min-w-0 flex-1">{e.title}</span>
                      {resch ? (
                        <span className="badge badge-blue" title="変更後の候補を仮押さえ中です">
                          日程変更の調整中
                        </span>
                      ) : (
                        future &&
                        e.kind !== 'hold' && (
                          <button
                            className="btn btn-sm"
                            onClick={() => {
                              setRescheduling({ eventId: e.id, title: e.title, startAt: e.startAt, endAt: e.endAt, clientName: c.client?.name ?? null, caseTitle: c.title, location: e.location });
                              // 入力欄は左側の「日程調整」にあるので、そこまで動かす
                              setTimeout(() => document.getElementById('case-holds')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
                            }}
                            title="この予定を別の日時に変更するため、候補をまとめて仮押さえします"
                          >
                            リスケ
                          </button>
                        )
                      )}
                    </li>
                  );
                })}
                {c.events.length === 0 && <li className="text-slate-500">なし</li>}
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

interface HoldCandidate {
  eventId: number | null;
  googleEventId: string;
  startAt: string;
  endAt: string;
  title: string | null;
  location: string | null;
}
interface HoldSet {
  sessionId: number;
  kind: string;
  proposedAt: string | null;
  /** 日程変更（リスケ）なら、元の予定 */
  rescheduleOf: { eventId: number; title: string; startAt: string; endAt: string } | null;
  clientId: number | null;
  clientName: string | null;
  conversationId: number | null;
  linkedToCase: boolean;
  candidates: HoldCandidate[];
}

function fmtSlot(startAt: string, endAt: string): string {
  const t = (iso: string) => new Date(iso).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
  return `${fmtDate(startAt)} ${t(startAt)}〜${t(endAt)}`;
}

/** この事件の調整中の仮押さえ（「日程調整」欄と「予定」欄で共有する） */
function useCaseHolds(caseId: number | null) {
  return useQuery({ queryKey: ['case-holds', caseId ?? 0], queryFn: () => api.get<HoldSet[]>(`/cases/${caseId}/holds`), enabled: !!caseId });
}

/**
 * 調整中の仮押さえを事件ページから扱う。
 * 相手が選んだ候補で確定（ほかの候補は自動で削除）、まとめて取消、この事件への紐付け、新しい仮押さえの追加ができる。
 */
interface ProposalCtx {
  sessionId: number;
  kind: string;
  clientName: string | null;
  candidates: { startAt: string; endAt: string }[];
  conversations: { id: number; channel: string; counterpartName: string | null; lastMessageAt: string | null; preferred: boolean }[];
  defaultConversationId: number | null;
  text: string;
  defaultFollowUpAt: string;
  blocked: string | null;
}

/**
 * 仮押さえた候補日を依頼者に打診する。
 * 既定はテンプレートどおりの文（AI を使わないので待ち時間も利用料もない）。
 * 「自分の文体で整える」を押すと、いつもの言い回しに書き直す。
 */
function HoldProposalPanel({ sessionId, onClose, onSent }: { sessionId: number; onClose: () => void; onSent: (msg: string) => void }) {
  const ctx = useQuery({ queryKey: ['hold-proposal', sessionId], queryFn: () => api.get<ProposalCtx>(`/calendar/holds/${sessionId}/proposal`) });
  const [conversationId, setConversationId] = useState('');
  const [text, setText] = useState('');
  const [instruction, setInstruction] = useState('');
  const [waiting, setWaiting] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const d = ctx.data;
  useEffect(() => {
    if (!d) return;
    setConversationId(d.defaultConversationId ? String(d.defaultConversationId) : '');
    // 画面で直した本文は残す（読み込み直しで消さない）
    setText((prev) => prev || d.text);
  }, [d]);
  // 書きかけの打診文はこの端末に自動保存する
  const draft = useDraft(`hold:${sessionId}:proposal`, text, setText, '');

  const restyle = useMutation({
    mutationFn: () => api.post<{ text: string }>(`/calendar/holds/${sessionId}/proposal/draft`, { conversationId: conversationId ? Number(conversationId) : null, instruction: instruction || null }),
    onSuccess: (r) => {
      setText(r.text);
      setErr(null);
    },
    onError: (e) => setErr((e as Error).message),
  });
  const send = useMutation({
    mutationFn: () =>
      api.post<{ note: string | null }>(`/calendar/holds/${sessionId}/proposal`, {
        conversationId: Number(conversationId),
        text,
        createWaitingTask: waiting,
        followUpAt: waiting ? d?.defaultFollowUpAt : null,
      }),
    onSuccess: (r) => {
      draft.clear();
      onSent(`候補日を打診しました${waiting ? '。返事待ちのタスクも作りました' : ''}${r.note ? `（${r.note}）` : ''}`);
    },
    onError: (e) => setErr((e as Error).message),
  });

  return (
    <div className="fade-in mt-1 space-y-2 rounded border border-blue-200 bg-blue-50/30 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">候補日を依頼者に打診</span>
        {ctx.isLoading && <span className="loading-text text-xs text-slate-500">読み込み中…</span>}
        <button className="ml-auto text-xs text-slate-500 hover:underline" onClick={onClose}>
          閉じる
        </button>
      </div>
      {d?.blocked && <div className="rounded bg-orange-50 px-2 py-1 text-xs text-orange-800">{d.blocked}</div>}
      {d && !d.blocked && (
        <>
          <label className="flex flex-wrap items-center gap-1 text-xs">
            送り先
            <select className="input w-auto py-0.5" value={conversationId} onChange={(e) => setConversationId(e.target.value)}>
              {d.conversations.map((c) => (
                <option key={c.id} value={c.id}>
                  {channelLabel(c.channel)}
                  {c.preferred ? '（いつもの連絡先）' : ''}
                  {c.counterpartName ? ` / ${c.counterpartName}` : ''}
                </option>
              ))}
            </select>
          </label>
          <textarea className="input min-h-28 text-sm" value={text} onChange={(e) => setText(e.target.value)} />
          <DraftHint handle={draft} />
          <div className="flex flex-wrap items-center gap-2">
            <input className="input min-w-0 flex-1 py-0.5 text-xs" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="AI への指示（例: 事務所での面談であることも書く）" />
            <button className="btn btn-sm" onClick={() => restyle.mutate()} disabled={restyle.isPending} title="いつもの言い回しに書き直します（候補の日時はそのまま）">
              {restyle.isPending ? '整えています…' : '自分の文体で整える'}
            </button>
            <button className="btn btn-sm" onClick={() => setText(d.text)} title="テンプレートどおりの文に戻します">
              元に戻す
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={waiting} onChange={(e) => setWaiting(e.target.checked)} /> 「返事待ち」のタスクも作る
            </label>
            <button className="btn btn-primary btn-sm ml-auto" onClick={() => send.mutate()} disabled={!text.trim() || !conversationId || send.isPending}>
              {send.isPending ? '送信中…' : `${channelLabel(d.conversations.find((c) => c.id === Number(conversationId))?.channel ?? '')} で送る`}
            </button>
          </div>
          {err && <div className="text-xs text-red-600">{err}</div>}
        </>
      )}
    </div>
  );
}

function CaseHolds({
  caseId,
  clientId,
  clientName,
  caseTitle,
  reschedule,
  onRescheduleClose,
}: {
  caseId: number;
  clientId: number | null;
  clientName: string | null;
  caseTitle: string;
  /** 「予定」欄の「リスケ」で選んだ、日程変更する予定 */
  reschedule: RescheduleTarget | null;
  onRescheduleClose: () => void;
}) {
  const qc = useQueryClient();
  const q = useCaseHolds(caseId);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  // 候補日の打診を開いている日程調整
  const [proposing, setProposing] = useState<number | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['case-holds', caseId] });
    qc.invalidateQueries({ queryKey: ['case', String(caseId)] });
    qc.invalidateQueries({ queryKey: ['calendar'] });
    qc.invalidateQueries({ queryKey: ['timeline', caseId] });
  };
  const fail = (e: unknown) => setMsg({ kind: 'err', text: (e as Error).message });
  const confirmHold = useMutation({
    mutationFn: (v: { sessionId: number; eventId: number }) => api.post<{ webText?: string }>(`/calendar/holds/${v.sessionId}/confirm`, { eventId: v.eventId }),
    onSuccess: (r) => {
      refresh();
      setMsg({ kind: 'ok', text: `確定しました。ほかの候補の仮押さえは削除しました${r.webText ? `\n${r.webText}` : ''}` });
    },
    onError: fail,
  });
  const cancelHold = useMutation({
    mutationFn: (sessionId: number) => api.post(`/calendar/holds/${sessionId}/cancel`),
    onSuccess: () => {
      refresh();
      setMsg({ kind: 'ok', text: '仮押さえをすべて取り消しました' });
    },
    onError: fail,
  });
  const attach = useMutation({
    mutationFn: (sessionId: number) => api.post(`/cases/${caseId}/holds/${sessionId}/attach`),
    onSuccess: () => {
      refresh();
      setMsg({ kind: 'ok', text: 'この事件の日程調整として紐付けました' });
    },
    onError: fail,
  });
  const sets = q.data ?? [];
  return (
    <section className="card space-y-2" id="case-holds">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">日程調整（仮押さえ中）</h2>
        {sets.length > 0 && <span className="badge badge-orange">{sets.length} 件</span>}
        {!adding && (
          <button className="btn btn-sm ml-auto" onClick={() => setAdding(true)} title="候補日時をまとめて仮押さえします">
            ＋ 仮押さえを追加
          </button>
        )}
        <Link to={`/calendar`} className={`btn btn-sm${adding ? ' ml-auto' : ''}`}>
          予定を見る
        </Link>
      </div>
      {msg && <div className={`fade-in whitespace-pre-wrap break-words rounded-md px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'}`}>{msg.text}</div>}
      {reschedule && (
        <HoldForm
          defaultDay={new Date(new Date(reschedule.startAt).getTime() + 9 * 3600_000).toISOString().slice(0, 10)}
          reschedule={reschedule}
          onClose={onRescheduleClose}
          onSaved={(text, sessionId) => {
            onRescheduleClose();
            refresh();
            setMsg({ kind: 'ok', text });
            if (sessionId) setProposing(sessionId);
          }}
          onError={(text) => setMsg({ kind: 'err', text })}
        />
      )}
      {adding && (
        <HoldForm
          defaultDay={new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)}
          fixed={{ clientId, clientName, caseId, caseTitle }}
          onClose={() => setAdding(false)}
          onSaved={(text, sessionId) => {
            setAdding(false);
            refresh();
            setMsg({ kind: 'ok', text });
            // 登録したらそのまま打診にすすめる
            if (sessionId) setProposing(sessionId);
          }}
          onError={(text) => setMsg({ kind: 'err', text })}
        />
      )}
      {q.isLoading && <div className="loading-text text-sm text-slate-500">読み込み中…</div>}
      {!q.isLoading && sets.length === 0 && !adding && <div className="text-sm text-slate-500">調整中の仮押さえはありません。候補日時をまとめて押さえるときは「＋ 仮押さえを追加」から。</div>}
      <ul className="space-y-3">
        {sets.map((s) => (
          <li key={s.sessionId} className="rounded border border-slate-200 p-2 text-sm">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className={`badge ${s.rescheduleOf ? 'badge-blue' : 'badge-gray'}`}>{s.rescheduleOf ? '日程変更' : s.kind}</span>
              <span className="font-medium">{s.candidates[0]?.title?.replace(/\s*仮$/, '') ?? '日程調整'}</span>
              <span className="text-xs text-slate-500">候補 {s.candidates.length} 件</span>
              {s.proposedAt && <span className="text-xs text-slate-400">{fmtDate(s.proposedAt)} 提案</span>}
              {!s.linkedToCase && <span className="badge badge-orange">この事件に未紐付け</span>}
              {s.conversationId && (
                <Link to={`/inbox/${s.conversationId}`} className="text-xs text-blue-700 hover:underline">
                  会話を開く
                </Link>
              )}
              <button
                className="btn btn-sm btn-primary ml-auto"
                onClick={() => setProposing(proposing === s.sessionId ? null : s.sessionId)}
                title="候補日を並べた文を作って、依頼者に送ります"
              >
                候補日を打診
              </button>
              <button
                className="btn btn-sm"
                disabled={cancelHold.isPending}
                onClick={() => {
                  if (window.confirm(`この日程調整の仮押さえ ${s.candidates.length} 件をすべて取り消しますか？`)) cancelHold.mutate(s.sessionId);
                }}
                title="候補をすべて取り消す"
              >
                全候補を取消
              </button>
            </div>
            {s.rescheduleOf && (
              <div className="mb-1 rounded bg-blue-50 px-2 py-1 text-xs text-blue-900">
                いまの予定は <b>{fmtEventRange(s.rescheduleOf.startAt, s.rescheduleOf.endAt)}</b>。候補を確定すると、この予定は消えて新しい日時に置き換わります。
              </div>
            )}
            {!s.linkedToCase && (
              <div className="mb-1 flex flex-wrap items-center gap-2 rounded bg-orange-50 px-2 py-1 text-xs text-orange-800">
                <span>会話から始めた日程調整です。紐付けると、確定した予定がこの事件の「予定」に入ります。</span>
                <button className="btn btn-sm" disabled={attach.isPending} onClick={() => attach.mutate(s.sessionId)}>
                  この事件に紐付ける
                </button>
              </div>
            )}
            {proposing === s.sessionId && (
              <HoldProposalPanel
                sessionId={s.sessionId}
                onClose={() => setProposing(null)}
                onSent={(text) => {
                  setProposing(null);
                  refresh();
                  setMsg({ kind: 'ok', text });
                }}
              />
            )}
            <ul className="divide-y divide-slate-100">
              {s.candidates.map((v) => (
                <li key={v.googleEventId} className="flex flex-wrap items-center gap-2 py-1">
                  <span className="text-slate-700">{fmtSlot(v.startAt, v.endAt)}</span>
                  {v.location && <span className="text-xs text-slate-500">{v.location}</span>}
                  {v.eventId ? (
                    <button
                      className="btn btn-sm btn-primary ml-auto"
                      disabled={confirmHold.isPending}
                      onClick={() => {
                        const extra = s.rescheduleOf ? `\n元の予定（${fmtEventRange(s.rescheduleOf.startAt, s.rescheduleOf.endAt)}）も削除されます。` : '';
                        if (window.confirm(`${fmtSlot(v.startAt, v.endAt)} で確定しますか？\nほかの候補（${Math.max(s.candidates.length - 1, 0)} 件）の仮押さえは削除されます。${extra}`))
                          confirmHold.mutate({ sessionId: s.sessionId, eventId: v.eventId! });
                      }}
                    >
                      この候補で確定
                    </button>
                  ) : (
                    <span className="ml-auto text-xs text-slate-400">カレンダーにありません</span>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface Contact {
  id: number;
  role: string;
  name: string;
  kana: string | null;
  organization: string | null;
  emails: string[];
  lineUserId: string | null;
  chatworkAccountId: number | null;
  phone: string | null;
  note: string | null;
}
const EMPTY_CONTACT = { role: 'opponent_counsel', name: '', organization: '', emails: '', phone: '', note: '' };

/** 事件の関係者（相手方・相手方代理人・裁判所など）。登録したメールアドレス等からの連絡は自動でこの事件に紐付く */
/** 事件ページから、この事件のタスクを直接追加する */
function CaseTaskForm({ caseId, hasStaff, onDone }: { caseId: number; hasStaff: boolean; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<TaskStatus>('open');
  const [deadline, setDeadline] = useState<string | null>(null);
  const [sync, setSync] = useState(false);
  const [msg, setMsg] = useState('');
  // 書きかけのタスク名は、この事件ごとに自動保存する
  const draft = useDraft(`case:${caseId}:new-task`, title, setTitle);
  const waiting = status !== 'open';
  const add = useMutation({
    mutationFn: () => {
      // 1 行目がタスク名、2 行目からはメモ（タスク画面と同じ書き方）
      const lines = title.split('\n');
      const head = lines.findIndex((l) => l.trim());
      const note = lines.slice(head + 1).join('\n').trim();
      return api.post('/tasks', {
        title: lines[head]!.trim(),
        note: note || null,
        status,
        caseId,
        followUpAt: waiting ? deadline : null,
        dueAt: waiting ? null : deadline,
        syncToChatwork: sync,
      });
    },
    onSuccess: () => {
      setTitle('');
      setDeadline(null);
      draft.clear();
      setMsg('タスクを追加しました');
      onDone();
    },
    onError: (e) => setMsg((e as Error).message),
  });
  return (
    <form
      className="space-y-2 border-t border-[var(--hairline)] pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) add.mutate();
      }}
    >
      <div>
        <textarea
          className="input w-full resize-y"
          rows={2}
          placeholder={'この事件にタスクを追加（1 行目がタスク名、2 行目からはメモ）'}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setMsg('');
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && title.trim()) {
              e.preventDefault();
              add.mutate();
            }
          }}
        />
        <DraftHint handle={draft} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className="input w-auto py-0.5 text-xs" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)} aria-label="状態">
          {(['open', 'waiting_client', 'waiting_other'] as const).map((st) => (
            <option key={st} value={st}>
              {TASK_STATUS_LABEL[st]}
            </option>
          ))}
        </select>
        <TaskDeadlineSelect value={deadline} onChange={setDeadline} label={waiting ? '期限' : '期日'} defaultLabel={waiting ? '既定（設定の営業日数）' : 'なし'} />
        <label className="flex items-center gap-1 text-xs" title={hasStaff ? 'この事件の担当事務局に振ります' : '担当事務局が未設定のときは、自分のマイチャットに作ります'}>
          <input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> Chatwork にも作成
        </label>
        <button className="btn btn-sm btn-primary ml-auto" disabled={add.isPending || !title.trim()}>
          {add.isPending ? '追加中…' : '追加'}
        </button>
      </div>
      {msg && <div className="fade-in text-xs text-slate-600">{msg}</div>}
    </form>
  );
}

function ContactsSection({ caseId }: { caseId: number }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['contacts', String(caseId)], queryFn: () => api.get<Contact[]>(`/cases/${caseId}/contacts`) });
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [form, setForm] = useState(EMPTY_CONTACT);
  const [err, setErr] = useState('');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['contacts'] });
    qc.invalidateQueries({ queryKey: ['case', String(caseId)] });
  };
  const body = () => ({ role: form.role, name: form.name, organization: form.organization || null, emails: form.emails.split(/[\s,、;]+/).filter(Boolean), phone: form.phone || null, note: form.note || null });
  const save = useMutation({
    mutationFn: () => (editing === 'new' ? api.post(`/cases/${caseId}/contacts`, body()) : api.put(`/contacts/${editing}`, body())),
    onSuccess: () => {
      setEditing(null);
      setErr('');
      refresh();
    },
    onError: (e) => setErr((e as Error).message),
  });
  const remove = useMutation({ mutationFn: (id: number) => api.del(`/contacts/${id}`), onSuccess: refresh, onError: (e) => setErr((e as Error).message) });
  const startEdit = (x: Contact) => {
    setEditing(x.id);
    setForm({ role: x.role, name: x.name, organization: x.organization ?? '', emails: x.emails.join(', '), phone: x.phone ?? '', note: x.note ?? '' });
  };
  return (
    <section className="card text-sm">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="font-semibold">関係者（相手方・代理人など）</h2>
        <button
          className="btn btn-sm ml-auto"
          onClick={() => {
            setEditing('new');
            setForm(EMPTY_CONTACT);
          }}
        >
          追加
        </button>
      </div>
      <ul className="space-y-2">
        {q.data?.map((x) => (
          <li key={x.id} className="rounded border border-slate-100 p-2">
            {editing === x.id ? (
              <ContactForm form={form} setForm={setForm} onSave={() => save.mutate()} onCancel={() => setEditing(null)} busy={save.isPending} />
            ) : (
              <div className="flex flex-wrap items-start gap-2">
                <span className="badge badge-orange shrink-0">{CASE_CONTACT_ROLE_LABEL[x.role as keyof typeof CASE_CONTACT_ROLE_LABEL] ?? x.role}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {x.name}
                    {x.organization && <span className="ml-1 text-xs text-slate-500">{x.organization}</span>}
                  </div>
                  <div className="text-xs text-slate-500">
                    {x.emails.join(', ')}
                    {x.phone && <span className="ml-2">☎ {x.phone}</span>}
                    {x.lineUserId && <span className="ml-2 badge badge-line">LINE 連携済</span>}
                    {x.chatworkAccountId && <span className="ml-2 badge badge-chatwork">Chatwork 連携済</span>}
                  </div>
                  {x.note && <div className="text-xs text-slate-500">{x.note}</div>}
                </div>
                <button className="text-xs text-blue-700 hover:underline" onClick={() => startEdit(x)}>
                  編集
                </button>
                <button
                  className="text-xs text-slate-400 hover:text-red-600 hover:underline"
                  onClick={() => {
                    if (confirm(`${x.name} を関係者から削除しますか？（会話は残り、関係者の紐付けだけ外れます）`)) remove.mutate(x.id);
                  }}
                >
                  削除
                </button>
              </div>
            )}
          </li>
        ))}
        {editing === 'new' && (
          <li className="rounded border border-slate-100 p-2">
            <ContactForm form={form} setForm={setForm} onSave={() => save.mutate()} onCancel={() => setEditing(null)} busy={save.isPending} />
          </li>
        )}
        {q.data?.length === 0 && editing !== 'new' && <li className="text-slate-500">未登録です。相手方代理人などのメールアドレスを登録しておくと、その相手からの Gmail が自動でこの事件に紐付きます。受信箱の未紐付けの会話からも登録できます。</li>}
      </ul>
      {err && <div className="fade-in mt-1 text-xs text-red-600">{err}</div>}
    </section>
  );
}

function ContactForm({ form, setForm, onSave, onCancel, busy }: { form: typeof EMPTY_CONTACT; setForm: (f: typeof EMPTY_CONTACT) => void; onSave: () => void; onCancel: () => void; busy: boolean }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        <select className="input w-36" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          {CASE_CONTACT_ROLES.map((r) => (
            <option key={r} value={r}>
              {CASE_CONTACT_ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <input className="input flex-1" placeholder="名前" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <input className="input" placeholder="所属（法律事務所名・会社名など）" value={form.organization} onChange={(e) => setForm({ ...form, organization: e.target.value })} />
      <input className="input" placeholder="メールアドレス（複数はカンマ区切り）" value={form.emails} onChange={(e) => setForm({ ...form, emails: e.target.value })} />
      <input className="input" placeholder="電話番号" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      <input className="input" placeholder="メモ" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
      <div className="flex gap-2">
        <button className="btn btn-primary btn-sm" onClick={onSave} disabled={!form.name.trim() || busy}>
          保存
        </button>
        <button className="btn btn-sm" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

interface HearingNotice {
  noteId: number;
  clientName: string;
  channel: string;
  channelLabel: string;
  to: string;
  conversationId: number;
  draftId: number | null;
  text: string;
  hearingAt: string;
  nextHearingAt: string | null;
  nextHearingText: string;
  docs: { name: string; path: string; itemId?: string; modifiedAt?: string; size?: number }[];
  channels: { channel: string; to: string }[];
}
const CHANNEL_JA: Record<string, string> = { gmail: 'Gmail', line: 'LINE公式', chatwork: 'Chatwork' };

/**
 * 期日の記録から依頼者への期日連絡を送る。
 * 記録の要旨・決定事項・次回期日・提出書面をもとに本人の文体で下書きし、確認して送信する
 */
function HearingNoticePanel({ noteId, onClose, onSent }: { noteId: number; onClose: () => void; onSent: () => void }) {
  const [channel, setChannel] = useState<string | undefined>(undefined);
  const [text, setText] = useState('');
  const [docs, setDocs] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState('');
  const prep = useQuery({
    queryKey: ['hearing-notice', noteId, channel ?? ''],
    queryFn: () => api.post<HearingNotice>(`/case-notes/${noteId}/hearing-notice`, channel ? { channel } : {}),
    staleTime: Infinity,
    retry: false,
  });
  useEffect(() => {
    if (prep.data) {
      setText(prep.data.text);
      setDocs(new Set());
    }
  }, [prep.data]);
  const n = prep.data;
  // 下書きを直した内容を自動保存する（AI の下書きが変わったら戻さない）
  const noticeDraft = useDraft(n ? `note:${noteId}:hearing-notice` : null, text, setText, n?.text ?? '');
  const send = useMutation({
    mutationFn: () =>
      api.post<{ note?: string; links: { name: string }[]; manualFiles: string[] }>(`/conversations/${n!.conversationId}/send`, {
        text,
        attachmentIds: [],
        driveFiles: n!.docs.filter((d) => docs.has(d.path)).map((d) => ({ itemId: d.itemId, name: d.name, path: d.path })),
        draftId: n!.draftId,
        createWaitingTask: false,
      }),
    onSuccess: (r) => {
      noticeDraft.clear();
      setMsg(`${n!.channelLabel} で送信しました${r.note ? `（${r.note}）` : ''}${r.links.length ? `。${r.links.length} 件はリンクで送付` : ''}${r.manualFiles.length ? `。${r.manualFiles.join('、')} は手動送付が必要です` : ''}`);
      setTimeout(onSent, 1500);
    },
    onError: (e) => setMsg((e as Error).message),
  });
  return (
    <section className="card space-y-2 border-blue-200 bg-blue-50/40">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">依頼者に期日連絡</h2>
        {n && (
          <>
            <span className="text-sm text-slate-600">{n.clientName} 宛</span>
            <select
              className="input w-auto"
              value={n.channel}
              onChange={(e) => setChannel(e.target.value)}
              disabled={prep.isFetching}
              title="送るチャネル（依頼者の希望チャネルが既定）"
            >
              {n.channels.map((c) => (
                <option key={c.channel} value={c.channel}>
                  {CHANNEL_JA[c.channel] ?? c.channel}
                  {c.channel === 'gmail' ? `（${c.to}）` : ''}
                </option>
              ))}
            </select>
            <span className="text-xs text-slate-500">
              期日 {fmtDateTime(n.hearingAt)} ／ 次回 {n.nextHearingText}
            </span>
          </>
        )}
        <button className="btn btn-sm ml-auto" onClick={onClose}>
          閉じる
        </button>
      </div>
      {prep.isLoading && <div className="text-sm text-slate-500">記録と次回期日をもとに下書きを作成中…</div>}
      {prep.error && <div className="text-sm text-red-600">{(prep.error as Error).message}</div>}
      {n && (
        <>
          <textarea className="input min-h-44 text-sm" value={text} onChange={(e) => setText(e.target.value)} disabled={prep.isFetching} />
          <DraftHint handle={noticeDraft} />
          {n.docs.length > 0 && (
            <div className="text-sm">
              <div className="mb-1 text-xs text-slate-500">
                添付する提出書面（直近 2 週間に更新したファイル）
                {n.channel === 'line' && '。LINE にはファイルを直接送れないため、共有リンクまたは手動送付になります'}
              </div>
              <div className="flex flex-wrap gap-2">
                {n.docs.map((d) => (
                  <label key={d.path} className="flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs">
                    <input
                      type="checkbox"
                      checked={docs.has(d.path)}
                      onChange={(e) => {
                        const next = new Set(docs);
                        if (e.target.checked) next.add(d.path);
                        else next.delete(d.path);
                        setDocs(next);
                      }}
                    />
                    {d.name}
                    {d.modifiedAt && <span className="text-slate-400">{fmtDate(d.modifiedAt)}</span>}
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" onClick={() => send.mutate()} disabled={send.isPending || prep.isFetching || !text.trim()}>
              {send.isPending ? '送信中…' : `${n.channelLabel} で送信`}
            </button>
            <Link to={`/inbox/${n.conversationId}`} className="btn btn-sm">
              会話を開いて送る
            </Link>
            {!n.nextHearingAt && <span className="text-xs text-orange-600">次回期日がカレンダーにありません。決まっていれば先に「予定」で登録すると本文に入ります</span>}
            {msg && <span className="fade-in text-xs text-slate-700">{msg}</span>}
          </div>
        </>
      )}
    </section>
  );
}

function NoteComposer({ caseId, onSaved }: { caseId: number; onSaved: (note?: { id: number; kind: string }) => void }) {
  const [kind, setKind] = useState<CaseNoteKind>('phone');
  const [counterpart, setCounterpart] = useState('');
  const [phone, setPhone] = useState('');
  const [occurredAt, setOccurredAt] = useState(toLocalInput(new Date().toISOString()));
  const [raw, setRaw] = useState('');
  const [theirSaid, setTheirSaid] = useState('');
  const [ourSaid, setOurSaid] = useState('');
  const [preview, setPreview] = useState<{ gist: string; theirSaid: string[]; ourSaid: string[]; phone: string | null; decisions: string[]; nextActions: { title: string; due: string | null }[]; waitingFor: WaitingFor; counterpart: string | null } | null>(null);
  const lines = (t: string) => t.split(/\n/).map((x) => x.replace(/^[・\-\s]+/, '').trim()).filter(Boolean);
  // タスク化の方法: アクションごと／1 つにまとめる／作らない。タスク化するアクションはチェックで選ぶ
  const [taskMode, setTaskMode] = useState<'each' | 'single' | 'none'>('single');
  const [taskPick, setTaskPick] = useState<Set<number>>(new Set());
  const [err, setErr] = useState('');
  // 書きかけのメモはこの端末に自動保存する（保存前に画面を離れても消えない）
  const noteDraft = useDraftGroup(`case:${caseId}:note:new`, {
    counterpart: { value: counterpart, set: setCounterpart },
    phone: { value: phone, set: setPhone },
    raw: { value: raw, set: setRaw },
    theirSaid: { value: theirSaid, set: setTheirSaid },
    ourSaid: { value: ourSaid, set: setOurSaid },
  });
  const structure = useMutation({
    mutationFn: () => api.post<NonNullable<typeof preview>>(`/cases/${caseId}/notes/structure`, { rawText: raw, kind, counterpart: counterpart || null, phone: phone || null }),
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
    mutationFn: () =>
      api.post<{ id: number; kind: string }>(`/cases/${caseId}/notes`, {
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
      }),
    onSuccess: (r) => {
      setRaw('');
      setTheirSaid('');
      setOurSaid('');
      setPhone('');
      noteDraft.clear();
      setPreview(null);
      setErr('');
      onSaved(r);
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
        {kind === 'phone' && <input type="tel" className="input w-40" placeholder="電話番号" value={phone} onChange={(e) => setPhone(e.target.value)} />}
        <input type="datetime-local" className="input w-auto" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
      </div>
      <textarea className="input min-h-28" placeholder="走り書きで OK。例: 相手方代理人から電話。和解案として300万を提示。依頼者に持ち帰り、来週金曜までに回答。証拠の追加提出は不要とのこと。" value={raw} onChange={(e) => setRaw(e.target.value)} />
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
        <select className="input w-auto text-sm" value={taskMode} onChange={(e) => setTaskMode(e.target.value as typeof taskMode)} title="AI が挙げた次のアクションをどうタスクにするか">
          <option value="single">次のアクションを 1 つのタスクにまとめる</option>
          <option value="each">次のアクションごとにタスクを作る</option>
          <option value="none">タスクにしない</option>
        </select>
        <button className="btn btn-primary ml-auto" onClick={() => save.mutate()} disabled={!raw.trim() || save.isPending}>
          保存
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
              <ul className="ml-1 mt-1 space-y-0.5">
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
                    <span>
                      {a.title}
                      {a.due ? <span className="text-slate-500">（期限 {a.due}）</span> : ''}
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

/** 記録の編集フォーム（1 行 1 項目の欄は「・」や「-」の先頭記号を除いて保存） */
function NoteEditor({ n, onSaved, onCancel }: { n: Note; onSaved: () => void; onCancel: () => void }) {
  const joinLines = (xs: string[]) => xs.map((x) => `・${x}`).join('\n');
  const lines = (t: string) => t.split(/\n/).map((x) => x.replace(/^[・\-\s]+/, '').trim()).filter(Boolean);
  const [kind, setKind] = useState(n.kind);
  const [occurredAt, setOccurredAt] = useState(toLocalInput(n.occurredAt));
  const [counterpart, setCounterpart] = useState(n.counterpart ?? '');
  const [phone, setPhone] = useState(n.phone ?? '');
  const [gist, setGist] = useState(n.gist ?? '');
  const [rawText, setRawText] = useState(n.rawText ?? '');
  const [theirSaid, setTheirSaid] = useState(joinLines(n.theirSaid));
  const [ourSaid, setOurSaid] = useState(joinLines(n.ourSaid));
  const [decisions, setDecisions] = useState(joinLines(n.decisions));
  // 次のアクションは「内容 | 期限(YYYY-MM-DD)」で 1 行 1 件
  const dateOf = (v: string | null | undefined) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  const [nextActions, setNextActions] = useState(n.nextActions.map((a) => `・${a.title}${dateOf(a.due) ? ` | ${dateOf(a.due)}` : ''}`).join('\n'));
  const WAITING = ['none', 'client', 'counterpart', 'court', 'creditor', 'other'] as const;
  // 古い記録に想定外の値が入っていても保存できるよう、選べる値に丸める
  const [waitingFor, setWaitingFor] = useState<string>(n.waitingFor && (WAITING as readonly string[]).includes(n.waitingFor) ? n.waitingFor : 'none');
  const [err, setErr] = useState('');
  // 編集途中の内容を自動保存する。元の記録が変わっていたら戻さない
  const editDraft = useDraftGroup(`note:${n.id}:edit`, {
    counterpart: { value: counterpart, set: setCounterpart, base: n.counterpart ?? '' },
    phone: { value: phone, set: setPhone, base: n.phone ?? '' },
    gist: { value: gist, set: setGist, base: n.gist ?? '' },
    rawText: { value: rawText, set: setRawText, base: n.rawText ?? '' },
    theirSaid: { value: theirSaid, set: setTheirSaid, base: joinLines(n.theirSaid) },
    ourSaid: { value: ourSaid, set: setOurSaid, base: joinLines(n.ourSaid) },
    decisions: { value: decisions, set: setDecisions, base: joinLines(n.decisions) },
  });
  const save = useMutation({
    mutationFn: () =>
      api.put(`/case-notes/${n.id}`, {
        kind,
        occurredAt: fromLocalInput(occurredAt),
        counterpart: counterpart || null,
        phone: phone || null,
        gist: gist || null,
        rawText,
        theirSaid: lines(theirSaid),
        ourSaid: lines(ourSaid),
        decisions: lines(decisions),
        nextActions: lines(nextActions).map((l) => {
          const [title, due] = l.split('|').map((x) => x.trim());
          const prev = n.nextActions.find((a) => a.title === title);
          return { title, due: dateOf(due), taskId: prev?.taskId ?? null };
        }),
        waitingFor: waitingFor === 'none' ? null : waitingFor,
      }),
    onSuccess: () => {
      editDraft.clear();
      onSaved();
    },
    onError: (e) => setErr((e as Error).message),
  });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value)}>
          {CASE_NOTE_KINDS.filter((k) => k !== 'policy').map((k) => (
            <option key={k} value={k}>
              {CASE_NOTE_KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <input type="datetime-local" className="input w-auto" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
        <input className="input w-40" placeholder="相手" value={counterpart} onChange={(e) => setCounterpart(e.target.value)} />
        {kind === 'phone' && <input type="tel" className="input w-36" placeholder="電話番号" value={phone} onChange={(e) => setPhone(e.target.value)} />}
        <select className="input w-auto" value={waitingFor} onChange={(e) => setWaitingFor(e.target.value)} title="誰の対応待ちか">
          {WAITING.map((w) => (
            <option key={w} value={w}>
              {w === 'none' ? '待ちなし' : `${WAITING_FOR_LABEL[w]}待ち`}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label">要旨</label>
        <textarea className="input min-h-16 text-sm" value={gist} onChange={(e) => setGist(e.target.value)} placeholder="空なら元メモがそのまま表示されます" />
        <DraftHint handle={editDraft} />
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <label className="label">相手が言ったこと（1 行 1 項目）</label>
          <textarea className="input min-h-16 text-sm" value={theirSaid} onChange={(e) => setTheirSaid(e.target.value)} />
        </div>
        <div>
          <label className="label">こちらが言ったこと（1 行 1 項目）</label>
          <textarea className="input min-h-16 text-sm" value={ourSaid} onChange={(e) => setOurSaid(e.target.value)} />
        </div>
        <div>
          <label className="label">決定事項（1 行 1 項目）</label>
          <textarea className="input min-h-14 text-sm" value={decisions} onChange={(e) => setDecisions(e.target.value)} />
        </div>
        <div>
          <label className="label">次のアクション（1 行 1 件。期限は「| 2027-01-20」のように末尾に）</label>
          <textarea className="input min-h-14 text-sm" value={nextActions} onChange={(e) => setNextActions(e.target.value)} />
        </div>
      </div>
      <div>
        <label className="label">元メモ</label>
        <textarea className="input min-h-16 text-sm" value={rawText} onChange={(e) => setRawText(e.target.value)} />
      </div>
      {err && <div className="fade-in text-xs text-red-600">{err}</div>}
      <div className="flex gap-2">
        <button className="btn btn-primary btn-sm" onClick={() => save.mutate()} disabled={save.isPending}>
          保存
        </button>
        <button className="btn btn-sm" onClick={onCancel}>
          取消
        </button>
        <span className="text-xs text-slate-400">タスク化済みの次のアクションは、内容を変えなければタスクとの結び付きを保ちます</span>
      </div>
    </div>
  );
}

/** AI が出したタスクの案（画面で直してから登録する） */
interface DraftTask {
  title: string;
  due: string;
  status: string;
  note: string;
  use: boolean;
}

/** 記録をタスクにする。AI の案を直して登録するほか、次のアクションや題名からも作れる */
interface NoteScheduleProposal {
  caseId: number;
  caseTitle: string | null;
  clientId: number | null;
  clientName: string | null;
  found: boolean;
  content: string;
  kind: EventKind;
  web: boolean | null;
  durationMinutes: number;
  summary: string;
  quote: string;
  note: string;
  window: { from: string; to: string };
  slots: { startAt: string; endAt: string; score?: number }[];
  blocked: string | null;
}

/**
 * 記録から日程調整。
 * 記録の内容から「次に決める予定」と希望条件を読み取り、カレンダーの空きに当てて候補を出し、
 * 直してから仮押さえとして登録する。
 */
function NoteSchedulePanel({ n, onDone, onClose }: { n: Note; onDone: () => void; onClose: () => void }) {
  const [p, setP] = useState<NoteScheduleProposal | null>(null);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<EventKind>('meeting');
  const [duration, setDuration] = useState('60');
  // 終了は「開始 + 所要」で決めるので、候補は開始だけ持つ（所要を変えるとすべての候補に効く）
  const [slots, setSlots] = useState<{ start: string; use: boolean }[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const mins = () => Math.max(15, Number(duration) || 60);

  const read = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<NoteScheduleProposal>(`/case-notes/${n.id}/schedule`, body),
    onSuccess: (r) => {
      setP(r);
      setTitle(r.content);
      setKind(r.kind);
      setDuration(String(r.durationMinutes));
      setSlots(r.slots.map((s) => ({ start: toLocalInput(s.startAt), use: true })));
      setMsg(
        r.blocked
          ? { kind: 'info', text: r.blocked }
          : !r.found
            ? { kind: 'info', text: 'この記録からは、これから決める予定を読み取れませんでした。候補を手で入れて仮押さえできます' }
            : null,
      );
    },
    onError: (e) => setMsg({ kind: 'err', text: (e as Error).message }),
  });
  // 開いたらまず読み取る（そのあと直して仮押さえする）
  useEffect(() => {
    read.mutate({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hold = useMutation({
    mutationFn: () =>
      api.post<{ events: { id: number }[] }>('/calendar/holds', {
        title: title.trim() || '打合せ',
        kind,
        clientId: p?.clientId ?? null,
        caseId: p?.caseId ?? null,
        description: `記録から日程調整${p?.note ? `: ${p.note}` : ''}`,
        slots: slots.filter((s) => s.use).map((s) => ({ startAt: fromLocalInput(s.start), endAt: endOf(s.start) })),
      }),
    onSuccess: (r) => {
      setMsg({ kind: 'ok', text: `仮押さえを ${r.events.length} 件登録しました。相手の返事が来たら「この候補で確定」を押してください` });
      onDone();
    },
    onError: (e) => setMsg({ kind: 'err', text: (e as Error).message }),
  });

  const setSlot = (i: number, patch: Partial<{ start: string; use: boolean }>) => setSlots((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  /** 開始から、所要の分だけ後ろの終了時刻 */
  const endOf = (start: string) => new Date(new Date(fromLocalInput(start)).getTime() + mins() * 60_000).toISOString();
  const picked = slots.filter((s) => s.use).length;

  return (
    <div className="fade-in mt-2 space-y-2 rounded border border-blue-200 bg-blue-50/30 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">記録から日程調整</span>
        {read.isPending && <span className="loading-text text-xs text-slate-500">記録を読んで空きを探しています…</span>}
        <button className="ml-auto text-xs text-slate-500 hover:underline" onClick={onClose}>
          閉じる
        </button>
      </div>

      {p && (p.quote || p.summary || p.note) && (
        <div className="rounded bg-white/70 p-2 text-xs text-slate-600">
          {p.quote && <div className="mb-0.5">記録から: 「{p.quote}」</div>}
          {p.summary && <div>読み取った条件: {p.summary}</div>}
          {p.note && <div className="text-slate-500">{p.note}</div>}
        </div>
      )}

      {p && (
        <>
          <label className="block">
            <span className="label">件名</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="打合せ" />
            <span className="mt-0.5 block text-xs text-slate-500">
              「{p.clientName ? `${p.clientName.split(/[\s　]/)[0]} ` : ''}
              {title.trim() || '◯◯'} 仮」として登録されます
            </span>
          </label>
          <div className="flex flex-wrap items-end gap-2">
            <label>
              <span className="label">種別</span>
              <select className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value as EventKind)}>
                {EVENT_KINDS.filter((k) => k !== 'hold').map((k) => (
                  <option key={k} value={k}>
                    {EVENT_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="label">所要（分・終了はこの長さ）</span>
              <input className="input w-20" type="number" min={15} step={15} value={duration} onChange={(e) => setDuration(e.target.value)} />
            </label>
            <button className="btn btn-sm" onClick={() => read.mutate({ durationMinutes: mins() })} disabled={read.isPending}>
              この長さで探し直す
            </button>
          </div>

          <div>
            <div className="label">候補日時（使うものだけチェック）</div>
            <ul className="space-y-1">
              {slots.map((s, i) => (
                <li key={i} className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={s.use} onChange={(e) => setSlot(i, { use: e.target.checked })} />
                  <input className="input min-w-0 flex-1 py-0.5" type="datetime-local" value={s.start} onChange={(e) => setSlot(i, { start: e.target.value })} />
                  <span className="whitespace-nowrap tabular-nums text-slate-500">
                    〜{new Date(endOf(s.start)).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <button className="text-slate-400 hover:text-red-600" onClick={() => setSlots(slots.filter((_, j) => j !== i))} aria-label="この候補を外す">
                    ✕
                  </button>
                </li>
              ))}
              {slots.length === 0 && <li className="text-xs text-slate-500">候補がありません。「＋ 候補を追加」から手で入れられます</li>}
            </ul>
            <button
              className="mt-1 text-xs text-blue-700 hover:underline"
              onClick={() => {
                const base = slots.at(-1)?.start ?? toLocalInput(new Date(Date.now() + 86400_000).toISOString());
                const start = toLocalInput(new Date(new Date(fromLocalInput(base)).getTime() + 86400_000).toISOString());
                setSlots([...slots, { start, use: true }].slice(0, 10));
              }}
              disabled={slots.length >= 10}
            >
              ＋ 候補を追加
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary btn-sm" onClick={() => hold.mutate()} disabled={picked === 0 || hold.isPending}>
              {hold.isPending ? '登録中…' : `${picked} 件を仮押さえ`}
            </button>
            <span className="text-xs text-slate-500">仮押さえは Google カレンダーに「仮」として入ります。相手の返事で 1 つ確定すると、ほかは自動で消えます</span>
          </div>
        </>
      )}

      {msg && <div className={`text-xs ${msg.kind === 'ok' ? 'text-green-700' : msg.kind === 'err' ? 'text-red-600' : 'text-slate-500'}`}>{msg.text}</div>}
    </div>
  );
}

function NoteTaskPanel({ n, onDone, onClose }: { n: Note; onDone: () => void; onClose: () => void }) {
  const qc = useQueryClient();
  const pending = n.nextActions.map((a, i) => ({ ...a, i })).filter((a) => !a.taskId);
  const headline = (n.gist ?? n.rawText ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const [pick, setPick] = useState<Set<number>>(new Set(pending.map((a) => a.i)));
  const [mode, setMode] = useState<'each' | 'single'>('single');
  const [title, setTitle] = useState(pending.length ? '' : headline.slice(0, 80));
  const [due, setDue] = useState(pending.find((a) => a.due)?.due?.slice(0, 10) ?? '');
  const [status, setStatus] = useState<string>(n.waitingFor === 'client' ? 'waiting_client' : n.waitingFor && n.waitingFor !== 'none' ? 'waiting_other' : 'open');
  const [sync, setSync] = useState(false);
  const [msg, setMsg] = useState('');
  // AI の案。null なら「まだ作っていない」
  const [drafts, setDrafts] = useState<DraftTask[] | null>(null);
  const [comment, setComment] = useState('');
  const suggest = useMutation({
    mutationFn: () => api.post<{ tasks: { title: string; due: string | null; status: string; note: string }[]; comment: string }>(`/case-notes/${n.id}/task-suggestions`),
    onSuccess: (r) => {
      setDrafts(r.tasks.map((t) => ({ title: t.title, due: t.due ?? '', status: t.status, note: t.note ?? '', use: true })));
      setComment(r.comment ?? '');
      setMsg(r.tasks.length ? '' : 'タスクにするものは見当たりませんでした。必要なら題名を書いて作れます');
    },
    onError: (e) => setMsg((e as Error).message),
  });
  const setDraft = (i: number, patch: Partial<DraftTask>) => setDrafts((prev) => (prev ?? []).map((d, j) => (j === i ? { ...d, ...patch } : d)));
  // 開いたらまず案を出す（そのあと直して登録する）
  useEffect(() => {
    suggest.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ tasks: { id: number; title: string }[] }>(`/case-notes/${n.id}/tasks`, { due: due || null, status, syncToChatwork: sync, ...body }),
    onSuccess: (r) => {
      setMsg(`${r.tasks.map((t) => t.title).join('、')} をタスクにしました`);
      setTitle('');
      setDrafts(null);
      qc.invalidateQueries({ queryKey: ['tasks'] });
      onDone();
      setTimeout(onClose, 1200);
    },
    onError: (e) => setMsg((e as Error).message),
  });
  return (
    <div className="mt-2 space-y-2 rounded border border-blue-200 bg-blue-50/40 p-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-semibold">この記録をタスクにする</span>
        <button className="btn btn-sm ml-auto" onClick={onClose}>
          閉じる
        </button>
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-sm" onClick={() => suggest.mutate()} disabled={suggest.isPending}>
            {suggest.isPending ? '整理中…' : drafts ? 'AI で作り直す' : 'AI で案を作る'}
          </button>
          <span className="text-xs text-slate-500">
            {suggest.isPending ? '記録の内容からタスクの案を作っています…' : '記録の内容から作った案です。題名・期限・状態を直してから登録できます'}
          </span>
        </div>
        {drafts && drafts.length > 0 && (
          <div className="space-y-2 rounded border border-slate-200 bg-white p-2">
            {drafts.map((dft, i) => (
              <div key={i} className={`space-y-1 rounded border p-2 ${dft.use ? 'border-blue-200' : 'border-slate-100 opacity-60'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <input type="checkbox" checked={dft.use} onChange={(e) => setDraft(i, { use: e.target.checked })} aria-label="このタスクを登録する" />
                  <input className="input min-w-0 flex-1" value={dft.title} onChange={(e) => setDraft(i, { title: e.target.value })} placeholder="タスク名" />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <label className="flex items-center gap-1">
                    期限 <input type="date" className="input w-auto py-0.5" value={dft.due} onChange={(e) => setDraft(i, { due: e.target.value })} />
                  </label>
                  <select className="input w-auto py-0.5" value={dft.status} onChange={(e) => setDraft(i, { status: e.target.value })} aria-label="状態">
                    {(['open', 'waiting_client', 'waiting_other'] as const).map((st) => (
                      <option key={st} value={st}>
                        {TASK_STATUS_LABEL[st]}
                      </option>
                    ))}
                  </select>
                  <button className="text-slate-400 hover:text-red-600" onClick={() => setDrafts((prev) => (prev ?? []).filter((_, j) => j !== i))}>
                    この案を消す
                  </button>
                </div>
                <input className="input text-xs" value={dft.note} onChange={(e) => setDraft(i, { note: e.target.value })} placeholder="メモ（背景・決まったこと）" />
              </div>
            ))}
            {comment && <div className="text-xs text-slate-500">{comment}</div>}
            <button
              className="btn btn-primary btn-sm"
              disabled={create.isPending || drafts.every((dft) => !dft.use || !dft.title.trim())}
              onClick={() =>
                create.mutate({
                  mode: 'list',
                  tasks: drafts.filter((dft) => dft.use && dft.title.trim()).map((dft) => ({ title: dft.title, due: dft.due || null, status: dft.status, note: dft.note || null })),
                })
              }
            >
              この内容でタスクにする
            </button>
          </div>
        )}
      </div>
      {pending.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs text-slate-500">次のアクションから選ぶ</div>
          <ul className="space-y-0.5">
            {pending.map((a) => (
              <li key={a.i} className="flex items-start gap-1.5">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={pick.has(a.i)}
                  onChange={(e) =>
                    setPick((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(a.i);
                      else next.delete(a.i);
                      return next;
                    })
                  }
                  aria-label={`${a.title} をタスクにする`}
                />
                <span>
                  {a.title}
                  {a.due ? <span className="text-slate-500">（期限 {fmtDue(a.due)}）</span> : ''}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <select className="input w-auto text-sm" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="single">選んだ分を 1 つのタスクにまとめる</option>
              <option value="each">選んだアクションごとにタスクを作る</option>
            </select>
            <button className="btn btn-primary btn-sm" disabled={pick.size === 0 || create.isPending} onClick={() => create.mutate({ mode, indexes: [...pick] })}>
              選んだ分をタスクにする
            </button>
          </div>
        </div>
      )}
      <div className="space-y-1">
        <div className="text-xs text-slate-500">{pending.length > 0 ? 'または、題名を書いてタスクにする' : '題名を書いてタスクにする'}</div>
        <div className="flex flex-wrap items-center gap-2">
          <input className="input min-w-0 flex-1" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={headline.slice(0, 40) || 'タスク名'} />
          <button className="btn btn-primary btn-sm" disabled={create.isPending} onClick={() => create.mutate({ mode: 'custom', title: title.trim() || headline })}>
            この題名でタスクにする
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          期限 <input type="date" className="input w-auto py-0.5" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <label className="flex items-center gap-1">
          状態
          <select className="input w-auto py-0.5" value={status} onChange={(e) => setStatus(e.target.value)}>
            {(['open', 'waiting_client', 'waiting_other'] as const).map((st) => (
              <option key={st} value={st}>
                {TASK_STATUS_LABEL[st]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> 担当事務局の Chatwork タスクにも登録
        </label>
      </div>
      {msg && <div className="fade-in text-xs text-slate-700">{msg}</div>}
      <div className="text-xs text-slate-400">作ったタスクは、この事件・依頼者に紐付きます。記録には「タスク化済」として残ります。</div>
    </div>
  );
}

function NoteView({ n, onDeleted, onNotice }: { n: Note; onDeleted: () => void; onNotice?: () => void }) {
  const del = useMutation({ mutationFn: () => api.del(`/case-notes/${n.id}`), onSuccess: onDeleted });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  if (editing) {
    return (
      <li id={`note-${n.id}`} className="scroll-mt-20 rounded border border-blue-200 bg-blue-50/30 p-3 text-sm">
        <NoteEditor
          n={n}
          onSaved={() => {
            setEditing(false);
            onDeleted();
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  }
  return (
    <li id={`note-${n.id}`} className="scroll-mt-20 rounded border border-slate-100 p-3 text-sm target:border-blue-300 target:bg-blue-50/40">
      {/* 見出しは「いつ・誰と」の行と、操作の行に分ける（操作が増えても相手の名前が潰れないように） */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="badge badge-gray">{CASE_NOTE_KIND_LABEL[n.kind as CaseNoteKind] ?? n.kind}</span>
        <span className="whitespace-nowrap text-slate-500">{fmtDateTime(n.occurredAt)}</span>
        {n.counterpart && <span className="text-slate-600">{n.counterpart}</span>}
        {n.waitingFor && n.waitingFor !== 'none' && <span className="badge badge-orange">{WAITING_FOR_LABEL[n.waitingFor as WaitingFor]}待ち</span>}
        {n.createdBy === 'ai' && <span className="whitespace-nowrap text-xs text-slate-400">AI 整理</span>}
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
        {onNotice && (
          <button className="mr-auto btn btn-sm btn-primary whitespace-nowrap" onClick={onNotice} title="この期日の結果と次回期日を、本人の文体で依頼者に連絡します">
            依頼者に期日連絡
          </button>
        )}
        <button
          className="whitespace-nowrap text-xs text-blue-700 hover:underline"
          onClick={() => setTaskOpen(!taskOpen)}
          title="この記録をタスクにします（次のアクションからでも、題名を書いてでも作れます）"
        >
          タスクにする
        </button>
        <button
          className="whitespace-nowrap text-xs text-blue-700 hover:underline"
          onClick={() => setAskOpen(!askOpen)}
          title="この記録を引用して、Chatwork で担当事務局に確認します"
        >
          事務局に確認
        </button>
        <button
          className="whitespace-nowrap text-xs text-blue-700 hover:underline"
          onClick={() => setScheduleOpen(!scheduleOpen)}
          title="この記録から、次に決める予定と候補日時を読み取って仮押さえします"
        >
          日程調整
        </button>
        <button className="whitespace-nowrap text-xs text-blue-700 hover:underline" onClick={() => setEditing(true)}>
          編集
        </button>
        <button className="whitespace-nowrap text-xs text-slate-400 hover:text-red-600" onClick={() => confirm('削除しますか？') && del.mutate()}>
          削除
        </button>
      </div>
      {n.phone && (
        <div className="text-xs text-slate-500">
          ☎ <a href={`tel:${n.phone.replace(/[^\d+]/g, '')}`} className="hover:underline">{n.phone}</a>
        </div>
      )}
      <div className="mt-1 whitespace-pre-wrap">{n.gist ?? n.rawText}</div>
      {(n.theirSaid.length > 0 || n.ourSaid.length > 0) && (
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          <div className="rounded bg-slate-50 p-2">
            <div className="mb-1 text-xs font-semibold text-slate-500">{n.counterpart ? `${n.counterpart}の発言` : '相手の発言'}</div>
            {n.theirSaid.length === 0 && <div className="text-xs text-slate-400">（記録なし）</div>}
            <ul className="ml-4 list-disc text-slate-700">
              {n.theirSaid.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </div>
          <div className="rounded bg-blue-50 p-2">
            <div className="mb-1 text-xs font-semibold text-slate-500">こちらの発言</div>
            {n.ourSaid.length === 0 && <div className="text-xs text-slate-400">（記録なし）</div>}
            <ul className="ml-4 list-disc text-slate-700">
              {n.ourSaid.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {n.decisions.length > 0 && <div className="mt-1 text-slate-700">決定: {n.decisions.join(' / ')}</div>}
      {n.nextActions.length > 0 && (
        <ul className="mt-1 ml-4 list-disc text-slate-700">
          {n.nextActions.map((a, i) => (
            <li key={i}>
              {a.title}
              {a.due ? `（${fmtDue(a.due)}）` : ''}
              {a.taskId ? <span className="badge badge-blue ml-1">タスク化済</span> : null}
            </li>
          ))}
        </ul>
      )}
      {taskOpen && <NoteTaskPanel n={n} onDone={onDeleted} onClose={() => setTaskOpen(false)} />}
      {scheduleOpen && <NoteSchedulePanel n={n} onDone={onDeleted} onClose={() => setScheduleOpen(false)} />}
      {askOpen && (
        <div className="mt-2">
          <StaffAskPanel base={`/case-notes/${n.id}`} draftKey={`note:${n.id}`} onClose={() => setAskOpen(false)} onSent={onDeleted} />
        </div>
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

/**
 * タイムラインの本文。長いものは途中で省略し「続きを表示」で全文を出す。
 * メッセージは一覧では 2000 字までしか来ないので、そのときだけ全文を読みに行く。
 */
function TimelineBody({ body, messageId, truncated }: { body: string; messageId: number | null; truncated: boolean }) {
  const [full, setFull] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadFull = () => {
    if (!truncated || !messageId || full || loading) return;
    setLoading(true);
    api
      .get<{ body: string }>(`/messages/${messageId}/body`)
      .then((r) => setFull(r.body))
      .catch(() => setFull(null))
      .finally(() => setLoading(false));
  };
  const text = full ?? body;
  return (
    <LongText
      text={text}
      className="text-slate-600"
      onExpand={loadFull}
      footer={truncated && !full ? <div className="text-xs text-slate-400">{loading ? '全文を読み込み中…' : 'この先はまだ読み込んでいません'}</div> : null}
    />
  );
}

/**
 * 進捗の型。押すと「誰に対する何か」と「誰の回答待ちか」が決まる。
 * counterpart はタイムラインの見出しに出る（例: 進捗 / 依頼者に確認）
 */
const PROGRESS_PRESETS: { key: string; counterpart: string; waitingFor: WaitingFor; placeholder: string }[] = [
  { key: 'client', counterpart: '依頼者に確認', waitingFor: 'client', placeholder: '例: 和解案の内容を説明し、受けるかどうか確認を依頼' },
  { key: 'staff', counterpart: '担当事務局に確認', waitingFor: 'other', placeholder: '例: 登記簿の取寄せを依頼' },
  { key: 'counterpart', counterpart: '相手方に照会', waitingFor: 'counterpart', placeholder: '例: 提示額の根拠を書面で照会' },
  { key: 'court', counterpart: '裁判所に連絡', waitingFor: 'court', placeholder: '例: 次回期日の候補を打診' },
  { key: 'filed', counterpart: '書面提出', waitingFor: 'none', placeholder: '例: 準備書面（2）と証拠説明書を提出' },
  { key: 'received', counterpart: '資料受領', waitingFor: 'none', placeholder: '例: 診断書と施術証明書を受領' },
  { key: 'other', counterpart: '', waitingFor: 'none', placeholder: '例: 事件の進み具合を書く' },
];

/** 日本時間の YYYY-MM-DD（期限は日付単位で渡す） */
function jstDate(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** タイムラインに進捗を書き足す（依頼者に確認・事務局に確認・回答待ちなど） */
function ProgressForm({ caseId, onDone }: { caseId: number; onDone: () => void }) {
  const [preset, setPreset] = useState(PROGRESS_PRESETS[0]!);
  const [counterpart, setCounterpart] = useState('');
  const [text, setText] = useState('');
  const [waitingFor, setWaitingFor] = useState<WaitingFor>(PROGRESS_PRESETS[0]!.waitingFor);
  const [deadline, setDeadline] = useState<string | null>(null);
  const [makeTask, setMakeTask] = useState(true);
  const [toStage, setToStage] = useState(false);
  const [occurredAt, setOccurredAt] = useState('');
  const [msg, setMsg] = useState('');
  // 書きかけの内容はこの事件ごとに自動保存する
  const draft = useDraft(`case:${caseId}:progress`, text, setText);
  const waiting = waitingFor !== 'none';
  const who = (preset.key === 'other' ? counterpart.trim() : preset.counterpart) || null;
  const save = useMutation({
    mutationFn: async () => {
      const head = text.split('\n').find((l) => l.trim())?.trim() ?? '';
      const body: Record<string, unknown> = {
        kind: 'progress',
        counterpart: who,
        rawText: text,
        gist: head,
        waitingFor,
        occurredAt: occurredAt ? fromLocalInput(occurredAt) : undefined,
      };
      if (waiting && makeTask) {
        body.nextActions = [{ title: `${who ?? '回答'}の回答待ち: ${head}`.slice(0, 120), due: deadline ? jstDate(deadline) : null }];
        body.createTasks = 'single';
      }
      await api.post(`/cases/${caseId}/notes`, body);
      if (toStage && head) await api.put(`/cases/${caseId}`, { stage: head });
    },
    onSuccess: () => {
      setText('');
      setDeadline(null);
      setOccurredAt('');
      // 「現在の段階」は前の内容を置き換えるので、毎回選び直してもらう
      setToStage(false);
      draft.clear();
      setMsg(waiting && makeTask ? '進捗を登録し、回答待ちのタスクも作りました' : '進捗を登録しました');
      onDone();
    },
    onError: (e) => setMsg((e as Error).message),
  });
  const choose = (p: (typeof PROGRESS_PRESETS)[number]) => {
    setPreset(p);
    setWaitingFor(p.waitingFor);
    setMsg('');
  };
  return (
    <form
      className="card space-y-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) save.mutate();
      }}
    >
      <h2 className="font-semibold">進捗を登録</h2>
      <div className="flex flex-wrap gap-1">
        {PROGRESS_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className={`btn btn-sm ${preset.key === p.key ? 'btn-primary' : ''}`}
            onClick={() => choose(p)}
          >
            {p.counterpart || 'その他'}
          </button>
        ))}
      </div>
      {preset.key === 'other' && (
        <input className="input w-full md:w-64" value={counterpart} onChange={(e) => setCounterpart(e.target.value)} placeholder="相手・見出し（例: 保険会社に連絡）" />
      )}
      <div>
        <textarea
          className="input w-full resize-y"
          rows={2}
          placeholder={preset.placeholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setMsg('');
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim()) {
              e.preventDefault();
              save.mutate();
            }
          }}
        />
        <DraftHint handle={draft} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-xs">
          回答待ち
          <select className="input w-auto py-0.5 text-xs" value={waitingFor} onChange={(e) => setWaitingFor(e.target.value as WaitingFor)} aria-label="回答待ち">
            {WAITING_FOR.map((w) => (
              <option key={w} value={w}>
                {WAITING_FOR_LABEL[w]}
              </option>
            ))}
          </select>
        </label>
        {waiting && (
          <>
            <TaskDeadlineSelect value={deadline} onChange={setDeadline} label="期限" defaultLabel="既定（設定の営業日数）" />
            <label className="flex items-center gap-1 text-xs" title="この事件の「回答待ち」タスクを作ります。期限を過ぎると催促の対象になります">
              <input type="checkbox" checked={makeTask} onChange={(e) => setMakeTask(e.target.checked)} /> 回答待ちのタスクも作る
            </label>
          </>
        )}
        <label className="flex items-center gap-1 text-xs" title="事件の「現在の段階」を、この進捗の 1 行目で置き換えます">
          <input type="checkbox" checked={toStage} onChange={(e) => setToStage(e.target.checked)} /> 「現在の段階」にも入れる
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-500">
          日時
          <input type="datetime-local" className="input w-auto py-0.5 text-xs" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} aria-label="日時" />
        </label>
        <button className="btn btn-sm btn-primary ml-auto" disabled={save.isPending || !text.trim()}>
          {save.isPending ? '登録中…' : '登録'}
        </button>
      </div>
      {msg && <div className="fade-in text-xs text-slate-600">{msg}</div>}
      <p className="text-xs text-slate-400">日時を空にすると今の時刻で入ります。登録した進捗はタイムラインと記録に残り、AI 検索・進捗サマリーでも読みます。</p>
    </form>
  );
}

function Timeline({ caseId }: { caseId: number }) {
  const qc = useQueryClient();
  const t = useQuery({ queryKey: ['timeline', caseId], queryFn: () => api.get<TimelineItem[]>(`/cases/${caseId}/timeline`) });
  return (
    <div className="space-y-3">
      <ProgressForm
        caseId={caseId}
        onDone={() => {
          qc.invalidateQueries({ queryKey: ['timeline', caseId] });
          qc.invalidateQueries({ queryKey: ['case', String(caseId)] });
          qc.invalidateQueries({ queryKey: ['tasks'] });
        }}
      />
      <div className="card">
        <ul className="space-y-2 text-sm">
          {t.data?.map((i, idx) => {
            const wf = typeof i.ref?.waitingFor === 'string' && i.ref.waitingFor !== 'none' ? (i.ref.waitingFor as WaitingFor) : null;
            return (
              <li key={idx} className="flex gap-3 border-b border-slate-100 pb-2">
                <span className="w-32 shrink-0 text-slate-500">{fmtDateTime(i.at)}</span>
                <span className={`badge ${i.type.startsWith('message:in') ? 'badge-blue' : i.type.startsWith('message:out') ? 'badge-gray' : i.type.startsWith('event') ? 'badge-orange' : 'badge-gray'}`}>{typeLabel(i.type)}</span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {i.ref?.conversationId ? (
                      <Link to={`/inbox/${i.ref.conversationId}`} className="font-medium hover:underline">
                        {i.title}
                      </Link>
                    ) : (
                      <span className="font-medium">{i.title}</span>
                    )}
                    {wf && <span className="badge badge-orange">{WAITING_FOR_LABEL[wf]}の回答待ち</span>}
                  </div>
                  {i.body && <TimelineBody body={i.body} messageId={typeof i.ref?.messageId === 'number' ? i.ref.messageId : null} truncated={i.ref?.truncated === true} />}
                </div>
              </li>
            );
          })}
          {t.data?.length === 0 && <li className="text-slate-500">記録がありません</li>}
        </ul>
      </div>
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
  if (!q.data) return <div className="loading-text text-slate-500">読み込み中…</div>;
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
