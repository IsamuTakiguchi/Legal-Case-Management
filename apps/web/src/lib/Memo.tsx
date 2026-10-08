import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { dateOnlyDeadline, jstYmd } from '@lcm/shared';
import { api } from './api';
import { DeadlineInput, fmtDeadline } from './Deadline';

/**
 * 時期未定の備忘。「和解の前に和解案を教えてほしい」のように、日付はまだ決まらないが、
 * きっかけが来たらやること（主に報告）を、きっかけと見直す日つきのタスクとして残す
 */
export const MEMO_HINT = '日付はまだ決まらないが、きっかけ（「和解の前」など）が来たらやること。きっかけが来るまではタスクの数に入れません。見直す日と、後の連絡や記録できっかけが来たようなときに要確認でお知らせします';

export interface MemoCandidate {
  title: string;
  trigger: string;
  reportTo: string | null;
}

export interface MemoSuggestion {
  alertId: number;
  messageId: number;
  items: MemoCandidate[];
}

function daysLater(days: number): string {
  return dateOnlyDeadline(jstYmd(new Date(Date.now() + days * 86400_000)));
}

/** 一覧などに出す「⏳ 時期未定: 和解の前」の印 */
export function MemoBadge({ trigger, reviewAt }: { trigger: string; reviewAt?: string | null }) {
  return (
    <span className="badge badge-orange whitespace-nowrap" title={`${MEMO_HINT}${reviewAt ? `。次に見直す日: ${fmtDeadline(reviewAt)}` : ''}`}>
      ⏳ 時期未定: {trigger}
    </span>
  );
}

