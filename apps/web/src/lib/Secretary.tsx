import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from './api';
import { toLocalInput, fromLocalInput, fmtDateTime } from './format';
import { DeadlineInput, DUE_LABEL, FOLLOW_LABEL } from './Deadline';
import { useDraft, DraftHint } from './draft';
import { Icon } from './icons';
import { useClients } from './ClientPicker';

/**
 * AI 秘書。
 *
 * 日本語で頼むと、依頼者と事件を秘書が調べ、記録・予定・タスクの「案」を出す。
 * 登録されるのは、中身を確かめて「この内容で登録」を押したときだけ。
 */

const NOTE_KINDS = [
  ['phone', '電話'],
  ['meeting', '打合せ'],
  ['court', '期日'],
  ['memo', 'メモ'],
  ['progress', '進捗'],
  ['policy', '方針'],
] as const;

const EVENT_KINDS = [
  ['hearing', '期日'],
  ['meeting', '打合せ'],
  ['consult', '相談'],
  ['hold', '仮押さえ'],
  ['other', 'その他'],
] as const;

const TASK_STATUSES = [
  ['open', '対応中'],
  ['waiting_client', '依頼者の返事待ち'],
  ['waiting_other', '相手方・裁判所の返事待ち'],
  ['waiting_staff', '事務局の回答・作業待ち'],
] as const;

interface NoteAction {
  type: 'note';
  summary: string;
  caseId: number;
  kind: string;
  occurredAt?: string | null;
  counterpart?: string | null;
  phone?: string | null;
  rawText: string;
}
interface EventAction {
  type: 'event';
  summary: string;
  title: string;
  startAt: string;
  endAt: string;
  kind: string;
  clientId?: number | null;
  caseId?: number | null;
  location?: string | null;
  description?: string | null;
  tentative?: boolean;
}
interface TaskAction {
  type: 'task';
  summary: string;
  title: string;
  note?: string | null;
  clientId?: number | null;
  caseId?: number | null;
  status: string;
  dueAt?: string | null;
  followUpAt?: string | null;
}
/** 変更・作成・削除・送信の案（項目は種類ごとに違うので、汎用の欄で直す） */
interface ExtendedAction {
  type: ExtendedType;
  summary: string;
  [field: string]: unknown;
}
type ExtendedType =
  | 'staff_create'
  | 'case_update'
  | 'case_create'
  | 'client_create'
  | 'client_update'
  | 'contact_create'
  | 'contact_update'
  | 'task_update'
  | 'task_delete'
  | 'event_update'
  | 'event_delete'
  | 'message_send';
export type Action = NoteAction | EventAction | TaskAction | ExtendedAction;

interface Change {
  field: string;
  label: string;
  before: string;
  after: string;
}
interface Preview {
  label: string;
  changes: Change[];
}

interface Source {
  kind: string;
  id: number;
  title: string;
  link: string;
  clientName: string | null;
  caseTitle: string | null;
  at: string | null;
}

interface Plan {
  reply: string;
  actions: Action[];
  previews?: Preview[];
  questions: string[];
  sources: Source[];
  used: string[];
}

interface Applied {
  type: string;
  ok: boolean;
  label: string;
  link?: string;
  error?: string;
}

interface CaseOption {
  id: number;
  title: string;
  clientName: string;
  status: string;
}

const TYPE_LABEL: Record<Action['type'], string> = {
  note: '記録',
  event: '予定',
  task: 'タスク',
  staff_create: '事務局の登録',
  case_update: '事件の変更',
  case_create: '事件の登録',
  client_create: '依頼者の登録',
  client_update: '依頼者の変更',
  contact_create: '関係者の追加',
  contact_update: '関係者の変更',
  task_update: 'タスクの変更',
  task_delete: 'タスクの削除',
  event_update: '予定の変更',
  event_delete: '予定の削除',
  message_send: '送信',
};
/** 取り消せない・外に出るもの（赤で目立たせる） */
const DANGER = new Set<string>(['task_delete', 'event_delete', 'message_send']);

const EXAMPLES = [
  '山田さんから電話。査定書は今週中に送るとのこと。記録しておいて',
  '佐藤さんと 10 月 3 日 14 時から事務所で打合せを入れて',
  '田中さんの件、来週金曜までに相手方へ回答するタスクを作って',
  '吉堂さんの自己破産の担当を藤田さんにして',
  '山田さんの答弁書のタスクを起案・検討完了にして',
];

