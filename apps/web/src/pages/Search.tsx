import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useDraft, DraftHint } from '../lib/draft';
import { fmtDateTime } from '../lib/format';
import { Icon } from '../lib/icons';

const KINDS = ['note', 'message', 'case', 'client', 'task', 'event', 'form', 'creditor'] as const;
type Kind = (typeof KINDS)[number];

const KIND_LABEL: Record<Kind, string> = {
  note: '記録',
  message: 'やり取り',
  case: '事件',
  client: '依頼者',
  task: 'タスク',
  event: '予定',
  form: '書式',
  creditor: '債権者',
};

interface Hit {
  kind: Kind;
  id: number;
  title: string;
  snippet: string;
  at: string | null;
  clientName: string | null;
  caseTitle: string | null;
  link: string;
}

interface AskResult {
  question: string;
  terms: string[];
  answer: string;
  confidence: 'high' | 'medium' | 'low';
  missing: string;
  citations: Hit[];
  hits: Hit[];
}

const CONFIDENCE_LABEL: Record<AskResult['confidence'], { label: string; cls: string }> = {
  high: { label: '資料に明記', cls: 'badge badge-blue' },
  medium: { label: '資料から読み取り', cls: 'badge badge-gray' },
  low: { label: '資料が不足', cls: 'badge badge-orange' },
};

/** 根拠に使わなかったもの。通信をまたぐと同じ中身でも別のオブジェクトになるので、種類と ID で見分ける */
function others(r: AskResult): Hit[] {
  const used = new Set(r.citations.map((c) => `${c.kind}-${c.id}`));
  return r.hits.filter((h) => !used.has(`${h.kind}-${h.id}`));
}

const EXAMPLES = ['山田さんの査定書はどうなっている？', '今週中に返事をしないといけない件は？', '交通事故で後遺障害の等級が付いた事件は？'];

