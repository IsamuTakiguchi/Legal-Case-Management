import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { fmtDate } from './format';
import { HoldAddCandidates, HoldCandidateEdit, HoldLocationEditor, WindowConfirm, fmtEventRange, isHoldWindow } from './HoldForm';

interface Candidate {
  eventId: number | null;
  googleEventId: string;
  startAt: string;
  endAt: string;
}

export interface PendingHoldSet {
  sessionId: number;
  title: string;
  kind: string;
  proposedAt: string | null;
  rescheduleOf: { eventId: number; title: string; startAt: string; endAt: string } | null;
  clientId: number | null;
  clientName: string | null;
  caseId: number | null;
  caseTitle: string | null;
  conversationId: number | null;
  location: string | null;
  web: boolean;
  durationMinutes: number | null;
  candidates: Candidate[];
}

/**
 * 調整中の日程（仮押さえ）をまとめて出し、その場で確定・候補の日時変更・追加・取消ができる。
 * 予定ページの週・月の表示とは別に、週をまたいだ候補も 1 か所で見られるようにする
 */
export function PendingHoldsPanel({ onMsg, onConfirmed }: { onMsg: (m: { kind: 'ok' | 'err'; text: string }) => void; /** 確定した予定（依頼者への報告に使う） */ onConfirmed?: (eventId: number) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['calendar', 'holds'], queryFn: () => api.get<PendingHoldSet[]>('/calendar/holds') });
  const [open, setOpen] = useState(true);
  // 開いている入力欄（候補の追加・日時変更・枠の中の時間決め）
  const [form, setForm] = useState<{ kind: 'add' | 'move' | 'window'; sessionId: number; key?: string } | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['calendar'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const ok = (text: string) => {
    setForm(null);
    refresh();
    onMsg({ kind: 'ok', text });
  };
  const err = (e: unknown) => onMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  const confirm = useMutation({
    mutationFn: (v: { sessionId: number; eventId: number; startAt?: string; endAt?: string }) => api.post<{ id: number; webText?: string }>(`/calendar/holds/${v.sessionId}/confirm`, { eventId: v.eventId, startAt: v.startAt, endAt: v.endAt }),
    onSuccess: (r) => {
      ok(`確定しました。ほかの候補の仮押さえは削除しました${r.webText ? `\n${r.webText}` : ''}`);
      onConfirmed?.(r.id);
    },
    onError: err,
  });
  const cancelOne = useMutation({
    mutationFn: (v: { sessionId: number; eventId: number }) => api.post<{ remaining: number }>(`/calendar/holds/${v.sessionId}/candidates/${v.eventId}/cancel`),
    onSuccess: (r) => ok(r.remaining ? `この候補の仮押さえを取り消しました（残り ${r.remaining} 件）` : '最後の候補だったので、日程調整を取り消しました'),
    onError: err,
  });
  const cancelAll = useMutation({
    mutationFn: (sessionId: number) => api.post(`/calendar/holds/${sessionId}/cancel`),
    onSuccess: () => ok('仮押さえをすべて取り消しました'),
    onError: err,
  });
  const sets = q.data ?? [];
  if (q.isLoading || sets.length === 0) return null;
  return (
    <section className="card space-y-2 border-amber-200 text-sm">
      <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <h2 className="font-semibold">調整中の日程（仮押さえ）</h2>
        <span className="badge badge-orange">{sets.length} 件</span>
        <span className="ml-auto text-xs text-slate-500">{open ? '閉じる ▲' : '開く ▼'}</span>
      </button>
      {open && (
        <>
          <div className="text-xs text-slate-500">相手の返事が来たら、ここで候補を選んで確定できます（ほかの候補の仮押さえは消えます）。候補の日時を変えたり、足したり、取り消したりもできます。</div>
          <ul className="space-y-2">
            {sets.map((s) => (
              <li key={s.sessionId} id={`pending-hold-${s.sessionId}`} className="scroll-mt-4 rounded-md border border-slate-200 p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="badge badge-gray">{s.rescheduleOf ? '日程変更' : s.kind}</span>
                  <span className="font-medium">{s.title}</span>
                  {s.web && <span className="badge badge-blue">WEB</span>}
                  <span className="text-xs text-slate-500">
                    候補 {s.candidates.length} 件{s.proposedAt ? `・${fmtDate(s.proposedAt)} から調整中` : ''}
                  </span>
                  <span className="ml-auto flex flex-wrap items-center gap-2 text-xs">
                    {s.clientId && (
                      <Link to={`/clients/${s.clientId}`} className="text-blue-700 hover:underline">
                        {s.clientName ?? '依頼者'}
                      </Link>
                    )}
                    {s.caseId && (
                      <Link to={`/cases/${s.caseId}`} className="text-blue-700 hover:underline" title="事件ページから候補日の打診もできます">
                        {s.caseTitle ?? '事件'}
                      </Link>
                    )}
                    {s.conversationId && (
                      <Link to={`/inbox/${s.conversationId}`} className="text-blue-700 hover:underline">
                        会話
                      </Link>
                    )}
                  </span>
                </div>
                {s.rescheduleOf && (
                  <div className="mt-1 rounded bg-blue-50 px-2 py-1 text-xs text-blue-900">
                    いまの予定は <b>{fmtEventRange(s.rescheduleOf.startAt, s.rescheduleOf.endAt)}</b>。候補を確定すると、この予定は消えて新しい日時に置き換わります。
                  </div>
                )}
                <div className="mt-1">
                  <HoldLocationEditor sessionId={s.sessionId} location={s.location} web={s.web} onSaved={(text) => ok(text)} onError={(text) => onMsg({ kind: 'err', text })} />
                </div>
                <ul className="mt-1 divide-y divide-slate-100">
                  {s.candidates.map((v) => {
                    const window = isHoldWindow(v, s.durationMinutes);
                    const others = `ほかの候補（${Math.max(s.candidates.length - 1, 0)} 件）の仮押さえは削除されます。${s.rescheduleOf ? `元の予定（${fmtEventRange(s.rescheduleOf.startAt, s.rescheduleOf.endAt)}）も削除されます。` : ''}`;
                    const isForm = (kind: 'move' | 'window') => form?.kind === kind && form.sessionId === s.sessionId && form.key === v.googleEventId;
                    return (
                      <li key={v.googleEventId} className="py-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-slate-700">{fmtEventRange(v.startAt, v.endAt)}</span>
                          {window && <span className="badge badge-blue">枠（この中で {s.durationMinutes} 分）</span>}
                          {v.eventId ? (
                            <span className="ml-auto flex flex-wrap items-center gap-1">
                              <button
                                className="btn btn-sm btn-primary"
                                disabled={confirm.isPending}
                                onClick={() => {
                                  // 枠の候補は、その中で確定する時間を選んでから
                                  if (window) return setForm(isForm('window') ? null : { kind: 'window', sessionId: s.sessionId, key: v.googleEventId });
                                  if (globalThis.confirm(`${fmtEventRange(v.startAt, v.endAt)} で確定しますか？\n${others}`)) confirm.mutate({ sessionId: s.sessionId, eventId: v.eventId! });
                                }}
                              >
                                この候補で確定
                              </button>
                              <button className="btn btn-sm" onClick={() => setForm(isForm('move') ? null : { kind: 'move', sessionId: s.sessionId, key: v.googleEventId })} title="この候補の日時だけを変えます（ほかの候補はそのまま）">
                                日時を変更
                              </button>
                              <button
                                className="btn btn-sm"
                                disabled={cancelOne.isPending}
                                title="この候補だけ仮押さえを取り消します（ほかの候補は残ります）"
                                onClick={() => {
                                  if (globalThis.confirm(`${fmtEventRange(v.startAt, v.endAt)} の仮押さえだけを取り消しますか？${s.candidates.length <= 1 ? '\n最後の候補なので、日程調整も取り消されます。' : ''}`)) cancelOne.mutate({ sessionId: s.sessionId, eventId: v.eventId! });
                                }}
                              >
                                取消
                              </button>
                            </span>
                          ) : (
                            <span className="ml-auto text-xs text-slate-400">カレンダーにありません</span>
                          )}
                        </div>
                        {isForm('window') && v.eventId && s.durationMinutes && (
                          <div className="mt-1">
                            <WindowConfirm candidate={v} durationMinutes={s.durationMinutes} pending={confirm.isPending} note={others} onConfirm={(t) => confirm.mutate({ sessionId: s.sessionId, eventId: v.eventId!, ...t })} onCancel={() => setForm(null)} />
                          </div>
                        )}
                        {isForm('move') && v.eventId && (
                          <HoldCandidateEdit
                            sessionId={s.sessionId}
                            candidate={{ eventId: v.eventId, startAt: v.startAt, endAt: v.endAt }}
                            minutes={s.durationMinutes ?? Math.round((new Date(v.endAt).getTime() - new Date(v.startAt).getTime()) / 60_000)}
                            onClose={() => setForm(null)}
                            onSaved={ok}
                            onError={(text) => onMsg({ kind: 'err', text })}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
                {form?.kind === 'add' && form.sessionId === s.sessionId ? (
                  <HoldAddCandidates
                    sessionId={s.sessionId}
                    after={s.candidates[s.candidates.length - 1]?.startAt ?? new Date().toISOString()}
                    minutes={s.durationMinutes ?? (s.candidates[0] ? Math.round((new Date(s.candidates[0].endAt).getTime() - new Date(s.candidates[0].startAt).getTime()) / 60_000) : 60)}
                    onClose={() => setForm(null)}
                    onSaved={ok}
                    onError={(text) => onMsg({ kind: 'err', text })}
                  />
                ) : (
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
                    <button className="text-blue-700 hover:underline" onClick={() => setForm({ kind: 'add', sessionId: s.sessionId })} title="この日程調整に候補日時を足します">
                      ＋ 候補を追加
                    </button>
                    <button
                      className="text-slate-500 hover:text-red-600"
                      disabled={cancelAll.isPending}
                      onClick={() => {
                        if (globalThis.confirm(`この日程調整の仮押さえ ${s.candidates.length} 件をすべて取り消しますか？`)) cancelAll.mutate(s.sessionId);
                      }}
                    >
                      全候補を取消
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
