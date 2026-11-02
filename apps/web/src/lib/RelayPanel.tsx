import { useEffect, useRef, useState } from 'react';
import { InstructionBox } from './InstructionBox';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from './api';
import { useDraft, DraftHint } from './draft';
import { fmtDateTime } from './format';
import { copyText } from './copy';
import { messageLink, dateOnlyDeadline } from '@lcm/shared';

type Direction = 'to_counterparty' | 'to_client';

interface Target {
  key: string;
  kind: 'contact' | 'client';
  contactId: number | null;
  personId: number | null;
  channel: 'gmail' | 'line' | 'chatwork' | null;
  recipient: string;
  roleLabel: string | null;
  organization: string | null;
  to: string;
  conversationId: number | null;
  subject: string | null;
  fax: string | null;
}

interface RelayCtx {
  messageId: number;
  direction: Direction;
  message: { senderName: string | null; sentAt: string; body: string };
  clientId: number | null;
  clientName: string | null;
  caseId: number | null;
  caseTitle: string | null;
  cases: { id: number; title: string }[];
  from: { contactId: number; name: string; roleLabel: string } | null;
  targets: Target[];
  defaultTargetKey: string | null;
  defaultFollowUpAt: string;
  sent: { direction: Direction; recipient: string; channel: string; at: string }[];
  blocked: string | null;
}

const LABEL: Record<string, string> = { gmail: 'Gmail', line: 'LINE', chatwork: 'Chatwork', manual: 'FAX・郵送など' };

/**
 * 連絡の取次ぎ。依頼者から来た連絡・質問を相手方代理人などに、相手方代理人などから来た連絡・質問を依頼者に、
 * 弁護士本人からの連絡に書き直して伝える（AI が下書き → 確認・修正 → 送信）
 */
