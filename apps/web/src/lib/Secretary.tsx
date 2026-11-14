import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from './api';
import { toLocalInput, fromLocalInput, fmtDateTime } from './format';
import { DeadlineInput, DUE_LABEL, FOLLOW_LABEL } from './Deadline';
import { useDraft, DraftHint } from './draft';
import { Icon } from './icons';
import { useClients } from './ClientPicker';
import { quickSendTimes } from './sendTimes';
import { useDictation } from './dictation';

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
  | 'hold_confirm'
  | 'hold_cancel'
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

/** 画面に出すやり取りの 1 行（返事の下に、登録したものも出す） */
interface Turn {
  role: 'user' | 'assistant';
  text: string;
  at?: string;
  applied?: Applied[] | null;
}

/** サーバーに残っているやり取り（頼みごと 1 回分） */
interface StoredTurn {
  id: number;
  threadId: string;
  request: string;
  reply: string;
  actions: Action[];
  previews: Preview[];
  questions: string[];
  applied: Applied[] | null;
  createdAt: string;
}

function turnsOf(rows: StoredTurn[]): Turn[] {
  return rows.flatMap((r) => [
    { role: 'user' as const, text: r.request, at: r.createdAt },
    { role: 'assistant' as const, text: r.reply, applied: r.applied },
  ]);
}

const THREAD_KEY = 'secretary:thread';
function readThreadId(): string | null {
  try {
    return localStorage.getItem(THREAD_KEY);
  } catch {
    return null;
  }
}
function writeThreadId(id: string | null) {
  try {
    if (id) localStorage.setItem(THREAD_KEY, id);
    else localStorage.removeItem(THREAD_KEY);
  } catch {
    /* 保存できなくても続ける */
  }
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
  hold_confirm: '仮押さえの確定',
  hold_cancel: '仮押さえの取消',
  message_send: '送信',
};
/** 取り消せない・外に出るもの（赤で目立たせる） */
const DANGER = new Set<string>(['task_delete', 'event_delete', 'hold_cancel', 'message_send']);

const EXAMPLES = [
  '山田さんから電話。査定書は今週中に送るとのこと。記録しておいて',
  '佐藤さんと 10 月 3 日 14 時から事務所で打合せを入れて',
  '田中さんの件、来週金曜までに相手方へ回答するタスクを作って',
  '吉堂さんの自己破産の担当を藤田さんにして',
  '山田さんの答弁書のタスクを起案・検討完了にして',
];

/** よく使う頼み方（押すと書き出しが入る。続きを書くか、声で話す） */
const QUICK: [string, string][] = [
  ['📝 記録', '記録して：'],
  ['💬 事務局に送る', '担当事務にチャットで送って：'],
  ['📨 依頼者に送る', '依頼者に送って：'],
  ['📅 予定', '予定を入れて：'],
  ['✅ タスク', 'タスクを作って：'],
];

/** 秘書を開いた画面（依頼者・事件・会話）。頼みごとに名前が無ければ、これのことだと秘書に伝える */
export interface SecretaryContext {
  clientId?: number;
  caseId?: number;
  conversationId?: number;
}

