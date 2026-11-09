import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { StaleUnanswered } from '../lib/StaleUnanswered';
import { Link, useSearchParams } from 'react-router-dom';
import { NewMessagePanel } from '../lib/NewMessagePanel';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { LongText } from '../lib/LongText';
import { ConversationTaskPanel } from '../lib/ConversationTaskPanel';
import { channelBadge, channelLabel, fmtRelative } from '../lib/format';

interface ConversationListItem {
  id: number;
  channel: string;
  subject: string | null;
  counterpartName: string | null;
  counterpartAddress: string | null;
  clientId: number | null;
  client: { id: number; name: string } | null;
  lastMessageAt: string | null;
  unread: number;
  needsReply: boolean;
  /** 検索ではアーカイブした会話も出す */
  archived?: boolean;
  staff?: boolean;
  /** LINE のグループ・複数人トーク（返信はグループ全体に届く） */
  lineGroup?: boolean;
  contact?: { id: number; name: string; role: string; roleLabel: string; organization: string | null; caseId: number; caseTitle: string } | null;
  lastMessage: { body: string; truncated?: boolean; direction: string; sentAt: string; senderName?: string | null } | null;
}

export default function Inbox() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  // こちらから新しく送る（依頼者・事務局）パネル
  const [composing, setComposing] = useState(false);
  // 受信箱の既定は「相手からの連絡で終わっている会話」だけ。自分が送って終わったものは出さない
  const filter = {
    channel: params.get('channel') ?? '',
    needsReply: params.get('needsReply') ?? '',
    unlinked: params.get('unlinked') ?? '',
    q: params.get('q') ?? '',
    archived: params.get('archived') ?? '',
    show: params.get('show') ?? 'unanswered',
  };
  const query = useQuery({
    queryKey: ['conversations', filter],
    queryFn: () => api.get<ConversationListItem[]>(`/conversations?${new URLSearchParams(Object.fromEntries(Object.entries(filter).filter(([, v]) => v))).toString()}`),
    refetchInterval: 30_000,
  });
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next);
  };
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [msg, setMsg] = useState('');
  // 行のボタンでアーカイブした直後は「元に戻す」を出す（押し間違えたときにすぐ戻せるように）
  const [undoArchive, setUndoArchive] = useState<number | null>(null);
  // 会話からタスクを登録する欄を開いている行と、登録したあとの知らせ
  const [taskFor, setTaskFor] = useState<number | null>(null);
  const [taskDone, setTaskDone] = useState<{ id: number; text: string } | null>(null);
  // 入力しながら探す（日本語入力の確定の Enter では送られないため、少し待ってから自動で探す）
  useEffect(() => {
    if (q === filter.q) return;
    const t = setTimeout(() => set('q', q.trim()), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const searching = !!filter.q;
  // 絞り込みを変えたら選択を解除
  useEffect(() => setSelected(new Set()), [filter.channel, filter.needsReply, filter.unlinked, filter.q, filter.archived, filter.show]);
  const ids = query.data?.map((c) => c.id) ?? [];
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // 行ごとの対応済み／アーカイブ（チェック不要）
  const rowAction = useMutation({
    mutationFn: (v: { id: number; action: 'resolve' | 'archive' | 'unarchive' }) => api.post<{ updated: number }>('/conversations/bulk', { ids: [v.id], action: v.action }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      setMsg(v.action === 'resolve' ? '対応済みにしました' : v.action === 'archive' ? 'アーカイブしました' : 'アーカイブを解除しました');
      setUndoArchive(v.action === 'archive' ? v.id : null);
    },
    onError: (e) => {
      setMsg((e as Error).message);
      setUndoArchive(null);
    },
  });
  const bulk = useMutation({
    mutationFn: (action: 'resolve' | 'archive' | 'unarchive' | 'read') => api.post<{ updated: number }>('/conversations/bulk', { ids: [...selected], action }),
    onSuccess: (r, action) => {
      setSelected(new Set());
      setUndoArchive(null);
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      const label = action === 'resolve' ? '対応済みにしました' : action === 'archive' ? 'アーカイブしました' : action === 'unarchive' ? 'アーカイブを解除しました' : '既読にしました';
      setMsg(`${r.updated} 件を${label}`);
    },
    onError: (e) => setMsg((e as Error).message),
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">受信箱</h1>
        <button className="btn btn-primary btn-sm" onClick={() => setComposing(!composing)} title="返信ではなく、こちらから依頼者（LINE・メール・Chatwork）や事務局（Chatwork）に送ります">
          ✉ 新しく送る
        </button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select className="input w-auto" value={filter.channel} onChange={(e) => set('channel', e.target.value)}>
            <option value="">全チャネル</option>
            <option value="line">LINE公式</option>
            <option value="chatwork">Chatwork</option>
            <option value="gmail">Gmail</option>
          </select>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={filter.needsReply === '1'} onChange={(e) => set('needsReply', e.target.checked ? '1' : '')} /> 未返信のみ
          </label>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={filter.unlinked === '1'} onChange={(e) => set('unlinked', e.target.checked ? '1' : '')} /> 未紐付けのみ
          </label>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={filter.archived === '1'} onChange={(e) => set('archived', e.target.checked ? '1' : '')} /> アーカイブ
          </label>
          <select className="input w-auto" value={filter.show} onChange={(e) => set('show', e.target.value)} title="自分が送って終わっている会話を出すかどうか">
            <option value="unanswered">未対応（相手が最後）</option>
            <option value="mine-last">自分が最後（返事待ち）</option>
            <option value="all">すべての会話</option>
            <option value="own">自分の送信だけの会話</option>
          </select>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              set('q', q);
            }}
          >
            <input className="input md:w-56" type="search" placeholder="名前・本文を検索" title="相手の名前・メールアドレス・件名・依頼者名・関係者名と、本文から探します。空白で区切るとすべてを含むものを探します" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
        </div>
      </div>
      {composing && <NewMessagePanel onClose={() => setComposing(false)} />}
      {searching && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span>
          「{filter.q}」で検索中: {query.isFetching && !query.data ? '…' : `${query.data?.length ?? 0} 件`}（「未対応」などの表示の切り替えやアーカイブに関係なく、すべての会話から探しています）
          </span>
          <button
            type="button"
            className="text-blue-700 hover:underline"
            onClick={() => {
              setQ('');
              set('q', '');
            }}
          >
            検索をやめる
          </button>
        </div>
      )}
      <StaleUnanswered compact />
      {((query.data?.length ?? 0) > 0 || undoArchive !== null) && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? new Set(ids) : new Set())} /> すべて選択
          </label>
          {selected.size > 0 ? (
            <>
              <span className="text-slate-600">{selected.size} 件を選択中</span>
              {filter.archived !== '1' && (
                <>
                  <button className="btn btn-sm" onClick={() => bulk.mutate('resolve')} disabled={bulk.isPending} title="要返信を外して既読にします">
                    対応済みにする
                  </button>
                  <button className="btn btn-sm" onClick={() => bulk.mutate('archive')} disabled={bulk.isPending} title="受信箱から外します（「アーカイブ」で見られます）">
                    アーカイブ
                  </button>
                </>
              )}
              {filter.archived === '1' && (
                <button className="btn btn-sm" onClick={() => bulk.mutate('unarchive')} disabled={bulk.isPending}>
                  アーカイブを解除
                </button>
              )}
              <button className="btn btn-sm text-slate-500" onClick={() => setSelected(new Set())}>
                選択解除
              </button>
            </>
          ) : (
            <span className="text-xs text-slate-400">チェックを付けると、まとめて対応済み・アーカイブにできます</span>
          )}
          {msg && (
            <span className="fade-in ml-auto flex items-center gap-2 text-xs text-slate-600">
              {msg}
              {undoArchive !== null && (
                <button type="button" className="btn btn-sm" onClick={() => rowAction.mutate({ id: undoArchive, action: 'unarchive' })} disabled={rowAction.isPending} title="アーカイブを取り消して受信箱に戻します">
                  元に戻す
                </button>
              )}
            </span>
          )}
        </div>
      )}
      <div className="card p-0">
        {query.isLoading && <div className="loading-text p-4 text-slate-500">読み込み中…</div>}
        {query.data?.length === 0 && (
          <div className="p-4 text-slate-500">
            {filter.show === 'unanswered' ? '相手からの連絡で終わっている会話はありません。自分が最後に送ったものは、右上の表示を「自分が最後（返事待ち）」に変えると見られます。' : '会話はありません。設定画面で各チャネルを接続してください。'}
          </div>
        )}
        <ul className="divide-y divide-slate-100">
          {query.data?.map((c) => (
            <li key={c.id} className={selected.has(c.id) ? 'bg-blue-50' : ''}>
              <div className="flex items-start">
                <label className="flex shrink-0 cursor-pointer items-center self-stretch px-2 md:px-3" title="選択">
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                </label>
                <div className={`min-w-0 flex-1 ${c.unread ? 'bg-blue-50/40' : ''}`}>
                  <Link to={`/inbox/${c.id}`} className="flex min-w-0 items-start gap-3 py-3 pr-3 hover:bg-slate-50 md:pr-4">
                    <span className="hidden shrink-0 md:block">
                      <span className={`${channelBadge(c.channel)} mt-0.5 w-20 justify-center`}>{channelLabel(c.channel)}</span>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 md:hidden">
                          <span className={channelBadge(c.channel)}>{channelLabel(c.channel)}</span>
                        </span>
                        <span className={`min-w-0 truncate ${c.unread ? 'font-bold' : 'font-medium'}`}>
                          {c.contact ? c.contact.name : (c.client?.name ?? (c.channel === 'chatwork' && c.subject ? c.subject : null) ?? c.counterpartName ?? c.counterpartAddress ?? '（不明）')}
                        </span>
                        {c.lineGroup && (
                          <span className="badge badge-gray shrink-0 whitespace-nowrap" title="このやり取りは LINE のグループです。返信はグループ全員に届きます">
                            グループ
                          </span>
                        )}
                        {c.contact && <span className="badge badge-orange shrink-0 whitespace-nowrap">{c.contact.roleLabel}</span>}
                        {c.contact && c.client && <span className="min-w-0 truncate text-xs text-slate-500">{c.client.name} / {c.contact.caseTitle}</span>}
                        <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-slate-400">{fmtRelative(c.lastMessageAt)}</span>
                      </div>
                      {(!c.clientId || c.needsReply || c.unread > 0 || c.subject || c.staff || (searching && c.archived)) && (
                        <div className="mt-0.5 flex items-center gap-2">
                          {c.staff && <span className="badge badge-gray shrink-0 whitespace-nowrap">事務局</span>}
                          {!c.clientId && !c.staff && <span className="badge badge-orange shrink-0 whitespace-nowrap">未紐付け</span>}
                          {c.needsReply && <span className="badge badge-blue shrink-0 whitespace-nowrap">要返信</span>}
                          {searching && c.archived && <span className="badge badge-gray shrink-0 whitespace-nowrap">アーカイブ</span>}
                          {c.unread > 0 && <span className="badge badge-blue shrink-0">{c.unread}</span>}
                          {c.subject && !(c.channel === 'chatwork' && !c.client) && <span className="min-w-0 truncate text-xs text-slate-500">{c.subject}</span>}
                        </div>
                      )}
                      {c.lastMessage && <MessagePreview body={c.lastMessage.body} truncated={!!c.lastMessage.truncated} mine={c.lastMessage.direction === 'out'} sender={c.channel === 'chatwork' && c.lastMessage.direction === 'in' ? c.lastMessage.senderName ?? null : null} />}
                    </div>
                  </Link>
                  {/* タスク化（足す操作）は本文の下の左に置き、右端の対応済み・アーカイブ（一覧から外す操作）と離して押し間違えないようにする */}
                  <div className="-mt-1 pb-2.5 md:pl-[5.75rem]">
                    <button
                      type="button"
                      className={`btn btn-sm whitespace-nowrap ${taskFor === c.id ? 'btn-primary' : 'border-blue-200 text-blue-700'}`}
                      onClick={() => setTaskFor(taskFor === c.id ? null : c.id)}
                      title="この会話のやり取りから、頼まれたこと・返事待ちのことをタスクにします（AI が案を作り、直してから登録します）"
                    >
                      ✅ タスク化
                    </button>
                  </div>
                </div>
                {/* 対応済みを上に、アーカイブは間を空けて下に置く */}
                <div className="flex shrink-0 flex-col gap-1 self-center px-2 py-2 md:px-3">
                  {!c.archived && c.needsReply && (
                    <button type="button" className="btn btn-sm whitespace-nowrap" onClick={() => rowAction.mutate({ id: c.id, action: 'resolve' })} disabled={rowAction.isPending} title="要返信を外して既読にします">
                      対応済み
                    </button>
                  )}
                  <button
                    type="button"
                    className={`btn btn-sm whitespace-nowrap text-slate-500 ${!c.archived && c.needsReply ? 'mt-4' : ''}`}
                    onClick={() => rowAction.mutate({ id: c.id, action: c.archived ? 'unarchive' : 'archive' })}
                    disabled={rowAction.isPending}
                    title={c.archived ? 'アーカイブを解除して受信箱に戻します' : '受信箱から外します（「アーカイブ」で見られます）'}
                  >
                    {c.archived ? '解除' : 'アーカイブ'}
                  </button>
                </div>
              </div>
              {taskFor === c.id && (
                <div className="px-2 pb-3 md:px-3">
                  <ConversationTaskPanel
                    conversationId={c.id}
                    onClose={() => setTaskFor(null)}
                    onDone={(text) => {
                      setTaskFor(null);
                      setTaskDone({ id: c.id, text });
                    }}
                  />
                </div>
              )}
              {taskDone?.id === c.id && taskFor !== c.id && (
                <div className="fade-in flex flex-wrap items-center gap-2 px-3 pb-2 text-xs text-green-700 md:px-4">
                  <span>✓ {taskDone.text}</span>
                  <Link to="/tasks" className="underline">
                    タスク一覧
                  </Link>
                  {!c.archived && c.needsReply && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        rowAction.mutate({ id: c.id, action: 'resolve' });
                        setTaskDone(null);
                      }}
                      disabled={rowAction.isPending}
                      title="タスクで追いかけるので、この会話の要返信を外して既読にします"
                    >
                      この会話は対応済みにする
                    </button>
                  )}
                  <button type="button" className="text-slate-400 hover:text-slate-700" onClick={() => setTaskDone(null)}>
                    ×
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** 最新メッセージの本文。短ければ全文、長文（目安 300 字 or 8 行超）は 4 行で折りたたみ「続きを表示」で開く */
function MessagePreview({ body, truncated, mine, sender }: { body: string; truncated: boolean; mine: boolean; sender?: string | null }) {
  return (
    <LongText text={body} className="text-sm text-slate-600" stopPropagation footer={truncated ? <div className="text-xs text-slate-400">…（続きは会話を開いて確認）</div> : null}>
      {mine && <span className="text-slate-400">自分: </span>}
      {!mine && sender && <span className="text-slate-400">{sender}: </span>}
      {body}
    </LongText>
  );
}
