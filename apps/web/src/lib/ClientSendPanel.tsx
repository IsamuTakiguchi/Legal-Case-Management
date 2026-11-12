import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useDraft, DraftHint } from './draft';

interface ClientTargets {
  clientId: number;
  clientName: string;
  targets: { key: string; channel: 'gmail' | 'line' | 'chatwork'; channelLabel: string; to: string; personId: number | null; recipient: string }[];
  missing: string[];
  gmailThreads: { conversationId: number; subject: string; lastMessageAt: string | null; personId: number | null }[];
}

/**
 * 決まった本文（AI の送信案など）を、依頼者に送る。
 * 宛先（チャネル・窓口）を選び、メールなら前のメールの続きか新しい件名で送る。送った文は事件に付く
 */
export function ClientSendPanel({ clientId, caseId, initialText, draftKey, onClose, onSent }: { clientId: number; caseId?: number | null; initialText: string; draftKey: string; onClose: () => void; onSent?: (msg: string) => void }) {
  const targets = useQuery({ queryKey: ['send-targets', String(clientId)], queryFn: () => api.get<ClientTargets>(`/clients/${clientId}/send-targets`) });
  const [key, setKey] = useState('');
  const [thread, setThread] = useState('');
  const [subject, setSubject] = useState('');
  const [text, setText] = useState(initialText);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const draft = useDraft(`${draftKey}:client-send`, text, setText, initialText);
  useEffect(() => {
    if (!key && targets.data?.targets[0]) setKey(targets.data.targets[0].key);
  }, [targets.data, key]);
  const target = targets.data?.targets.find((t) => t.key === key) ?? null;
  const threads = (targets.data?.gmailThreads ?? []).filter((t) => (t.personId ?? null) === (target?.personId ?? null));
  // メールは、件名を入れなければいちばん新しいメールの続きにする
  useEffect(() => {
    setThread(threads[0] ? String(threads[0].conversationId) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, targets.data]);
  const needSubject = target?.channel === 'gmail' && !thread && !subject.trim();
  const send = useMutation({
    mutationFn: async () => {
      const conv = await api.post<{ conversationId: number }>(`/clients/${clientId}/start-conversation`, {
        channel: target!.channel,
        personId: target!.personId,
        subject: target!.channel === 'gmail' && !thread ? subject.trim() : null,
        threadConversationId: target!.channel === 'gmail' && thread ? Number(thread) : null,
      });
      const r = await api.post<{ note?: string; messageId?: number }>(`/conversations/${conv.conversationId}/send`, { text, attachmentIds: [], driveFiles: [], createWaitingTask: false });
      // 送った文をこの事件に付ける
      if (caseId && r.messageId) await api.put(`/messages/${r.messageId}/link`, { clientId, caseId }).catch(() => undefined);
      return { conversationId: conv.conversationId, note: r.note };
    },
    onSuccess: (r) => {
      draft.clear();
      const done = `${target!.recipient} さんに ${target!.channelLabel} で送りました${r.note ? `（${r.note}）` : ''}`;
      setMsg({ kind: 'ok', text: done });
      onSent?.(done);
    },
    onError: (e) => setMsg({ kind: 'err', text: (e as Error).message }),
  });
  const t = targets.data;
  return (
    <div className="fade-in space-y-2 rounded-md border border-blue-200 bg-blue-50/40 p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">依頼者に送る</span>
        {t && t.targets.length > 0 && (
          <select className="input w-auto max-w-full py-0.5 text-xs" value={key} onChange={(e) => setKey(e.target.value)} aria-label="送る相手とチャネル">
            {t.targets.map((x) => (
              <option key={x.key} value={x.key}>
                {x.recipient} ・ {x.channelLabel}
                {x.channel === 'gmail' ? `（${x.to}）` : ''}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="ml-auto text-xs text-slate-500 hover:text-slate-800" onClick={onClose}>
          閉じる
        </button>
      </div>
      {targets.isLoading && <div className="loading-text text-xs text-slate-500">送り先を確かめています…</div>}
      {t && t.targets.length === 0 && (
        <div className="text-xs text-orange-700">
          {t.clientName} さんに送れる連絡先がありません{t.missing.length ? `（${t.missing.join('、')}）` : ''}。
          <Link to={`/clients/${clientId}`} className="ml-1 underline">
            依頼者ページで連絡先を登録
          </Link>
        </div>
      )}
      {target?.channel === 'gmail' && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select className="input w-auto max-w-full py-0.5 text-xs" value={thread} onChange={(e) => setThread(e.target.value)} aria-label="メールの続きか新しいメールか">
            {threads.map((th) => (
              <option key={th.conversationId} value={th.conversationId}>
                「{th.subject || '（件名なし）'}」の続き
              </option>
            ))}
            <option value="">新しいメール（件名を入れる）</option>
          </select>
          {!thread && <input className="input min-w-0 flex-1 py-0.5 text-xs" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="件名" aria-label="件名" />}
        </div>
      )}
      <textarea className="input min-h-32 text-sm" value={text} onChange={(e) => setText(e.target.value)} aria-label="依頼者に送る本文" />
      <DraftHint handle={draft} />
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary btn-sm" onClick={() => send.mutate()} disabled={!target || !text.trim() || needSubject || send.isPending}>
          {send.isPending ? '送信中…' : target ? `${target.channelLabel} で送信` : '送信'}
        </button>
        {needSubject && <span className="text-xs text-slate-500">件名を入れてください</span>}
      </div>
      {msg && <div className={`fade-in text-xs ${msg.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}>{msg.text}</div>}
    </div>
  );
}
