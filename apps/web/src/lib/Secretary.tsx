import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from './api';
import { toLocalInput, fromLocalInput, fmtDateTime } from './format';
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
export type Action = NoteAction | EventAction | TaskAction;

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

const TYPE_LABEL: Record<Action['type'], string> = { note: '記録', event: '予定', task: 'タスク' };

const EXAMPLES = [
  '山田さんから電話。査定書は今週中に送るとのこと。記録しておいて',
  '佐藤さんと 10 月 3 日 14 時から事務所で打合せを入れて',
  '田中さんの件、来週金曜までに相手方へ回答するタスクを作って',
];

export function Secretary() {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [turns, setTurns] = useState<{ role: 'user' | 'assistant'; text: string }[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  /** 画面で直したあとの案（登録するのはこちら） */
  const [actions, setActions] = useState<Action[]>([]);
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
          {actions.map((a, i) => (
            <ActionCard key={i} a={a} skip={skip.has(i)} onToggle={() => toggleSkip(i)} onChange={(p) => patch(i, p)} clients={clients.sorted} cases={cases.data ?? []} />
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
                <span className={`badge ${r.ok ? 'badge-blue' : 'badge-orange'}`}>{r.ok ? TYPE_LABEL[r.type as Action['type']] : '失敗'}</span>
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
          <div className="text-xs text-slate-500">記録は、要旨・決定事項・次のアクションに整理して保存しています。事件ページで直せます。</div>
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
  skip,
  onToggle,
  onChange,
  clients,
  cases,
}: {
  a: Action;
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
        <span className="badge badge-blue">{TYPE_LABEL[a.type]}</span>
        <span>{a.summary}</span>
      </label>

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
            <label className="text-xs text-slate-600">
              {a.status === 'open' ? '期限' : '催促する日'}
              <input
                type="datetime-local"
                className="input ml-1 w-auto"
                value={toLocalInput(a.status === 'open' ? (a.dueAt ?? null) : (a.followUpAt ?? null))}
                onChange={(e) => {
                  const v = e.target.value ? fromLocalInput(e.target.value) : null;
                  onChange((a.status === 'open' ? { dueAt: v } : { followUpAt: v }) as Partial<Action>);
                }}
              />
            </label>
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