export function Secretary({ context, compact = false, autoFocus = false }: { context?: SecretaryContext | null; /** シートなど狭いところに出すとき（説明と例を省く） */ compact?: boolean; autoFocus?: boolean } = {}) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);
  // 声で頼む（話した文を入力欄の末尾に足す）
  const voice = useDictation((t) => setText((prev) => `${prev}${t}`));
  const insert = (head: string) => {
    setText((prev) => (prev.trim() ? `${head}${prev}` : head));
    inputRef.current?.focus();
  };
  const [turns, setTurns] = useState<Turn[]>([]);
  // ひと続きのやり取り（サーバーに残る。閉じても・再読み込みしても続きから）と、いまの案の頼みごと
  const [threadId, setThreadIdState] = useState<string | null>(() => readThreadId());
  const [turnId, setTurnId] = useState<number | null>(null);
  const setThreadId = (id: string | null) => {
    setThreadIdState(id);
    writeThreadId(id);
  };
  const [showHistory, setShowHistory] = useState(false);
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

  // 前回の続き（このブラウザで最後に使ったやり取り）を出す。まだ登録していない案があればそれも
  const loadThread = async (id: string) => {
    const rows = await api.get<StoredTurn[]>(`/secretary/threads/${encodeURIComponent(id)}`).catch(() => [] as StoredTurn[]);
    if (!rows.length) {
      setThreadId(null);
      return;
    }
    setThreadId(id);
    setTurns(turnsOf(rows));
    const last = rows[rows.length - 1]!;
    const pending = !last.applied && last.actions.length > 0;
    setPlan({ reply: last.reply, actions: pending ? last.actions : [], previews: pending ? last.previews : [], questions: last.questions, sources: [], used: [] });
    setActions(pending ? last.actions : []);
    setPreviews(pending ? last.previews : []);
    setTurnId(pending ? last.id : null);
    setSkip(new Set());
    setApplied(null);
    setErr(null);
  };
  useEffect(() => {
    if (threadId) void loadThread(threadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ask = useMutation({
    mutationFn: (t: string) =>
      api.post<Plan & { threadId: string; turnId: number }>('/secretary/plan', {
        text: t,
        history: turns.slice(-8).map(({ role, text }) => ({ role, text })),
        ...(threadId ? { threadId } : {}),
        ...(context && (context.clientId || context.caseId || context.conversationId) ? { context } : {}),
      }),
    onSuccess: (r, t) => {
      setThreadId(r.threadId);
      setTurnId(r.turnId);
      qc.invalidateQueries({ queryKey: ['secretary-threads'] });
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
    mutationFn: () => api.post<{ applied: Applied[] }>('/secretary/apply', { actions: actions.filter((_, i) => !skip.has(i)), ...(turnId ? { turnId } : {}) }),
    onSuccess: (r) => {
      setApplied(r.applied);
      // 履歴の返事の下にも、登録したものを出す
      setTurns((prev) => {
        const i = prev.map((t) => t.role).lastIndexOf('assistant');
        return i < 0 ? prev : prev.map((t, n) => (n === i ? { ...t, applied: r.applied } : t));
      });
      setTurnId(null);
      qc.invalidateQueries({ queryKey: ['secretary-threads'] });
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
    if (voice.listening) voice.stop();
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
    setTurnId(null);
    setThreadId(null);
  };

  return (
    <div className="space-y-3">
      <section className={compact ? 'space-y-2' : 'card space-y-2'}>
        {!compact && (
          <div className="text-sm text-slate-600">
            頼みたいことを日本語で書いてください。依頼者と事件は秘書が探します。
            <span className="text-slate-500">登録されるのは、下の内容を確かめて「この内容で登録」を押したときだけです。</span>
          </div>
        )}
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 text-xs" aria-label="よく使う頼み方">
          {QUICK.map(([label, head]) => (
            <button key={label} type="button" className="shrink-0 whitespace-nowrap rounded-full border border-slate-200 bg-white px-2.5 py-1 text-slate-700 hover:bg-slate-50" onClick={() => insert(head)}>
              {label}
            </button>
          ))}
        </div>
        <textarea
          ref={inputRef}
          className="input min-h-[72px]"
          value={voice.interim ? `${text}${voice.interim}` : text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run();
          }}
          placeholder={context ? '例: 本人から書類が届いたので、法テラスへ審査回付をお願いと担当事務へ送って' : '例: 山田さんから電話。査定書は今週中に送るとのこと。記録しておいて'}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" onClick={run} disabled={!text.trim() || ask.isPending}>
            {ask.isPending ? '調べています…' : '案を作ってもらう'}
          </button>
          {voice.supported && (
            <button
              type="button"
              className={`btn ${voice.listening ? 'border-red-300 bg-red-50 text-red-600' : ''}`}
              onClick={voice.toggle}
              aria-pressed={voice.listening}
              title={voice.listening ? '話し終わったら押して止めます' : '声で頼みます（話した文が入力欄に入ります）'}
            >
              <Icon name="mic" className={`h-4 w-4 ${voice.listening ? 'animate-pulse' : ''}`} />
              {voice.listening ? '聞いています…（押して止める）' : '声で'}
            </button>
          )}
          {!compact && <span className="text-xs text-slate-400">⌘ / Ctrl + Enter でも送れます</span>}
          <span className="ml-auto flex gap-1.5">
            <button className={`btn btn-sm ${showHistory ? 'text-[var(--accent)]' : ''}`} onClick={() => setShowHistory(!showHistory)} aria-expanded={showHistory} title="これまでのやり取りを見返す・続きから頼む">
              🕘 履歴
            </button>
            {turns.length > 0 && (
              <button className="btn btn-sm" onClick={reset} title="新しいやり取りを始めます（今までのやり取りは履歴に残ります）">
                新しく頼む
              </button>
            )}
          </span>
        </div>
        {showHistory && (
          <SecretaryHistory
            current={threadId}
            onOpen={(id) => {
              setShowHistory(false);
              void loadThread(id);
            }}
            onDeleted={(id) => {
              if (id === threadId) reset();
            }}
          />
        )}
        <DraftHint handle={draft} />
        {voice.error && <div className="text-xs text-red-600">{voice.error}</div>}
        {!compact && turns.length === 0 && !ask.isPending && (
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
              {t.at && t.role === 'user' && <span className="mr-1.5 text-[11px] text-slate-400">{fmtDateTime(t.at)}</span>}
              <span className="mr-1.5 text-xs text-slate-500">{t.role === 'user' ? 'あなた' : '秘書'}</span>
              <span className="whitespace-pre-wrap">{t.text}</span>
              {t.applied && t.applied.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs">
                  {t.applied.map((r, n) => (
                    <li key={n} className="flex flex-wrap items-center gap-1.5">
                      <span className={`badge ${r.ok ? 'badge-blue' : 'badge-orange'}`}>{r.ok ? '登録済み' : '失敗'}</span>
                      {r.ok && r.link ? (
                        <Link className="underline" to={r.link}>
                          {r.label}
                        </Link>
                      ) : (
                        <span>{r.label}</span>
                      )}
                      {r.error && <span className="text-red-600">{r.error}</span>}
                    </li>
                  ))}
                </ul>
              )}
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

const EXTENDED = new Set<string>(['staff_create', 'case_update', 'case_create', 'client_create', 'client_update', 'contact_create', 'contact_update', 'task_update', 'task_delete', 'event_update', 'event_delete', 'hold_confirm', 'hold_cancel', 'message_send']);
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
  scheduledAt: { label: '送る日時', kind: 'datetime' },
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

/** 送る日時（空ならすぐ送る）。会話の画面の「時刻を指定」と同じ、よく使う時刻のボタンも出す */
function SendAtInput({ value, onChange }: { value: string | undefined; onChange: (v: string | undefined) => void }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <input type="datetime-local" className="input w-auto" value={toLocalInput(value ?? null)} onChange={(e) => onChange(e.target.value ? fromLocalInput(e.target.value) : undefined)} aria-label="送る日時" />
        {value ? (
          <button type="button" className="btn btn-sm" onClick={() => onChange(undefined)} title="送信予約をやめて、登録したときにすぐ送ります">
            すぐ送る
          </button>
        ) : (
          <span className="text-xs text-slate-500">空なら、登録したときにすぐ送ります</span>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {quickSendTimes().map((q) => (
          <button key={q.key} type="button" className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs hover:border-blue-300 hover:bg-blue-50" onClick={() => onChange(fromLocalInput(q.value))}>
            {q.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 変更・作成・削除・送信の案を直す欄。項目ごとに「いま」の値も並べる */
function ExtendedEditor({ a, changes, onChange }: { a: ExtendedAction; changes: Change[]; onChange: (p: Partial<Action>) => void }) {
  const staff = useQuery({ queryKey: ['staff'], queryFn: () => api.get<{ id: number; name: string }[]>('/staff'), enabled: 'staffId' in a });
  const types = useQuery({ queryKey: ['case-types'], queryFn: () => api.get<{ key: string; label: string }[]>('/case-types'), enabled: 'caseType' in a });
  const before = (field: string) => changes.find((c) => c.field === field || (c.field === 'time' && (field === 'startAt' || field === 'endAt')))?.before;
  const set = (field: string, v: unknown) => onChange({ [field]: v } as Partial<Action>);
  const fields = Object.keys(a).filter((k) => !HIDDEN.has(k) && a[k] !== undefined);
  // 送信は、日時を頼まれていなくても「送る日時」の欄を出す（あとから送信予約にできるように）
  if (a.type === 'message_send' && !fields.includes('scheduledAt')) fields.push('scheduledAt');
  const clear = (a.clear as string[] | undefined) ?? [];
  if (a.type === 'task_delete' || a.type === 'event_delete' || a.type === 'hold_cancel') return <div className="pl-6 text-xs text-red-700">登録すると削除します（元に戻せません）。</div>;
  if (a.type === 'hold_confirm') return <div className="pl-6 text-xs text-slate-600">登録すると、この候補で確定し、ほかの候補の仮押さえは消えます。</div>;
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
        else if (f === 'scheduledAt') input = <SendAtInput value={typeof v === 'string' ? v : undefined} onChange={(x) => set(f, x)} />;
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
      {a.type === 'message_send' && (
        <div className="text-xs text-red-700">
          {typeof a.scheduledAt === 'string' && a.scheduledAt
            ? `登録すると、${fmtDateTime(a.scheduledAt)} にこの本文を送るよう予約します（受信箱の会話の「送信予約」から取消・時刻変更・今すぐ送信ができます）。`
            : '登録すると、この本文がすぐに送られます。時刻を指定するときは「送る日時」を入れてください。'}
        </div>
      )}
    </div>
  );
}

interface ThreadSummary {
  threadId: string;
  first: string;
  last: string;
  turns: number;
  appliedOk: number;
  startedAt: string;
  updatedAt: string;
}

/** これまでのやり取りの一覧。押すと、そのやり取りの続きから頼める */
function SecretaryHistory({ current, onOpen, onDeleted }: { current: string | null; onOpen: (threadId: string) => void; onDeleted: (threadId: string) => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const list = useQuery({ queryKey: ['secretary-threads', q], queryFn: () => api.get<ThreadSummary[]>(`/secretary/threads${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`) });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/secretary/threads/${encodeURIComponent(id)}`),
    onSuccess: (_r, id) => {
      qc.invalidateQueries({ queryKey: ['secretary-threads'] });
      onDeleted(id);
    },
  });
  return (
    <div className="fade-in space-y-2 rounded-lg border border-slate-200 bg-white p-2 text-sm">
      <input className="input py-1 text-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="履歴を探す（例: 吉堂、審査回付）" aria-label="履歴を探す" />
      {list.isLoading && <div className="loading-text text-xs text-slate-500">読み込み中…</div>}
      {list.data?.length === 0 && <div className="text-xs text-slate-500">{q.trim() ? '見つかりませんでした' : 'まだやり取りはありません'}</div>}
      <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
        {list.data?.map((t) => (
          <li key={t.threadId} className={`flex items-start gap-2 py-1.5 ${t.threadId === current ? 'bg-[var(--accent-soft)]' : ''}`}>
            <button type="button" className="min-w-0 flex-1 rounded px-1 text-left hover:bg-slate-50" onClick={() => onOpen(t.threadId)} title="このやり取りを開いて、続きから頼む">
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                <span>{fmtDateTime(t.updatedAt)}</span>
                {t.turns > 1 && <span>{t.turns} 回</span>}
                {t.appliedOk > 0 && <span className="badge badge-blue">登録 {t.appliedOk} 件</span>}
                {t.threadId === current && <span className="badge badge-gray">いまのやり取り</span>}
              </div>
              <div className="truncate">{t.first}</div>
              {t.turns > 1 && <div className="truncate text-xs text-slate-500">… {t.last}</div>}
            </button>
            <button
              type="button"
              className="shrink-0 px-1 text-xs text-slate-400 hover:text-red-600"
              onClick={() => confirm('このやり取りを履歴から消しますか？（登録した記録・予定・タスクは消えません）') && del.mutate(t.threadId)}
              aria-label="履歴から消す"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