export function RelayPanel({ messageId, onClose, onSent }: { messageId: number; onClose: () => void; onSent: () => void }) {
  // 依頼者に事件が 2 つ以上あれば、どの事件の相手方に伝えるかを選び直せる
  const [caseId, setCaseId] = useState('');
  const ctx = useQuery({
    queryKey: ['relay', messageId, caseId],
    queryFn: () => api.get<RelayCtx>(`/messages/${messageId}/relay${caseId ? `?caseId=${caseId}` : ''}`),
    placeholderData: (prev) => prev,
  });
  const d = ctx.data;
  const [sel, setSel] = useState('');
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [instruction, setInstruction] = useState('');
  const [waiting, setWaiting] = useState(true);
  const [followUp, setFollowUp] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [done, setDone] = useState(false);
  const textDraft = useDraft(`relay:${messageId}`, text, setText, '');

  useEffect(() => {
    if (!d) return;
    setSel((prev) => (prev && d.targets.some((t) => t.key === prev) ? prev : (d.defaultTargetKey ?? '')));
    setFollowUp((prev) => prev || d.defaultFollowUpAt.slice(0, 10));
  }, [d]);
  const t = d?.targets.find((x) => x.key === sel) ?? null;
  const toCounterparty = d?.direction === 'to_counterparty';
  // 既存のメールに返信するときは件名を使わない。新しいメールのときだけ件名を入れる
  const newGmail = t?.channel === 'gmail' && !t.subject;
  const who = t ? `${t.roleLabel ? `${t.roleLabel} ` : ''}${t.recipient}` : '';

  const draft = useMutation({
    mutationFn: () => api.post<{ text: string; subject: string | null }>(`/messages/${messageId}/relay/draft`, { caseId: d?.caseId ?? null, targetKey: sel, instruction: instruction || null }),
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
    if (autoDrafted.current || !d || d.blocked || !sel || text) return;
    autoDrafted.current = true;
    draft.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, sel]);

  const send = useMutation({
    mutationFn: (manual: boolean) =>
      api.post<{ channelLabel: string; recipient: string; conversationId: number | null; messageId: number | null; waitingTaskId: number | null; note: string | null }>(`/messages/${messageId}/relay`, {
        caseId: d!.caseId,
        targetKey: sel,
        text,
        subject: newGmail ? subject || null : null,
        createWaitingTask: waiting,
        followUpAt: waiting && followUp ? dateOnlyDeadline(followUp) : null,
        manual,
      }),
    onSuccess: (r, manual) => {
      textDraft.clear();
      setDone(true);
      const parts = [manual ? `${r.recipient}さんに FAX・郵送などで伝えたことを記録しました` : `${r.recipient}さんに ${r.channelLabel} で伝えました`];
      if (r.waitingTaskId) parts.push('回答待ちのタスクを作りました');
      if (r.note) parts.push(r.note);
      setMsg({ kind: 'ok', text: parts.join('。') });
      onSent();
    },
    onError: (e) => setMsg({ kind: 'err', text: (e as Error).message }),
  });

  return (
    <section className="fade-in card space-y-2 border-blue-200 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{d ? (toCounterparty ? '相手方代理人などに伝える' : '依頼者に伝える') : '伝える'}</h3>
        {d?.caseTitle && <span className="badge badge-gray">{d.caseTitle}</span>}
        <button className="btn btn-sm ml-auto" onClick={onClose}>
          閉じる
        </button>
      </div>
      {ctx.isLoading && <div className="loading-text text-slate-500">読み込み中…</div>}
      {ctx.error && <div className="text-xs text-red-600">{(ctx.error as Error).message}</div>}
      {d && (
        <>
          <blockquote className="whitespace-pre-wrap break-words rounded-md border-l-4 border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <div className="mb-0.5 text-[11px] text-slate-400">
              {toCounterparty ? `依頼者（${d.message.senderName ?? d.clientName ?? ''}）から` : `${d.from?.roleLabel ?? '相手方'}（${d.from?.name ?? d.message.senderName ?? ''}）から`}・{fmtDateTime(d.message.sentAt)}
            </div>
            {d.message.body}
          </blockquote>
          {d.sent.length > 0 && (
            <div className="rounded-md bg-green-50 px-3 py-1.5 text-xs text-green-800">
              この連絡は {d.sent.map((s) => `${fmtDateTime(s.at)} に ${s.recipient}さんへ ${LABEL[s.channel] ?? s.channel} で`).join('、')} 伝え済みです。
            </div>
          )}
          {toCounterparty && d.cases.length > 1 && (
            <label className="flex flex-wrap items-center gap-1">
              <span className="text-xs text-slate-500">どの事件の相手方に伝えるか</span>
              <select
                className="input w-auto max-w-64"
                value={d.caseId ?? ''}
                onChange={(e) => {
                  setCaseId(e.target.value);
                  setSel('');
                  setText('');
                  autoDrafted.current = false;
                }}
              >
                {d.cases.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {d.blocked ? (
            <div className="rounded-md bg-orange-50 px-3 py-2 text-xs text-orange-800">
              {d.blocked}
              {d.caseId && toCounterparty && (
                <>
                  {' '}
                  <Link className="underline" to={`/cases/${d.caseId}`}>
                    事件ページを開く
                  </Link>
                </>
              )}
              {d.clientId && !toCounterparty && (
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
              <div className="flex flex-wrap items-center gap-3" role="radiogroup" aria-label="伝える相手と方法">
                {d.targets.map((x) => (
                  <label key={x.key} className="flex items-center gap-1">
                    <input
                      type="radio"
                      name={`relay-${messageId}`}
                      checked={sel === x.key}
                      onChange={() => {
                        // 宛先が変わったら、宛名が変わるので書き直す
                        if (sel && sel !== x.key && text && !done) setText('');
                        autoDrafted.current = false;
                        setSel(x.key);
                      }}
                    />
                    {x.roleLabel && <span className="badge badge-orange">{x.roleLabel}</span>}
                    <span className="whitespace-nowrap text-slate-700">{x.recipient}</span>
                    <span className="whitespace-nowrap font-medium">{x.channel ? LABEL[x.channel] : '送れない'}</span>
                    <span className="text-xs text-slate-500">{x.channel === 'gmail' ? (x.subject ? `「${x.subject}」に返信` : `${x.to} に新しいメール`) : x.channel ? '' : x.to}</span>
                  </label>
                ))}
              </div>
              {t && !t.channel && <div className="text-xs text-slate-500">メール・LINE が登録されていない相手です。文面を作ってコピーし、FAX・郵送などで送ってから「送ったことを記録」を押してください。</div>}
              {newGmail && (
                <label className="block">
                  <span className="label">件名</span>
                  <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
                </label>
              )}
              <InstructionBox
                value={instruction}
                onChange={setInstruction}
                onSubmit={() => !draft.isPending && sel && draft.mutate()}
                placeholder={toCounterparty ? 'AI への追加の指示（例: 回答期限を11月15日と添える／2 点目は伝えない）' : 'AI への追加の指示（例: 源泉徴収票は事務所に郵送してもらう／見通しも一言添える）'}
              />
              <div className="flex flex-wrap items-center gap-2">
                <button className="btn btn-sm" onClick={() => draft.mutate()} disabled={draft.isPending || !sel}>
                  {draft.isPending ? '書き直し中…' : text ? 'AI で書き直す' : 'AI で下書き'}
                </button>
                {text && (
                  <button className="btn btn-sm" onClick={() => copyText(text).then((ok) => setMsg(ok ? { kind: 'ok', text: '本文をコピーしました' } : { kind: 'err', text: 'コピーできませんでした。本文を選んでコピーしてください' }))}>
                    本文をコピー
                  </button>
                )}
              </div>
              {draft.isPending && !text && (
                <div className="loading-text text-xs text-slate-500">{toCounterparty ? '依頼者からの連絡を、相手方代理人への連絡に書き直しています…' : '相手方からの連絡を、依頼者に伝える文に書き直しています…'}</div>
              )}
              <textarea className="input min-h-40" value={text} onChange={(e) => setText(e.target.value)} placeholder={`${who}に伝える本文`} disabled={done} />
              <DraftHint handle={textDraft} />
              {toCounterparty && <div className="text-xs text-orange-700">依頼者の内心・交渉方針・不利な事情など、相手方に伝えるべきでないことが入っていないか確かめてから送ってください。</div>}

              <label className="flex flex-wrap items-center gap-1 rounded-md bg-slate-50 px-3 py-2 text-xs">
                <input type="checkbox" checked={waiting} onChange={(e) => setWaiting(e.target.checked)} disabled={done} /> {toCounterparty ? '相手方の回答待ち' : '依頼者の回答待ち'}のタスクを作る
                {waiting && (
                  <>
                    <span className="ml-2 text-slate-500">返信期限</span>
                    <input type="date" className="input w-auto py-0.5" value={followUp} onChange={(e) => setFollowUp(e.target.value)} disabled={done} />
                  </>
                )}
              </label>

              <div className="flex flex-wrap items-center gap-2">
                {done && send.data?.conversationId ? (
                  <Link className="btn btn-sm" to={messageLink(send.data.conversationId, send.data.messageId)}>
                    送ったやり取りを開く
                  </Link>
                ) : (
                  <span className="text-xs text-slate-500">送る前に本文を確認してください。</span>
                )}
                <div className="ml-auto flex flex-wrap items-center gap-1">
                  {t?.channel && (
                    <button className="btn btn-primary btn-sm" onClick={() => send.mutate(false)} disabled={done || !text.trim() || send.isPending}>
                      {send.isPending ? '送信中…' : `${LABEL[t.channel]}で${t.recipient}さんに送る`}
                    </button>
                  )}
                  <button
                    className={`btn btn-sm ${t && !t.channel ? 'btn-primary' : ''}`}
                    onClick={() => send.mutate(true)}
                    disabled={done || !text.trim() || send.isPending || !t}
                    title="FAX・郵送・電話など、アプリの外で伝えたときに、伝えたことだけを記録します"
                  >
                    送ったことを記録（FAX・郵送など）
                  </button>
                </div>
              </div>
            </>
          )}
          {msg && <div className={`fade-in text-xs ${msg.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}>{msg.text}</div>}
        </>
      )}
    </section>
  );
}
