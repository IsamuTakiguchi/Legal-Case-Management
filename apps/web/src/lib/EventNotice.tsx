import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useDraft, DraftHint } from './draft';
import { CcField, EMPTY_CC, ccPayload, type CcValue } from './CcField';
import { ClientContactSetup, unreachableClientId } from './ClientContactSetup';
import { useLocalUploads, LocalFileButton, LocalFileBadges, FileDropZone } from './LocalFileAttach';

const CHANNEL_JA: Record<string, string> = { gmail: 'Gmail', line: 'LINE公式', chatwork: 'Chatwork' };

interface EventNotice {
  eventId: number;
  clientId: number;
  clientName: string;
  caseTitle: string | null;
  channel: string;
  channelLabel: string;
  to: string;
  personId: number | null;
  recipient: string;
  conversationId: number;
  draftId: number | null;
  text: string;
  info: { text: string; url: string | null };
  channels: { channel: string; to: string; personId?: number | null; recipient?: string }[];
}

/**
 * 決まった予定（期日・打合せ・相談）を依頼者に報告する。
 * 日時・場所・WEB 会議の URL を入れた下書きを作り、直してから依頼者に送る（予定ページ・事件ページから使う）
 */
export function EventNoticePanel({ eventId, onClose, onSent }: { eventId: number; onClose: () => void; onSent?: (msg: string) => void }) {
  // 宛先（チャネル＋担当者）。未選択ならサーバーの既定（主担当 → 希望チャネル）
  const [target, setTarget] = useState<{ channel: string; personId: number | null } | undefined>(undefined);
  const [ccv, setCcv] = useState<CcValue>(EMPTY_CC);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const uploads = useLocalUploads();
  const prep = useQuery({
    queryKey: ['event-notice', eventId, target?.channel ?? '', target?.personId ?? ''],
    queryFn: () => api.post<EventNotice>(`/calendar/events/${eventId}/client-notice`, target ?? {}),
    staleTime: Infinity,
    retry: false,
  });
  const n = prep.data;
  useEffect(() => {
    if (n) setText(n.text);
  }, [n]);
  // 下書きを直した内容を自動保存する（AI の下書きが変わったら戻さない）
  const draft = useDraft(n ? `event:${eventId}:client-notice` : null, text, setText, n?.text ?? '');
  const send = useMutation({
    mutationFn: () =>
      api.post<{ note?: string; links: { name: string }[]; manualFiles: string[] }>(`/conversations/${n!.conversationId}/send`, {
        text,
        attachmentIds: [],
        driveFiles: [],
        uploadIds: uploads.ids,
        draftId: n!.draftId,
        createWaitingTask: false,
        ...(n!.channel === 'gmail' ? ccPayload(ccv) : {}),
      }),
    onSuccess: (r) => {
      draft.clear();
      uploads.clear();
      const done = `${n!.recipient ?? n!.clientName}さんに ${n!.channelLabel} で予定を報告しました${r.note ? `（${r.note}）` : ''}${r.manualFiles.length ? `。${r.manualFiles.join('、')} は手動送付が必要です` : ''}`;
      setMsg(done);
      onSent?.(done);
    },
    onError: (e) => setMsg((e as Error).message),
  });
  return (
    <FileDropZone uploads={uploads} disabled={!n} className="fade-in mt-1 space-y-2 rounded-md border border-blue-200 bg-blue-50/40 p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">依頼者に予定を報告</span>
        {n && (
          <>
            <span className="text-xs text-slate-600">{n.recipient ?? n.clientName} 宛</span>
            <select
              className="input w-auto max-w-full py-0.5 text-xs"
              value={`${n.channel}:${n.personId ?? ''}`}
              onChange={(e) => {
                const [ch, pid] = e.target.value.split(':');
                setTarget({ channel: ch!, personId: pid ? Number(pid) : null });
              }}
              disabled={prep.isFetching}
              title="送る相手とチャネル（法人で主担当がいれば主担当、いなければ依頼者の希望チャネルが既定）"
              aria-label="送る相手とチャネル"
            >
              {n.channels.map((c) => (
                <option key={`${c.channel}:${c.personId ?? ''}`} value={`${c.channel}:${c.personId ?? ''}`}>
                  {n.channels.some((x) => x.personId) && c.recipient ? `${c.recipient} ・ ` : ''}
                  {CHANNEL_JA[c.channel] ?? c.channel}
                  {c.channel === 'gmail' ? `（${c.to}）` : ''}
                </option>
              ))}
            </select>
          </>
        )}
        <button type="button" className="ml-auto text-xs text-slate-500 hover:text-slate-800" onClick={onClose}>
          閉じる
        </button>
      </div>
      {prep.isLoading && <div className="loading-text text-xs text-slate-500">予定の日時・場所・WEB 会議の URL をもとに下書きを作成中…</div>}
      {prep.error &&
        (unreachableClientId(prep.error) ? (
          <ClientContactSetup clientId={unreachableClientId(prep.error)!} onSaved={() => prep.refetch()} />
        ) : (
          <div className="text-xs text-red-600">{(prep.error as Error).message}</div>
        ))}
      {n && (
        <>
          <pre className="whitespace-pre-wrap rounded border border-slate-200 bg-white p-2 font-sans text-xs text-slate-700">{n.info.text}</pre>
          {n.channel === 'gmail' && <CcField source={{ conversationId: n.conversationId }} value={ccv} onChange={setCcv} disabled={send.isPending || prep.isFetching} />}
          <textarea className="input min-h-40 text-sm" value={text} onChange={(e) => setText(e.target.value)} disabled={prep.isFetching} aria-label="依頼者への報告文" />
          <DraftHint handle={draft} />
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary btn-sm" onClick={() => send.mutate()} disabled={send.isPending || prep.isFetching || !text.trim() || uploads.uploading.length > 0}>
              {send.isPending ? '送信中…' : `${n.channelLabel} で送信`}
            </button>
            <LocalFileButton uploads={uploads} disabled={send.isPending} />
            <Link to={`/inbox/${n.conversationId}`} className="btn btn-sm">
              会話を開く
            </Link>
          </div>
          <LocalFileBadges uploads={uploads} />
        </>
      )}
      {msg && <div className="fade-in text-xs text-slate-700">{msg}</div>}
    </FileDropZone>
  );
}
