import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from './api';
import { useDraft, DraftHint } from './draft';
import { ClientPicker } from './ClientPicker';
import { fmtDateTime, fromLocalInput, todayLocalInput } from './format';
import { messageLink, dateOnlyDeadline, formatJaDateTime } from '@lcm/shared';
import { quickSendTimes } from './sendTimes';
import { Icon } from './icons';
import { ClientContactSetup } from './ClientContactSetup';

type ConfirmChannel = 'gmail' | 'line' | 'chatwork';

interface ConfirmCtx {
  messageId: number;
  conversationId: number;
  question: { senderName: string | null; sentAt: string; body: string };
  fromStaff: boolean;
  staffName: string | null;
  clientId: number | null;
  clientName: string | null;
  caseId: number | null;
  caseTitle: string | null;
  cases: { id: number; title: string }[];
  channels: { channel: ConfirmChannel; label: string; to: string; personId?: number | null; recipient?: string; conversationId: number | null; subject: string | null; lastMessageAt: string | null }[];
  defaultChannel: ConfirmChannel | null;
  defaultFollowUpAt: string;
  staffReplyText: string;
  sent: { channel: ConfirmChannel; conversationId: number; at: string; scheduledAt?: string | null }[];
  blocked: string | null;
  needsContact?: boolean;
}

const LABEL: Record<ConfirmChannel, string> = { gmail: 'Gmail', line: 'LINE', chatwork: 'Chatwork' };

/**
 * 事務局への返事の文を、送信予約に合わせて言い換える。
 * 「山田さんにLINEで確認しました」⇔「山田さんに10月13日(月)9時にLINEで確認します」
 */
function staffTextFor(t: string, scheduledAtIso: string | null): string {
  return t.replace(/に(?:[^。]*?に)?(Gmail|LINE|Chatwork)で確認(?:しました|します)/, (_m, ch: string) => (scheduledAtIso ? `に${formatJaDateTime(new Date(scheduledAtIso))}に${ch}で確認します` : `に${ch}で確認しました`));
}

/**
 * 事務局から Chatwork で来た質問を、弁護士本人が依頼者に確認する文に書き直して、Gmail か LINE で送る。
 * 送ったあと、元の質問に Chatwork で「確認しました」と返せる。
 */
