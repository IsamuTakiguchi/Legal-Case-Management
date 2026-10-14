import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useDraft, DraftHint } from './draft';

interface StaffAskCtx {
  /** 引用する元ネタ（届いた連絡・事件の記録・タスク） */
  subject: { kind: 'message' | 'note' | 'task'; head: string; body: string; link: string } | null;
  clientName: string | null;
  caseTitle: string | null;
  staff: { id: number; name: string; chatworkAccountId: number | null }[];
  defaultStaffId: number | null;
  rooms: { roomId: number; name: string; kind: string }[];
  defaultRoomId: number | null;
  /** Chatwork で返信できるメッセージ（タスクから送るとき） */
  replyTargets?: ReplyTarget[];
  defaultReplyKey?: string | null;
  blocked: string | null;
}

interface ReplyTarget {
  key: string;
  roomId: number;
  accountId: number;
  senderName: string | null;
  sentAt: string | null;
  excerpt: string;
  reason: 'reply' | 'task' | 'source' | 'conversation';
}

const REPLY_REASON_LABEL: Record<ReplyTarget['reason'], string> = { reply: '返事', task: 'Chatwork のタスク', source: 'きっかけ', conversation: '会話' };

function replyLabel(r: ReplyTarget): string {
  const when = r.sentAt ? new Date(r.sentAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  return `【${REPLY_REASON_LABEL[r.reason]}】${r.senderName ?? ''}${when ? `（${when}）` : ''}「${r.excerpt.slice(0, 40)}」`;
}

const ROOM_KIND_LABEL: Record<string, string> = { case: '事件専用', client: '依頼者', my: 'マイチャット', other: '' };
const QUOTE_LABEL: Record<string, string> = { message: '届いた連絡', note: '記録', task: 'タスクの内容' };

/**
 * 届いた連絡・事件の記録・タスクを引用して、Chatwork で担当事務局に確認・報告する。
 * base に `/conversations/12`・`/case-notes/34`・`/tasks/56` を渡して、受信箱・事件ページ・タスク一覧から使う。
 */
export function StaffAskPanel({ base, draftKey, onClose, onSent }: { base: string; draftKey: string; onClose: () => void; onSent: () => void }) {
  const ctx = useQuery({ queryKey: ['staff-ask', base], queryFn: () => api.get<StaffAskCtx>(`${base}/staff-ask`) });
  const [staffId, setStaffId] = useState('');
  const [roomId, setRoomId] = useState('');
  const [text, setText] = useState('');
  const [instruction, setInstruction] = useState('');
  const [quote, setQuote] = useState(true);
  const [asTask, setAsTask] = useState(false);
  const [due, setDue] = useState('');
  const [waiting, setWaiting] = useState(false);
  // 返信先（'' は返信にしない＝新しいメッセージとして送る）
  const [replyKey, setReplyKey] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const d = ctx.data;
  useEffect(() => {
    if (!d) return;
    setStaffId(d.defaultStaffId ? String(d.defaultStaffId) : '');
    setRoomId(d.defaultRoomId ? String(d.defaultRoomId) : '');
    setReplyKey(d.defaultReplyKey ?? '');
  }, [d]);
  const reply = d?.replyTargets?.find((r) => r.key === replyKey) ?? null;
  // 返信するときは、送り先は返信先のメッセージがあるルーム。Chatwork のタスクとしては送れない
  useEffect(() => {
    if (!reply) return;
    setRoomId(String(reply.roomId));
    setAsTask(false);
  }, [reply]);
  // 書きかけの確認文はこの端末に自動保存する
  const askDraft = useDraft(`${draftKey}:staff-ask`, text, setText, '');
  // ask=確認・依頼の文、report=状況報告の文を AI に書いてもらう
  const draft = useMutation({
    mutationFn: (mode: 'ask' | 'report') => api.post<{ text: string; title: string }>(`${base}/staff-ask/draft`, { instruction: instruction || null, mode }),
    onSuccess: (r) => {
      setText(r.text);
      setMsg(null);
    },
    onError: (e) => setMsg({ kind: 'err', text: (e as Error).message }),
  });
  const send = useMutation({
    mutationFn: () =>
      api.post<{ roomName: string; staffName: string | null; replyToName: string | null; asTask: boolean }>(`${base}/staff-ask`, {
        staffId: staffId ? Number(staffId) : null,
        roomId: Number(roomId),
        text,
        quote,
        asTask,
        due: due || null,
        createWaitingTask: waiting,
        replyTo: reply?.key ?? null,
      }),
    onSuccess: (r) => {
      askDraft.clear();
      setText('');
      setMsg({
        kind: 'ok',
        text:
          r.replyToName !== null
            ? `${r.roomName} で${r.replyToName ? `${r.replyToName}さんへの` : ''}返信として送りました`
            : `${r.roomName} に${r.staffName ? `（${r.staffName}さん宛で）` : ''}${r.asTask ? 'タスクとして' : ''}送りました`,
      });
      onSent();
    },
    onError: (e) => setMsg({ kind: 'err', text: (e as Error).message }),
  });
  return (
    <section className="fade-in card space-y-2 border-blue-200 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{d?.subject?.kind === 'task' ? '事務局に報告・確認（Chatwork）' : '事務局に確認（Chatwork）'}</h3>
        {d?.subject && <span className="text-xs text-slate-500">{d.subject.head} について</span>}
        <button className="btn btn-sm ml-auto" onClick={onClose}>
          閉じる
        </button>
      </div>
      {ctx.isLoading && <div className="loading-text text-slate-500">読み込み中…</div>}
      {d?.blocked && <div className="rounded-md bg-orange-50 px-3 py-2 text-xs text-orange-800">{d.blocked}</div>}
      {d && !d.blocked && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {/* スマホでは担当・送り先を 1 行ずつ幅いっぱいに（長いルーム名で横にはみ出さないように） */}
            <label className="flex w-full items-center gap-1 sm:w-auto">
              <span className="shrink-0 whitespace-nowrap">担当</span>
              <select className="input w-full min-w-0 sm:w-auto" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                <option value="">（宛先を付けない）</option>
                {d.staff.map((s) => (
                  <option key={s.id} value={s.id} disabled={!s.chatworkAccountId}>
                    {s.name}
                    {s.chatworkAccountId ? '' : '（Chatwork 未登録）'}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex w-full min-w-0 items-center gap-1 sm:w-auto sm:flex-1">
              <span className="shrink-0 whitespace-nowrap">送り先</span>
              <select className="input w-full min-w-0" value={roomId} onChange={(e) => setRoomId(e.target.value)} disabled={!!reply} title={reply ? '返信するときは、返信先のメッセージがあるルームに送ります' : undefined}>
                {d.rooms.map((r) => (
                  <option key={r.roomId} value={r.roomId}>
                    {r.name}
                    {ROOM_KIND_LABEL[r.kind] ? `（${ROOM_KIND_LABEL[r.kind]}）` : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!!d.replyTargets?.length && (
            <label className="flex w-full min-w-0 items-center gap-1">
              <span className="shrink-0 whitespace-nowrap">返信先</span>
              <select className="input w-full min-w-0" value={replyKey} onChange={(e) => setReplyKey(e.target.value)}>
                <option value="">返信にしない（新しいメッセージとして送る）</option>
                {d.replyTargets.map((r) => (
                  <option key={r.key} value={r.key}>
                    {replyLabel(r)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input min-w-0 flex-1"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder={d.subject?.kind === 'task' ? 'AI への指示（例: 準備書面の案は今日中に送る予定と伝える）' : 'AI への指示（例: 査定書が届いているか確認してほしい）'}
            />
            <button className="btn btn-sm" onClick={() => draft.mutate('ask')} disabled={draft.isPending} title="事務局に確かめてほしいこと・やってほしいことの文を書きます">
              {draft.isPending && draft.variables === 'ask' ? '作成中…' : 'AI で確認・依頼文'}
            </button>
            <button className="btn btn-sm" onClick={() => draft.mutate('report')} disabled={draft.isPending} title="いまどこまで進んだか・次に何をするかを事務局に知らせる文を書きます">
              {draft.isPending && draft.variables === 'report' ? '作成中…' : 'AI で報告文'}
            </button>
          </div>
          <textarea
            className="input min-h-24"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={d.subject?.kind === 'task' ? '報告・確認したいこと（例: 準備書面の案ができたので、明日依頼者に送ります。証拠の写しの準備をお願いします）' : '確認したいこと（例: 先週お送りした査定書が届いているか、依頼者に確認をお願いします）'}
          />
          <DraftHint handle={askDraft} />
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={quote} onChange={(e) => setQuote(e.target.checked)} /> {QUOTE_LABEL[d.subject?.kind ?? 'message']}を引用する
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={asTask} onChange={(e) => setAsTask(e.target.checked)} disabled={!!reply} /> Chatwork のタスクとして送る
            </label>
            {(asTask || waiting) && (
              <label className="flex items-center gap-1">
                期限 <input type="date" className="input w-auto py-0.5" value={due} onChange={(e) => setDue(e.target.value)} />
              </label>
            )}
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={waiting} onChange={(e) => setWaiting(e.target.checked)} />{' '}
              {d.subject?.kind === 'task' ? 'このタスクを「事務局の回答・作業待ち」にする' : 'アプリにも「事務局の返事待ち」を作る'}
            </label>
            <button className="btn btn-primary btn-sm ml-auto" onClick={() => send.mutate()} disabled={!text.trim() || !roomId || send.isPending}>
              {send.isPending ? '送信中…' : '事務局に送る'}
            </button>
          </div>
          {msg && <div className={`fade-in text-xs ${msg.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}>{msg.text}</div>}
          <div className="text-xs text-slate-400">送った内容は、その Chatwork ルームの会話にも控えとして残ります。</div>
        </>
      )}
    </section>
  );
}