export default function Search() {
  const [q, setQ] = useState('');
  const [kinds, setKinds] = useState<Kind[]>([]);
  const [mode, setMode] = useState<'ask' | 'plain'>('ask');
  const [asked, setAsked] = useState<AskResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 書きかけの質問はこの端末に自動保存する
  const draft = useDraft('search:q', q, setQ, '');

  const ask = useMutation({
    mutationFn: () => api.post<AskResult>('/search/ask', { question: q, kinds: kinds.length ? kinds : undefined }),
    onSuccess: (r) => {
      setAsked(r);
      setErr(null);
    },
    onError: (e) => setErr((e as Error).message),
  });
  // そのままの検索（AI を使わないので速い）
  const plain = useQuery({
    queryKey: ['search', q, kinds.join(',')],
    queryFn: () => api.get<{ hits: Hit[] }>(`/search?q=${encodeURIComponent(q)}${kinds.length ? `&kinds=${kinds.join(',')}` : ''}`),
    enabled: mode === 'plain' && q.trim().length >= 2,
  });

  const run = () => {
    if (!q.trim()) return;
    setErr(null);
    if (mode === 'ask') ask.mutate();
    else plain.refetch();
  };
  const toggleKind = (k: Kind) => setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1>AI 検索</h1>
        <span className="text-sm text-slate-500">記録・やり取り・事件・タスク・予定・書式を、まとめて探します</span>
      </div>

      <section className="card space-y-2">
        <div className="segmented w-fit">
          {(['ask', 'plain'] as const).map((m) => (
            <button key={m} className={mode === m ? 'is-active' : ''} onClick={() => setMode(m)}>
              {m === 'ask' ? 'AI に聞く' : 'そのまま探す'}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input min-w-0 flex-1"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) run();
            }}
            placeholder={mode === 'ask' ? '聞きたいことを日本語で（例: 山田さんの査定書はどうなっている？）' : '探したい語（例: 査定書）'}
          />
          <button className="btn btn-primary" onClick={run} disabled={!q.trim() || ask.isPending}>
            {ask.isPending ? '探しています…' : mode === 'ask' ? 'AI に聞く' : '探す'}
          </button>
        </div>
        <DraftHint handle={draft} />
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-slate-500">探す先</span>
          <button className={`badge ${kinds.length === 0 ? 'badge-blue' : 'badge-gray'}`} onClick={() => setKinds([])}>
            すべて
          </button>
          {KINDS.map((k) => (
            <button key={k} className={`badge ${kinds.includes(k) ? 'badge-blue' : 'badge-gray'}`} onClick={() => toggleKind(k)}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        {mode === 'ask' && !asked && !ask.isPending && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            例:
            {EXAMPLES.map((e) => (
              <button key={e} className="rounded-full border border-slate-200 px-2 py-0.5 hover:bg-slate-50" onClick={() => setQ(e)}>
                {e}
              </button>
            ))}
          </div>
        )}
        {err && <div className="text-xs text-red-600">{err}</div>}
      </section>

      {mode === 'ask' && ask.isPending && <div className="loading-text card text-sm text-slate-500">記録・やり取りを探して、まとめています…</div>}

      {mode === 'ask' && asked && !ask.isPending && (
        <>
          <section className="card space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="flex items-center gap-1.5 font-semibold">
                <Icon name="search" className="h-4 w-4 text-[var(--accent)]" />
                答え
              </h2>
              {asked.answer && <span className={CONFIDENCE_LABEL[asked.confidence].cls}>{CONFIDENCE_LABEL[asked.confidence].label}</span>}
              {asked.terms.length > 0 && <span className="ml-auto text-xs text-slate-400">探した語: {asked.terms.join('・')}</span>}
            </div>
            {asked.answer ? (
              <div className="whitespace-pre-wrap text-sm">{asked.answer}</div>
            ) : (
              <div className="text-sm text-slate-500">{asked.missing || '当てはまるものが見つかりませんでした'}</div>
            )}
            {asked.answer && asked.missing && <div className="text-xs text-slate-500">足りない情報: {asked.missing}</div>}
            <div className="text-xs text-slate-400">答えは資料の抜粋から作っています。大事な判断の前は、下の根拠を開いて元の記録をお確かめください。</div>
          </section>

          {asked.citations.length > 0 && (
            <section className="card">
              <h2 className="mb-2 font-semibold">根拠にした資料</h2>
              <ul className="space-y-1.5">
                {asked.citations.map((h, i) => (
                  <HitRow key={`${h.kind}-${h.id}`} h={h} n={i + 1} />
                ))}
              </ul>
            </section>
          )}

          {others(asked).length > 0 && (
            <section className="card">
              <h2 className="mb-2 font-semibold">
                ほかの候補 <span className="text-xs font-normal text-slate-500">（答えには使っていないもの）</span>
              </h2>
              <ul className="space-y-1.5">
                {others(asked).map((h) => (
                  <HitRow key={`${h.kind}-${h.id}`} h={h} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {mode === 'plain' && (
        <section className="card">
          {plain.isFetching && <div className="loading-text text-sm text-slate-500">探しています…</div>}
          {!plain.isFetching && q.trim().length >= 2 && (plain.data?.hits.length ?? 0) === 0 && <div className="text-sm text-slate-500">見つかりませんでした</div>}
          <ul className="space-y-1.5">
            {(plain.data?.hits ?? []).map((h) => (
              <HitRow key={`${h.kind}-${h.id}`} h={h} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** 見つかったもの 1 件。押すとその場所へ飛ぶ */
function HitRow({ h, n }: { h: Hit; n?: number }) {
  return (
    <li>
      <Link to={h.link} className="block rounded-md border border-slate-100 p-2 text-sm hover:border-[var(--accent-border)] hover:bg-[var(--accent-soft)]">
        <div className="flex flex-wrap items-center gap-2">
          {n !== undefined && <span className="badge badge-blue">{n}</span>}
          <span className="badge badge-gray">{KIND_LABEL[h.kind]}</span>
          <span className="font-medium">{h.title}</span>
          {(h.clientName || h.caseTitle) && (
            <span className="text-xs text-slate-500">
              {h.clientName ?? ''}
              {h.caseTitle ? ` / ${h.caseTitle}` : ''}
            </span>
          )}
          {h.at && <span className="ml-auto whitespace-nowrap text-xs tabular-nums text-slate-400">{fmtDateTime(h.at)}</span>}
        </div>
        {h.snippet && <div className="mt-0.5 text-xs text-slate-600">{h.snippet}</div>}
      </Link>
    </li>
  );
}