export function ClientConfirmPanel({
  messageId,
  onClose,
  onSent,
  waitingTaskDefault = true,
}: {
  messageId: number;
  onClose: () => void;
  onSent: () => void;
  /** 回答待ちのタスクを作るかの既定（タスク一覧から開いたときは、そのタスクを返信待ちにするので作らない） */
  waitingTaskDefault?: boolean;
}) {
  // 依頼者・事件を画面で選び直したら、送り先（メール・LINE）を引き直す
  const [pick, setPick] = useState<{ clientId: string; caseId: string }>({ clientId: '', caseId: '' });
  const qs = new URLSearchParams();
  if (pick.clientId) qs.set('clientId', pick.clientId);
  if (pick.caseId) qs.set('caseId', pick.caseId);
  const ctx = useQuery({
    queryKey: ['client-confirm', messageId, pick.clientId, pick.caseId],
    queryFn: () => api.get<ConfirmCtx>(`/messages/${messageId}/client-confirm${qs.size ? `?${qs}` : ''}`),
    placeholderData: (prev) => prev,
  });
  const d = ctx.data;
  // 宛先（チャネル＋担当者）。「gmail:12」のように持つ（担当者なしは「gmail:」）
  const [sel, setSel] = useState('');
  const keyOf = (c: { channel: string; personId?: number | null }) => `${c.channel}:${c.personId ?? ''}`;
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [instruction, setInstruction] = useState('');
  const [waiting, setWaiting] = useState(waitingTaskDefault);
  const [followUp, setFollowUp] = useState('');
  const [notifyStaff, setNotifyStaff] = useState(true);
  const [staffText, setStaffText] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [done, setDone] = useState(false);
  // 送信予約（受信箱の「時刻を指定」と同じ）。空なら今すぐ送る
  const [showTimer, setShowTimer] = useState(false);
  const [sendAt, setSendAt] = useState('');
  const [sendPreset, setSendPreset] = useState<string | null>(null);
  const scheduledIso = showTimer && sendAt ? fromLocalInput(sendAt) : null;
  // 予約の時刻を変えたら、事務局への返事の文も「◯日◯時に確認します」に合わせる
  useEffect(() => {
    setStaffText((t) => staffTextFor(t, scheduledIso));
  }, [scheduledIso]);
  const textDraft = useDraft(`client-confirm:${messageId}`, text, setText, '');

  useEffect(() => {
    if (!d) return;
    setSel((prev) => (prev && d.channels.some((c) => keyOf(c) === prev) ? prev : (() => {
      const def = d.channels.find((c) => c.channel === d.defaultChannel);
      return def ? keyOf(def) : '';
    })()));
    setFollowUp((prev) => prev || d.defaultFollowUpAt.slice(0, 10));
    setStaffText(staffTextFor(d.staffReplyText, scheduledIso));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);
  const ch = d?.channels.find((c) => keyOf(c) === sel) ?? null;
  const channel: ConfirmChannel | '' = ch?.channel ?? '';
  // 法人の担当者がいれば、宛名も並べて出す
  const withPersons = !!d?.channels.some((c) => c.personId);
  // 既存のスレッドに返信するときは件名を使わない。新しいメールのときだけ件名を入れる
  const newGmail = channel === 'gmail' && !ch?.subject;

  const draft = useMutation({
    mutationFn: () =>
      api.post<{ text: string; subject: string | null }>(`/messages/${messageId}/client-confirm/draft`, {
        clientId: d?.clientId ?? null,
        caseId: d?.caseId ?? null,
        channel,
        personId: ch?.personId ?? null,
        instruction: instruction || null,
      }),
    onSuccess: (r) => {
      setText(r.text);
      if (r.subject) setSubject((prev) => prev || r.subject!);
      setMsg(null);
    },
    onError: (e) => setMsg({ kind: 'err', text: (e as Error).message }),
  });
  // 開いたら、まず AI に書き直してもらう（書きかけが残っていればそれを使う）
  const autoDrafted = useRef(false);
  useEffect(() => {
    if (autoDrafted.current || !d || d.blocked || !channel || text) return;
    autoDrafted.current = true;
    draft.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, channel]);

  const send = useMutation({
    mutationFn: () =>
      api.post<{ channel: ConfirmChannel; conversationId: number; messageId: number | null; scheduled: { id: number; scheduledAt: string } | null; waitingTaskId: number | null; staffNotified: boolean; staffError: string | null; note: string | null }>(`/messages/${messageId}/client-confirm`, {
        clientId: d!.clientId,
        caseId: d!.caseId,
        channel,
        personId: ch?.personId ?? null,
        text,
        subject: newGmail ? subject || null : null,
        createWaitingTask: waiting,
        followUpAt: waiting && followUp ? dateOnlyDeadline(followUp) : null,
        notifyStaff,
        staffReplyText: notifyStaff ? staffText : null,
        scheduledAt: scheduledIso,
      }),
    onSuccess: (r) => {
      textDraft.clear();
      setDone(true);
      const who = ch?.personId && ch.recipient ? ch.recipient : `${d!.clientName}さん`;
      const parts = [r.scheduled ? `${who}に ${LABEL[r.channel]} で ${fmtDateTime(r.scheduled.scheduledAt)} に送るよう予約しました（受信箱の会話の「送信予約」から取消・時刻変更・今すぐ送信ができます）` : `${who}に ${LABEL[r.channel]} で送りました`];
      if (r.waitingTaskId) parts.push('回答待ちのタスクを作りました');
      if (r.staffNotified) parts.push('事務局に Chatwork で返事しました');
      if (r.staffError) parts.push(`事務局への返事は失敗しました（${r.staffError}）`);
      if (r.note) parts.push(r.note);
      setMsg({ kind: r.staffError ? 'err' : 'ok', text: parts.join('。') });
      onSent();
    },
    onError: (e) => setMsg({ kind: 'err', text: (e as Error).message }),
  });

  const sentConv = send.data?.conversationId;
  return (
    <section className="fade-in card space-y-2 border-blue-200 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">依頼者に確認（Gmail・LINE・Chatwork）</h3>
        {d?.fromStaff && <span className="badge badge-gray">事務局{d.staffName ? `・${d.staffName}` : ''}からの質問</span>}
        <button className="btn btn-sm ml-auto" onClick={onClose}>
          閉じる
        </button>
      </div>
      {ctx.isLoading && <div className="loading-text text-slate-500">読み込み中…</div>}
      {d && (
        <>
          <blockquote className="whitespace-pre-wrap break-words rounded-md border-l-4 border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <div className="mb-0.5 text-[11px] text-slate-400">
              {d.question.senderName ?? '事務局'}・{fmtDateTime(d.question.sentAt)}
            </div>
            {d.question.body}
          </blockquote>
          {d.sent.length > 0 && (
            <div className="rounded-md bg-green-50 px-3 py-1.5 text-xs text-green-800">
              この質問は
              {d.sent.map((s) => (s.scheduledAt ? ` ${fmtDateTime(s.scheduledAt)} に ${LABEL[s.channel]} で送信予約` : ` ${fmtDateTime(s.at)} に ${LABEL[s.channel]} で確認済み`)).join('、')}
              です。
            </div>
          )}

          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0">
              <span className="label">依頼者</span>
              <ClientPicker
                value={pick.clientId || (d.clientId ? String(d.clientId) : '')}
                onChange={(id) => {
                  setPick({ clientId: id, caseId: '' });
                  setText('');
                  autoDrafted.current = false;
                }}
                selectClassName="w-56"
              />
            </label>
            {d.cases.length > 0 && (
              <label className="min-w-0">
                <span className="label">事件</span>
                <select className="input w-auto max-w-64" value={d.caseId ?? ''} onChange={(e) => setPick((p) => ({ clientId: p.clientId || String(d.clientId ?? ''), caseId: e.target.value }))}>
                  {d.cases.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {d.needsContact && d.clientId ? (
            <ClientContactSetup
              clientId={d.clientId}
              channels={['gmail', 'line']}
              onSaved={() => {
                autoDrafted.current = false;
                ctx.refetch();
              }}
            />
          ) : d.blocked ? (
            <div className="rounded-md bg-orange-50 px-3 py-2 text-xs text-orange-800">
              {d.blocked}
              {d.clientId && (
                <>
                  {' '}
                  <Link className="underline" to={`/clients/${d.clientId}`}>
                    依頼者の連絡先を開く
                  </Link>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3" role="radiogroup" aria-label="送る方法">
                {d.channels.map((c) => (
                  <label key={keyOf(c)} className="flex items-center gap-1">
                    <input
                      type="radio"
                      name={`confirm-ch-${messageId}`}
                      checked={sel === keyOf(c)}
                      onChange={() => {
                        setSel(keyOf(c));
                        // 事務局への返事の「Gmail で／LINE で」も合わせる
                        setStaffText((t) => t.replace(/(Gmail|LINE|Chatwork)で確認/, `${LABEL[c.channel]}で確認`));
                      }}
                    />
                    {withPersons && c.recipient && <span className="text-slate-700">{c.recipient}</span>}
                    <span className="font-medium">{c.label}</span>
                    <span className="text-xs text-slate-500">{c.channel === 'gmail' ? (c.subject ? `「${c.subject}」に返信` : `${c.to} に新しいメール`) : c.conversationId ? (c.channel === 'chatwork' ? 'いつものルーム' : 'いつものトーク') : c.channel === 'chatwork' ? c.to : ''}</span>
                  </label>
                ))}
              </div>
              {newGmail && (
                <label className="block">
                  <span className="label">件名</span>
                  <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="ご確認のお願い" maxLength={200} />
                </label>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <input className="input min-w-0 flex-1" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="AI への追加の指示（例: 期限は今週金曜と添える／もっと短く）" />
                <button className="btn btn-sm" onClick={() => draft.mutate()} disabled={draft.isPending || !channel}>
                  {draft.isPending ? '書き直し中…' : text ? 'AI で書き直す' : 'AI で下書き'}
                </button>
              </div>
              {draft.isPending && !text && <div className="loading-text text-xs text-slate-500">事務局の質問を、依頼者への確認に書き直しています…</div>}
              <textarea className="input min-h-40" value={text} onChange={(e) => setText(e.target.value)} placeholder="依頼者に送る本文" disabled={done} />
              <DraftHint handle={textDraft} />

              <div className="space-y-1.5 rounded-md bg-slate-50 px-3 py-2 text-xs">
                <label className="flex flex-wrap items-center gap-1">
                  <input type="checkbox" checked={waiting} onChange={(e) => setWaiting(e.target.checked)} disabled={done} /> 回答待ちのタスクを作る
                  {waiting && (
                    <>
                      <span className="ml-2 text-slate-500" title="依頼者の返事を待つ期限（日付だけ）。過ぎたらお知らせします">返信期限</span>
                      <input type="date" className="input w-auto py-0.5" value={followUp} onChange={(e) => setFollowUp(e.target.value)} disabled={done} />
                    </>
                  )}
                </label>
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={notifyStaff} onChange={(e) => setNotifyStaff(e.target.checked)} disabled={done} /> 事務局の質問に Chatwork で返信する
                </label>
                {notifyStaff && <input className="input py-1 text-xs" value={staffText} onChange={(e) => setStaffText(e.target.value)} disabled={done} aria-label="事務局への返信" />}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {done && sentConv ? (
                  <Link className="btn btn-sm" to={messageLink(sentConv, send.data?.messageId)}>
                    {send.data?.scheduled ? '予約した会話を開く' : '送ったやり取りを開く'}
                  </Link>
                ) : (
                  <span className="text-xs text-slate-500">送る前に本文を確認してください。送った文は依頼者との会話に残ります。</span>
                )}
                <div className="ml-auto flex flex-wrap items-center gap-1">
                  <button className="btn btn-primary btn-sm" onClick={() => send.mutate()} disabled={done || !text.trim() || !channel || send.isPending || (showTimer && !sendAt)}>
                    {send.isPending
                      ? showTimer
                        ? '予約中…'
                        : '送信中…'
                      : showTimer
                        ? sendAt
                          ? `${fmtDateTime(fromLocalInput(sendAt))} に${channel ? LABEL[channel] : ''}で送信予約`
                          : '時刻を選んでください'
                        : `${channel ? LABEL[channel] : ''}で${d.clientName ?? '依頼者'}さんに送る`}
                  </button>
                  <button
                    className={`btn btn-sm ${showTimer ? 'text-[var(--accent)]' : ''}`}
                    onClick={() => setShowTimer(!showTimer)}
                    disabled={done || send.isPending}
                    title="時刻を指定して、その時刻に自動で依頼者に送ります（送信予約）"
                    aria-expanded={showTimer}
                  >
                    <Icon name="clock" className="h-4 w-4" />
                    {showTimer ? '今すぐ送るに戻す' : '時刻を指定'}
                  </button>
                </div>
              </div>
              {showTimer && !done && (
                <div className="fade-in flex flex-wrap items-center gap-2 rounded-md bg-slate-50 px-3 py-2 text-xs">
                  <span className="text-slate-500">送信する時刻:</span>
                  {quickSendTimes().map((q) => (
                    <button
                      key={q.key}
                      className={`btn btn-sm ${sendPreset === q.key ? 'btn-primary' : ''}`}
                      onClick={() => {
                        setSendAt(q.value);
                        setSendPreset(q.key);
                      }}
                    >
                      {q.label}
                    </button>
                  ))}
                  <input
                    type="datetime-local"
                    className="input w-auto"
                    value={sendAt}
                    min={todayLocalInput(0)}
                    onChange={(e) => {
                      setSendAt(e.target.value);
                      setSendPreset(null);
                    }}
                    aria-label="送信する時刻"
                  />
                  <span className="text-slate-400">回答待ちのタスクと事務局への返事は、予約した時点で作ります</span>
                </div>
              )}
            </>
          )}
          {msg && <div className={`fade-in text-xs ${msg.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}>{msg.text}</div>}
        </>
      )}
    </section>
  );
}
