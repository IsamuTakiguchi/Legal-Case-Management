import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface CcValue {
  cc: string[];
  bcc: string[];
}
export const EMPTY_CC: CcValue = { cc: [], bcc: [] };

interface CcSuggestions {
  defaults: string[];
  candidates: { address: string; label: string }[];
}

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** 「a@x.jp, b@y.jp」「山田 <a@x.jp>」のような入力からアドレスを取り出す */
export function splitAddresses(s: string): { ok: string[]; bad: string[] } {
  const ok: string[] = [];
  const bad: string[] = [];
  for (const part of s.split(/[,、;；\s]+/)) {
    const t = part.replace(/^.*</, '').replace(/>.*$/, '').trim();
    if (!t) continue;
    (EMAIL_RE.test(t) ? ok : bad).push(t);
  }
  return { ok, bad };
}

/**
 * Gmail で送るときの CC・BCC の欄。
 * 前回この宛先に送ったときの CC をはじめから入れ、依頼者のほかのアドレス・担当者・これまでの CC を候補として出す。
 * source: 会話が決まっていれば conversationId、まだなら依頼者と送るアドレス
 */
export function CcField({
  source,
  value,
  onChange,
  disabled,
}: {
  source: { conversationId: number } | { clientId: number; to: string } | null;
  value: CcValue;
  onChange: (v: CcValue) => void;
  disabled?: boolean;
}) {
  const key = !source ? '' : 'conversationId' in source ? `conv:${source.conversationId}` : `client:${source.clientId}:${source.to}`;
  const q = useQuery({
    queryKey: ['cc-suggestions', key],
    queryFn: () =>
      api.get<CcSuggestions>(
        'conversationId' in source! ? `/conversations/${source.conversationId}/cc-suggestions` : `/clients/${source!.clientId}/cc-suggestions?to=${encodeURIComponent(source!.to)}`,
      ),
    enabled: !!source,
    staleTime: 60_000,
  });
  // 宛先が変わったら、その宛先の「前回の CC」を入れ直す（手で直した後は、同じ宛先のあいだは触らない）
  const appliedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!q.data || appliedFor.current === key) return;
    appliedFor.current = key;
    onChange({ cc: q.data.defaults, bcc: value.bcc });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, key]);
  const [showBcc, setShowBcc] = useState(value.bcc.length > 0);

  const has = (a: string) => [...value.cc, ...value.bcc].some((x) => x.toLowerCase() === a.toLowerCase());
  const candidates = (q.data?.candidates ?? []).filter((c) => !has(c.address));

  return (
    <div className="space-y-1 text-xs">
      <AddressRow label="CC" list={value.cc} onChange={(cc) => onChange({ ...value, cc })} disabled={disabled} />
      {showBcc ? (
        <AddressRow label="BCC" list={value.bcc} onChange={(bcc) => onChange({ ...value, bcc })} disabled={disabled} hint="相手には見えません" />
      ) : (
        <button type="button" className="text-blue-700 hover:underline" onClick={() => setShowBcc(true)} disabled={disabled}>
          ＋ BCC を追加
        </button>
      )}
      {candidates.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-slate-500">CC の候補:</span>
          {candidates.map((c) => (
            <button
              key={c.address}
              type="button"
              className="rounded-full border border-slate-200 bg-white px-2 py-0.5 hover:border-blue-300 hover:bg-blue-50"
              onClick={() => onChange({ ...value, cc: [...value.cc, c.address] })}
              disabled={disabled}
              title={`${c.address} を CC に入れます`}
            >
              ＋ {c.label} <span className="text-slate-400">{c.address}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AddressRow({ label, list, onChange, disabled, hint }: { label: string; list: string[]; onChange: (v: string[]) => void; disabled?: boolean; hint?: string }) {
  const [input, setInput] = useState('');
  const [err, setErr] = useState('');
  const commit = () => {
    const { ok, bad } = splitAddresses(input);
    const next = [...list];
    for (const a of ok) if (!next.some((x) => x.toLowerCase() === a.toLowerCase())) next.push(a);
    if (ok.length) onChange(next);
    setInput(bad.join(', '));
    setErr(bad.length ? `メールアドレスの形になっていません: ${bad.join('、')}` : '');
  };
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="w-9 shrink-0 font-medium text-slate-700">{label}:</span>
        {list.map((a) => (
          <span key={a} className="flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5">
            {a}
            <button type="button" className="text-slate-500 hover:text-red-600" onClick={() => onChange(list.filter((x) => x !== a))} disabled={disabled} aria-label={`${a} を外す`}>
              ×
            </button>
          </span>
        ))}
        <input
          className="input min-w-[12rem] flex-1 py-0.5 text-xs"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
              if (!input.trim()) return;
              e.preventDefault();
              commit();
            }
          }}
          onBlur={() => input.trim() && commit()}
          placeholder={list.length ? 'さらに追加' : `${label} に入れるメールアドレス（Enter で追加）${hint ? `・${hint}` : ''}`}
          disabled={disabled}
        />
      </div>
      {err && <div className="text-red-600">{err}</div>}
    </div>
  );
}

/** 送信 API に渡す形（空なら付けない） */
export function ccPayload(v: CcValue): { cc?: string[]; bcc?: string[] } {
  return { ...(v.cc.length ? { cc: v.cc } : {}), ...(v.bcc.length ? { bcc: v.bcc } : {}) };
}
