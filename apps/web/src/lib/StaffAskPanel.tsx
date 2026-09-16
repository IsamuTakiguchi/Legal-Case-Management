import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useDraft, DraftHint } from './draft';

interface StaffAskCtx {
  /** 引用する元ネタ（届いた連絡、または事件の記録） */
  subject: { kind: 'message' | 'note'; head: string; body: string; link: string } | null;
  clientName: string | null;
  caseTitle: string | null;
  staff: { id: number; name: string; chatworkAccountId: number | null }[];
  defaultStaffId: number | null;
  rooms: { roomId: number; name: string; kind: string }[];
  defaultRoomId: number | null;
  blocked: string | null;
}

const ROOM_KIND_LABEL: Record<string, string> = { case: '事件専用', client: '依頼者', my: 'マイチャット', other: '' };

/**
 * 届いた連絡や事件の記録を引用して、Chatwork で担当事務局に確認する。
 * base に `/conversations/12` か `/case-notes/34` を渡して、受信箱と事件ページの両方から使う。
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
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const d = ctx.data;
  useEffect(() => {
    if (!d) return;
    setStaffId(d.defaultStaffId ? String(d.defaultStaffId) : '');
    setRoomId(d.defaultRoomId ? String(d.defaultRoomId) : '');
  }, [d]);
  // 書きかけの確認文はこの端末に自動保存する
  const askDraft = useDraft(`${draftKey}:staff-ask`, text, setText, '');
  const draft = useMutation({
    mutationFn: () => api.post<{ text: string; title: string }>(`${base}/staff-ask/draft`, { instruction: instruction || null }),
    onSuccess: (r) => {
      setText(r.text);
      setMsg(null);
    },
    onError: (e) => setMsg({ kind: 'err', text: (e as Error).message }),
  });
  const send = useMutation({
    mutationFn: () =>
      api.post<{ roomName: string; staffName: string | null; asTask: boolean }>(`${base}/staff-ask`, {
        staffId: staffId ? Number(staffId) : null,
        roomId: Number(roomId),
        text,
        quote,
        asTask,
        due: due || null,
        createWaitingTask: waiting,
      }),
    onSuccess: (r) => {
      askDraft.clear();
      setText('');
      setMsg({ kind: 'ok', text: `${r.roomName} に${r.staffName ? `（${r.staffName}さん宛で）` : ''}${r.asTask ? 'タスクとして' : ''}送りました` });
      onSent();
    },
    onError: (e) => setMsg({ kind: 'err', text: (e as Error).message }),
  });
  return (
    <section className="fade-in card space-y-2 border-blue-200 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">事務局に確認（Chatwork）</h3>
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
            <label className="flex items-center gap-1">
              担当
              <select className="input w-auto" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                <option value="">（宛先を付けない）</option>
                {d.staff.map((s) => (
                  <option key={s.id} value={s.id} disabled={!s.chatworkAccountId}>
                    {s.name}
                    {s.chatworkAccountId ? '' : '（Chatwork 未登録）'}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 flex-1 items-center gap-1">
              送り先
              <select className="input min-w-0 flex-1" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                {d.rooms.map((r) => (
                  <option key={r.roomId} value={r.roomId}>
                    {r.name}
                    {ROOM_KIND_LABEL[r.kind] ? `（${ROOM_KIND_LABEL[r.kind]}）` : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input className="input min-w-0 flex-1" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="AI への指示（例: 査定書が届いているか確認してほしい）" />
            <button className="btn btn-sm" onClick={() => draft.mutate()} disabled={draft.isPending}>
              {draft.isPending ? '作成中…' : 'AI で下書き'}
            </button>
          </div>
          <textarea className="input min-h-24" value={text} onChange={(e) => setText(e.target.value)} placeholder="確認したいこと（例: 先週お送りした査定書が届いているか、依頼者に確認をお願いします）" />
          <DraftHint handle={askDraft} />
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={quote} onChange={(e) => setQuote(e.target.checked)} /> {d.subject?.kind === 'note' ? '記録' : '届いた連絡'}を引用する
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={asTask} onChange={(e) => setAsTask(e.target.checked)} /> Chatwork のタスクとして送る
            </label>
            {(asTask || waiting) && (
              <label className="flex items-center gap-1">
                期限 <input type="date" className="input w-auto py-0.5" value={due} onChange={(e) => setDue(e.target.value)} />
              </label>
            )}
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={waiting} onChange={(e) => setWaiting(e.target.checked)} /> アプリにも「事務局の返事待ち」を作る
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