/** 備忘の登録フォーム（題名・きっかけ・見直す日） */
export function MemoForm({
  initial,
  sourceMessageId,
  conversationId,
  clientId,
  caseId,
  onDone,
  onCancel,
}: {
  initial?: { title: string; trigger: string };
  sourceMessageId?: number | null;
  conversationId?: number | null;
  clientId?: number | null;
  caseId?: number | null;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [trigger, setTrigger] = useState(initial?.trigger ?? '');
  const [reviewAt, setReviewAt] = useState<string | null>(daysLater(14));
  const [err, setErr] = useState('');
  const save = useMutation({
    mutationFn: () => api.post('/memos', { title: title.trim(), trigger: trigger.trim(), reviewAt, sourceMessageId: sourceMessageId ?? null, conversationId: conversationId ?? null, clientId: clientId ?? null, caseId: caseId ?? null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['conversation'] });
      qc.invalidateQueries({ queryKey: ['case'] });
      onDone();
    },
    onError: (e) => setErr((e as Error).message),
  });
  return (
    <form
      className="space-y-1.5 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="やること（例: 和解案を保険会社の岡田様に報告）" aria-label="やること" required />
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-[14rem] flex-1 items-center gap-1">
          <span className="whitespace-nowrap text-xs text-slate-500">きっかけ</span>
          <input className="input py-0.5" value={trigger} onChange={(e) => setTrigger(e.target.value)} placeholder="例: 和解の前、判決が出たら" aria-label="きっかけ" required />
        </label>
        <span className="flex items-center gap-1 text-xs text-slate-500" title="この日になってもまだ時期が決まっていなければ、要確認でお知らせします">
          見直す日
          <DeadlineInput value={reviewAt} onChange={setReviewAt} />
        </span>
      </div>
      {err && <div className="text-xs text-red-600">{err}</div>}
      <div className="flex gap-2">
        <button className="btn btn-sm btn-primary" disabled={save.isPending || !title.trim() || !trigger.trim()}>
          {save.isPending ? '登録中…' : '備忘に登録'}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            やめる
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * AI が見つけた時期未定の宿題の候補。1 件ずつ直して登録するか、不要にする。
 * すべて片付いたら要確認の候補も閉じる
 */
export function MemoSuggestionCard({ suggestion, onChanged }: { suggestion: MemoSuggestion; onChanged: () => void }) {
  const qc = useQueryClient();
  // 片付けた候補（登録・不要）
  const [handled, setHandled] = useState<number[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const close = useMutation({
    mutationFn: (status: 'resolved' | 'dismissed') => api.post(`/alerts/${suggestion.alertId}/resolve`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] });
      onChanged();
    },
  });
  const finish = (i: number, registered: boolean) => {
    const next = [...handled, i];
    setHandled(next);
    setEditing(null);
    if (next.length >= suggestion.items.length) close.mutate(registered ? 'resolved' : 'dismissed');
  };
  const rest = suggestion.items.map((it, i) => ({ it, i })).filter(({ i }) => !handled.includes(i));
  if (!rest.length) return null;
  return (
    <ul className="space-y-2">
      {rest.map(({ it, i }) => (
        <li key={i} className="rounded-md border border-orange-200 bg-white/70 p-2 text-sm">
          {editing === i ? (
            <MemoForm initial={{ title: it.title, trigger: it.trigger }} sourceMessageId={suggestion.messageId} onDone={() => finish(i, true)} onCancel={() => setEditing(null)} />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{it.title}</span>
              <MemoBadge trigger={it.trigger} />
              <span className="ml-auto flex gap-1">
                <button className="btn btn-sm btn-primary" onClick={() => setEditing(i)}>
                  備忘に登録
                </button>
                <button className="btn btn-sm" onClick={() => finish(i, false)} title="宿題ではない・もう済んだもの">
                  不要
                </button>
              </span>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * 受信メッセージから備忘を作るパネル。AI で候補を探すか、そのまま手で書く
 */
export function MemoPanel({ messageId, conversationId, clientId, onClose }: { messageId: number | null; conversationId?: number | null; clientId?: number | null; onClose: () => void }) {
  const [items, setItems] = useState<MemoCandidate[] | null>(null);
  const [err, setErr] = useState('');
  const [manual, setManual] = useState(false);
  const [done, setDone] = useState<number[]>([]);
  const detect = useMutation({
    mutationFn: () => api.post<{ items: MemoCandidate[] }>(`/messages/${messageId}/memos/detect`, {}),
    onSuccess: (r) => {
      setItems(r.items);
      if (!r.items.length) setManual(true);
    },
    onError: (e) => {
      setErr((e as Error).message);
      setManual(true);
    },
  });
  return (
    <div className="fade-in space-y-2 rounded-lg border border-orange-200 bg-orange-50/50 p-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">⏳ 時期未定の備忘</h3>
        <button className="btn btn-sm ml-auto" onClick={onClose}>
          閉じる
        </button>
      </div>
      <p className="text-xs text-slate-500">「和解の前に和解案を教えてほしい」のように、日付がまだ決まらない宿題を残します。きっかけが来るまではタスクの数に入れず、見直す日が来たときや、後の連絡・記録できっかけが来たようなときに要確認でお知らせします。</p>
      {messageId && items === null && (
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-sm btn-primary" disabled={detect.isPending} onClick={() => detect.mutate()}>
            {detect.isPending ? 'AI が読んでいます…' : 'いちばん新しい受信から AI で探す'}
          </button>
          {!manual && (
            <button className="btn btn-sm" onClick={() => setManual(true)}>
              自分で書く
            </button>
          )}
        </div>
      )}
      {err && <div className="text-xs text-red-600">{err}</div>}
      {items && items.length === 0 && <div className="text-xs text-slate-500">AI は時期未定の宿題を見つけませんでした。必要なら下に書いて登録してください。</div>}
      {items?.map((it, i) =>
        done.includes(i) ? (
          <div key={i} className="text-xs text-green-700">
            ✓ 登録しました: {it.title}
          </div>
        ) : (
          <div key={i} className="rounded-md border border-orange-200 bg-white/70 p-2">
            <MemoForm initial={{ title: it.title, trigger: it.trigger }} sourceMessageId={messageId} onDone={() => setDone([...done, i])} />
          </div>
        ),
      )}
      {manual && (
        <div className="rounded-md border border-slate-200 bg-white/70 p-2">
          <MemoForm sourceMessageId={messageId} conversationId={conversationId} clientId={clientId} onDone={() => setManual(false)} />
        </div>
      )}
    </div>
  );
}