export function Secretary() {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [turns, setTurns] = useState<{ role: 'user' | 'assistant'; text: string }[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  /** 画面で直したあとの案（登録するのはこちら） */
  const [actions, setActions] = useState<Action[]>([]);
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [applied, setApplied] = useState<Applied[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const draft = useDraft('secretary:text', text, setText, '');
  const clients = useClients();
  const cases = useQuery({ queryKey: ['cases', 'all'], queryFn: () => api.get<CaseOption[]>('/cases') });

  const ask = useMutation({
    mutationFn: (t: string) => api.post<Plan>('/secretary/plan', { text: t, history: turns.slice(-8) }),
    onSuccess: (r, t) => {
      setTurns((prev) => [...prev, { role: 'user', text: t }, { role: 'assistant', text: r.reply }]);
      setPlan(r);
      setActions(r.actions);
      setPreviews(r.previews ?? []);
      setSkip(new Set());
      setApplied(null);
      setErr(null);
      setText('');
      draft.clear();
    },
    onError: (e) => setErr((e as Error).message),
  });

  const apply = useMutation({
    mutationFn: () => api.post<{ applied: Applied[] }>('/secretary/apply', { actions: actions.filter((_, i) => !skip.has(i)) }),
    onSuccess: (r) => {
      setApplied(r.applied);
      setActions([]);
      setPlan((p) => (p ? { ...p, actions: [] } : p));
      setErr(null);
      // 登録したものが各画面にすぐ出るように
      for (const k of ['cases', 'tasks', 'calendar', 'nav-counts', 'dashboard']) qc.invalidateQueries({ queryKey: [k] });
    },
    onError: (e) => setErr((e as Error).message),
  });

  const run = () => {
    if (!text.trim() || ask.isPending) return;
    ask.mutate(text.trim());
  };
  const patch = (i: number, p: Partial<Action>) => setActions((prev) => prev.map((a, n) => (n === i ? ({ ...a, ...p } as Action) : a)));
  const toggleSkip = (i: number) =>
    setSkip((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const chosen = actions.filter((_, i) => !skip.has(i)).length;
  const reset = () => {
    setTurns([]);
    setPlan(null);
    setActions([]);
    setApplied(null);
    setErr(null);
  };

  return (
    <div className="space-y-3">
      <section className="card space-y-2">
        <div className="text-sm text-slate-600">
          頼みたいことを日本語で書いてください。依頼者と事件は秘書が探します。
          <span className="text-slate-500">登録されるのは、下の内容を確かめて「この内容で登録」を押したときだけです。</span>
        </div>
        <textarea
          className="input min-h-[72px]"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run();
          }}
          placeholder="例: 山田さんから電話。査定書は今週中に送るとのこと。記録しておいて"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" onClick={run} disabled={!text.trim() || ask.isPending}>
            {ask.isPending ? '調べています…' : '案を作ってもらう'}
          </button>
          <span className="text-xs text-slate-400">⌘ / Ctrl + Enter でも送れます</span>
          {turns.length > 0 && (
            <button className="btn btn-sm ml-auto" onClick={reset}>
              最初から
            </button>
          )}
        </div>
        <DraftHint handle={draft} />
        {turns.length === 0 && !ask.isPending && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            例:
            {EXAMPLES.map((e) => (
              <button key={e} className="rounded-full border border-slate-200 px-2 py-0.5 text-left hover:bg-slate-50" onClick={() => setText(e)}>
                {e}
              </button>
            ))}
          </div>
        )}
        {err && <div className="text-xs text-red-600">{err}</div>}
      </section>

      {ask.isPending && <div className="loading-text card text-sm text-slate-500">依頼者と事件を調べています…</div>}

      {turns.length > 0 && (
        <section className="card space-y-2">
          {turns.map((t, i) => (
            <div key={i} className={t.role === 'user' ? 'text-sm' : 'fade-in rounded-md bg-[var(--accent-soft)] p-2 text-sm'}>
              <span className="mr-1.5 text-xs text-slate-500">{t.role === 'user' ? 'あなた' : '秘書'}</span>
              <span className="whitespace-pre-wrap">{t.text}</span>
            </div>
          ))}
          {plan && plan.questions.length > 0 && (
            <ul className="list-inside list-disc text-sm text-amber-700">
              {plan.questions.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {actions.length > 0 && (
        <section className="card space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="flex items-center gap-1.5 font-semibold">
              <Icon name="check" className="h-4 w-4 text-[var(--accent)]" />
              登録する内容（確認してください）
            </h2>
            <span className="text-xs text-slate-500">中身は直せます。外したいものはチェックを外してください。</span>
          </div>
          {actions.some((a, i) => !skip.has(i) && DANGER.has(a.type)) && (
            <div className="rounded-md bg-red-50 px-3 py-1.5 text-xs text-red-700">赤い印の案（送信・削除）は、登録すると取り消せません。宛先・本文・対象をよく確かめてください。</div>
          )}
          {actions.map((a, i) => (
            <ActionCard key={i} a={a} preview={previews[i]} skip={skip.has(i)} onToggle={() => toggleSkip(i)} onChange={(p) => patch(i, p)} clients={clients.sorted} cases={cases.data ?? []} />
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" onClick={() => apply.mutate()} disabled={chosen === 0 || apply.isPending}>
              {apply.isPending ? '登録しています…' : `この内容で登録（${chosen} 件）`}
            </button>
            <button className="btn btn-sm" onClick={() => setActions([])} disabled={apply.isPending}>
              やめる
            </button>
          </div>
        </section>
      )}

      {applied && (
        <section className="card space-y-1.5">
          <h2 className="font-semibold">登録しました</h2>
          <ul className="space-y-1 text-sm">
            {applied.map((r, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <span className={`badge ${r.ok ? 'badge-blue' : 'badge-orange'}`}>{r.ok ? (TYPE_LABEL[r.type as Action['type']] ?? r.type) : '失敗'}</span>
                {r.ok && r.link ? (
                  <Link className="underline" to={r.link}>
                    {r.label}
                  </Link>
                ) : (
                  <span>{r.label}</span>
                )}
                {r.error && <span className="text-xs text-red-600">{r.error}</span>}
              </li>
            ))}
          </ul>
          {applied.some((r) => r.ok && r.type === 'note') && <div className="text-xs text-slate-500">記録は、要旨・決定事項・次のアクションに整理して保存しています。事件ページで直せます。</div>}
        </section>
      )}

      {plan && plan.sources.length > 0 && (
        <section className="card">
          <h2 className="mb-2 font-semibold">
            秘書が見た資料 <span className="text-xs font-normal text-slate-500">（調べるのに使ったもの）</span>
          </h2>
          <ul className="space-y-1">
            {plan.sources.slice(0, 8).map((s) => (
              <li key={`${s.kind}-${s.id}`} className="text-sm">
                <Link to={s.link} className="hover:underline">
                  <span className="badge badge-gray mr-1.5">{s.kind}</span>
                  {s.title}
                  {s.clientName && <span className="ml-1.5 text-xs text-slate-500">{s.clientName}</span>}
                  {s.at && <span className="ml-1.5 text-xs text-slate-400">{fmtDateTime(s.at)}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** 案 1 件。登録の前にここで直せる */
function ActionCard({
  a,
  preview,
  skip,
  onToggle,
  onChange,
  clients,
  cases,
}: {
  a: Action;
  preview?: Preview;
  skip: boolean;
  onToggle: () => void;
  onChange: (p: Partial<Action>) => void;
  clients: { id: number; name: string }[];
  cases: CaseOption[];
}) {
  const caseName = (id?: number | null) => {
    const c = cases.find((x) => x.id === id);
    return c ? `${c.clientName} / ${c.title}` : '';
  };
  return (
    <div className={`fade-in space-y-1.5 rounded-md border p-2 ${skip ? 'border-slate-200 bg-slate-50 opacity-60' : 'border-[var(--accent-border)]'}`}>
      <label className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={!skip} onChange={onToggle} />
        <span className={`badge ${DANGER.has(a.type) ? 'badge-orange !bg-red-100 !text-red-700' : 'badge-blue'}`}>{TYPE_LABEL[a.type] ?? a.type}</span>
        <span>{a.summary}</span>
      </label>
      {preview && preview.label && isExtended(a) && <div className="pl-6 text-xs text-slate-600">{preview.label}</div>}
      {isExtended(a) && <ExtendedEditor a={a} changes={preview?.changes ?? []} onChange={onChange} />}

      {a.type === 'note' && (
        <div className="space-y-1.5 pl-6">
          <div className="flex flex-wrap items-center gap-2">
            <select className="input w-auto" value={a.caseId} onChange={(e) => onChange({ caseId: Number(e.target.value) } as Partial<Action>)}>
              {!cases.some((c) => c.id === a.caseId) && <option value={a.caseId}>{caseName(a.caseId) || `事件 ${a.caseId}`}</option>}
              {cases.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.clientName} / {c.title}
                </option>
              ))}
            </select>
            <select className="input w-auto" value={a.kind} onChange={(e) => onChange({ kind: e.target.value } as Partial<Action>)}>
              {NOTE_KINDS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <input className="input w-40" value={a.counterpart ?? ''} onChange={(e) => onChange({ counterpart: e.target.value } as Partial<Action>)} placeholder="相手（依頼者など）" />
            <input
              type="datetime-local"
              className="input w-auto"
              value={toLocalInput(a.occurredAt ?? null)}
              onChange={(e) => onChange({ occurredAt: e.target.value ? fromLocalInput(e.target.value) : null } as Partial<Action>)}
            />
          </div>
          <textarea className="input min-h-[64px]" value={a.rawText} onChange={(e) => onChange({ rawText: e.target.value } as Partial<Action>)} />
        </div>
      )}

      {a.type === 'event' && (
        <div className="space-y-1.5 pl-6">
          <input className="input" value={a.title} onChange={(e) => onChange({ title: e.target.value } as Partial<Action>)} placeholder="件名" />
          <div className="flex flex-wrap items-center gap-2">
            <input type="datetime-local" className="input w-auto" value={toLocalInput(a.startAt)} onChange={(e) => onChange({ startAt: fromLocalInput(e.target.value) } as Partial<Action>)} />
            <span className="text-xs text-slate-500">〜</span>
            <input type="datetime-local" className="input w-auto" value={toLocalInput(a.endAt)} onChange={(e) => onChange({ endAt: fromLocalInput(e.target.value) } as Partial<Action>)} />
            <select className="input w-auto" value={a.kind} onChange={(e) => onChange({ kind: e.target.value } as Partial<Action>)}>
              {EVENT_KINDS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <input className="input w-40" value={a.location ?? ''} onChange={(e) => onChange({ location: e.target.value } as Partial<Action>)} placeholder="場所" />
          </div>
          <LinkRow a={a} onChange={onChange} clients={clients} cases={cases} />
        </div>
      )}

      {a.type === 'task' && (
        <div className="space-y-1.5 pl-6">
          <input className="input" value={a.title} onChange={(e) => onChange({ title: e.target.value } as Partial<Action>)} placeholder="タスク名" />
          <div className="flex flex-wrap items-center gap-2">
            <select className="input w-auto" value={a.status} onChange={(e) => onChange({ status: e.target.value } as Partial<Action>)}>
              {TASK_STATUSES.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <span className="inline-flex flex-wrap items-center gap-1 text-xs text-slate-600">
              {a.status === 'open' ? DUE_LABEL : FOLLOW_LABEL}
              <DeadlineInput
                value={a.status === 'open' ? (a.dueAt ?? null) : (a.followUpAt ?? null)}
                onChange={(v) => onChange((a.status === 'open' ? { dueAt: v } : { followUpAt: v }) as Partial<Action>)}
              />
            </span>
          </div>
          <LinkRow a={a} onChange={onChange} clients={clients} cases={cases} />
        </div>
      )}
    </div>
  );
}

/** 依頼者・事件の紐付け（予定とタスクで共通） */
function LinkRow({ a, onChange, clients, cases }: { a: EventAction | TaskAction; onChange: (p: Partial<Action>) => void; clients: { id: number; name: string }[]; cases: CaseOption[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
      依頼者
      <select className="input w-auto" value={a.clientId ?? ''} onChange={(e) => onChange({ clientId: e.target.value ? Number(e.target.value) : null } as Partial<Action>)}>
        <option value="">（なし）</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      事件
      <select className="input w-auto" value={a.caseId ?? ''} onChange={(e) => onChange({ caseId: e.target.value ? Number(e.target.value) : null } as Partial<Action>)}>
        <option value="">（なし）</option>
        {cases.map((c) => (
          <option key={c.id} value={c.id}>
            {c.clientName} / {c.title}
          </option>
        ))}
      </select>
    </div>
  );
}

const EXTENDED = new Set<string>(['staff_create', 'case_update', 'case_create', 'client_create', 'client_update', 'contact_create', 'contact_update', 'task_update', 'task_delete', 'event_update', 'event_delete', 'message_send']);
function isExtended(a: Action): a is ExtendedAction {
  return EXTENDED.has(a.type);
}

type FieldKind = 'text' | 'textarea' | 'datetime' | 'list' | 'bool' | 'select';
const CASE_STATUS_OPTS: [string, string][] = [
  ['consultation', '相談'],
  ['active', '進行事件'],
  ['wrapup', '残務処理'],
  ['closed', '終了事件'],
];
const TASK_STATUS_OPTS: [string, string][] = [
  ['open', '対応中'],
  ['drafted', '起案・検討完了'],
  ['waiting_client', '依頼者の返事待ち'],
  ['waiting_other', '相手方・裁判所の返事待ち'],
  ['waiting_staff', '事務局の回答・作業待ち'],
  ['memo', '時期未定（備忘）'],
  ['done', '完了'],
];
const ROLE_OPTS: [string, string][] = [
  ['opponent', '相手方'],
  ['opponent_counsel', '相手方代理人'],
  ['opponent_insurer', '相手方保険会社'],
  ['client_insurer', '依頼者側保険会社'],
  ['court', '裁判所'],
  ['insurer', '保険会社'],
  ['other', 'その他'],
];
const CHANNEL_OPTS: [string, string][] = [
  ['gmail', 'Gmail'],
  ['line', 'LINE'],
  ['chatwork', 'Chatwork'],
];
/** 項目ごとの見出しと入力欄の種類 */
const FIELD_UI: Record<string, { label: string; kind: FieldKind; options?: [string, string][] }> = {
  title: { label: '名前・件名', kind: 'text' },
  name: { label: '名前', kind: 'text' },
  kana: { label: 'ふりがな', kind: 'text' },
  stage: { label: '段階', kind: 'text' },
  courtName: { label: '裁判所', kind: 'text' },
  caseNumber: { label: '事件番号', kind: 'text' },
  referrer: { label: '紹介者', kind: 'text' },
  staffName: { label: '担当事務局（名前）', kind: 'text' },
  organization: { label: '所属', kind: 'text' },
  phone: { label: '電話', kind: 'text' },
  fax: { label: 'FAX', kind: 'text' },
  location: { label: '場所', kind: 'text' },
  subject: { label: '件名', kind: 'text' },
  policy: { label: '方針メモ', kind: 'textarea' },
  notes: { label: 'メモ', kind: 'textarea' },
  note: { label: 'メモ', kind: 'textarea' },
  text: { label: '本文', kind: 'textarea' },
  startAt: { label: '開始', kind: 'datetime' },
  endAt: { label: '終了', kind: 'datetime' },
  dueAt: { label: '締切', kind: 'datetime' },
  followUpAt: { label: '返信期限', kind: 'datetime' },
  phones: { label: '電話（カンマ区切り）', kind: 'list' },
  emails: { label: 'メール（カンマ区切り）', kind: 'list' },
  addPhones: { label: '足す電話', kind: 'list' },
  removePhones: { label: '外す電話', kind: 'list' },
  addEmails: { label: '足すメール', kind: 'list' },
  removeEmails: { label: '外すメール', kind: 'list' },
  tentative: { label: '仮押さえ', kind: 'bool' },
  role: { label: '立場', kind: 'select', options: ROLE_OPTS },
  channel: { label: '送る手段', kind: 'select', options: CHANNEL_OPTS },
  preferredChannel: { label: '連絡手段', kind: 'select', options: CHANNEL_OPTS },
  entityType: {
    label: '個人・法人',
    kind: 'select',
    options: [
      ['individual', '個人'],
      ['corporation', '法人'],
    ],
  },
  kind: {
    label: '種類',
    kind: 'select',
    options: EVENT_KINDS.map(([k, l]) => [k, l] as [string, string]),
  },
};
const CLEAR_LABEL: Record<string, string> = { staffId: '担当事務局', stage: '段階', courtName: '裁判所', caseNumber: '事件番号', policy: '方針メモ', referrer: '紹介者', dueAt: '締切', followUpAt: '返信期限', note: 'メモ' };
/** 画面で直さない項目（どれを対象にするかの ID など） */
const HIDDEN = new Set(['type', 'summary', 'caseId', 'clientId', 'contactId', 'taskId', 'eventId', 'personId', 'to', 'clear']);

/** 変更・作成・削除・送信の案を直す欄。項目ごとに「いま」の値も並べる */
function ExtendedEditor({ a, changes, onChange }: { a: ExtendedAction; changes: Change[]; onChange: (p: Partial<Action>) => void }) {
  const staff = useQuery({ queryKey: ['staff'], queryFn: () => api.get<{ id: number; name: string }[]>('/staff'), enabled: 'staffId' in a });
  const types = useQuery({ queryKey: ['case-types'], queryFn: () => api.get<{ key: string; label: string }[]>('/case-types'), enabled: 'caseType' in a });
  const before = (field: string) => changes.find((c) => c.field === field || (c.field === 'time' && (field === 'startAt' || field === 'endAt')))?.before;
  const set = (field: string, v: unknown) => onChange({ [field]: v } as Partial<Action>);
  const fields = Object.keys(a).filter((k) => !HIDDEN.has(k) && a[k] !== undefined);
  const clear = (a.clear as string[] | undefined) ?? [];
  if (a.type === 'task_delete' || a.type === 'event_delete') return <div className="pl-6 text-xs text-red-700">登録すると削除します（元に戻せません）。</div>;
  return (
    <div className="space-y-1.5 pl-6">
      {fields.map((f) => {
        const ui =
          f === 'status'
            ? { label: a.type.startsWith('case') ? '区分' : '状態', kind: 'select' as const, options: a.type.startsWith('case') ? CASE_STATUS_OPTS : TASK_STATUS_OPTS }
            : f === 'staffId'
              ? { label: a.type === 'message_send' ? '送る事務局' : '担当事務局', kind: 'select' as const, options: (staff.data ?? []).map((x) => [String(x.id), x.name] as [string, string]) }
              : f === 'caseType'
                ? { label: '事件類型', kind: 'select' as const, options: (types.data ?? []).map((x) => [x.key, x.label] as [string, string]) }
                : (FIELD_UI[f] ?? { label: f, kind: 'text' as const });
        const v = a[f];
        const prev = before(f);
        let input;
        if (ui.kind === 'textarea') input = <textarea className={`input ${f === 'text' ? 'min-h-32' : 'min-h-16'}`} value={String(v ?? '')} onChange={(e) => set(f, e.target.value)} />;
        else if (ui.kind === 'datetime')
          input = <input type="datetime-local" className="input w-auto" value={toLocalInput(typeof v === 'string' ? v : null)} onChange={(e) => set(f, e.target.value ? fromLocalInput(e.target.value) : undefined)} />;
        else if (ui.kind === 'list')
          input = (
            <input
              className="input"
              value={Array.isArray(v) ? v.join(', ') : ''}
              onChange={(e) =>
                set(
                  f,
                  e.target.value
                    .split(/[,、]/)
                    .map((x) => x.trim())
                    .filter(Boolean),
                )
              }
            />
          );
        else if (ui.kind === 'bool') input = <input type="checkbox" checked={!!v} onChange={(e) => set(f, e.target.checked)} />;
        else if (ui.kind === 'select')
          input = (
            <select className="input w-auto" value={String(v ?? '')} onChange={(e) => set(f, f === 'staffId' ? Number(e.target.value) : e.target.value)}>
              {!ui.options?.some(([k]) => k === String(v)) && <option value={String(v ?? '')}>{String(v ?? '')}</option>}
              {ui.options?.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          );
        else input = <input className="input" value={String(v ?? '')} onChange={(e) => set(f, e.target.value)} />;
        return (
          <div key={f} className={ui.kind === 'textarea' || ui.kind === 'list' || ui.kind === 'text' ? 'space-y-0.5' : 'flex flex-wrap items-center gap-2'}>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className="font-medium text-slate-700">{ui.label}</span>
              {prev !== undefined && <span>いま: {prev}</span>}
            </div>
            {input}
          </div>
        );
      })}
      {clear.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-slate-500">空にする:</span>
          {clear.map((c) => (
            <button key={c} type="button" className="rounded-full bg-slate-100 px-2 py-0.5 hover:bg-slate-200" title="空にしない" onClick={() => onChange({ clear: clear.filter((x) => x !== c) } as Partial<Action>)}>
              {CLEAR_LABEL[c] ?? c}
              {before(c) ? `（いま: ${before(c)}）` : ''} ×
            </button>
          ))}
        </div>
      )}
      {a.type === 'message_send' && <div className="text-xs text-red-700">登録すると、この本文がそのまま送られます。</div>}
    </div>
  );
}
