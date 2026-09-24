import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useDraft, DraftHint } from '../lib/draft';
import { ClientPicker } from '../lib/ClientPicker';
import { ContactLinkForm } from '../lib/ContactLinkForm';
import { StaffAskPanel } from '../lib/StaffAskPanel';
import { ClientConfirmPanel } from '../lib/ClientConfirmPanel';
import { channelBadge, channelLabel, fmtDateTime, fmtBytes, fromLocalInput, toLocalInput, todayLocalInput } from '../lib/format';
import { Icon } from '../lib/icons';
import { useSpotlight } from '../lib/spotlight';
import { quickSendTimes } from '../lib/sendTimes';
import { DeadlineEditor, TaskDeadlineSelect, WaitDeadlineSelect } from '../lib/Deadline';
import { SCHEDULING_KINDS, EVENT_KIND_LABEL, splitQuotedReply, type EventKind } from '@lcm/shared';

/** Chatwork の取込理由の表示名（設定画面の診断と同じ） */
const SCOPE_REASON_LABEL: Record<string, string> = {
  all: '取込範囲「すべて」',
  direct: 'ダイレクトチャット',
  to: '[To] で自分が指定',
  reply: '自分への返信',
  toall: '全員宛',
  task: '自分に振られたタスク',
  none: '記録なし（旧版で取り込み）',
};

interface Attachment {
  id: number;
  filename: string;
  size: number | null;
  status: string;
  storedPath: string | null;
}
interface Message {
  id: number;
  direction: 'in' | 'out';
  senderName: string | null;
  body: string;
  sentAt: string;
  attachments: Attachment[];
  /** 返信先（Chatwork の返信タグ、または自分の送信時に選んだ返信先） */
  replyTo?: { id: number; senderName: string | null; direction: string; excerpt: string } | null;
  /** Chatwork: なぜ受信箱に入ったか（取込範囲の確認用） */
  scopeReason?: string | null;
  /** 事務局の質問から依頼者に確認を送った記録 */
  clientConfirms?: { channel: string; conversationId: number; at: string }[];
  clientId?: number | null;
  caseId?: number | null;
  clientName?: string | null;
  caseTitle?: string | null;
}
interface Conv {
  id: number;
  channel: string;
  subject: string | null;
  counterpartName: string | null;
  counterpartAddress: string | null;
  clientId: number | null;
  caseId?: number | null;
  contactId?: number | null;
  needsReply: boolean;
  archived: boolean;
  unread?: number;
  staff?: boolean;
  /** LINE のグループ・複数人トーク（送信するとグループ全員に届く） */
  lineGroup?: boolean;
  /** LINE でブロック・友だち解除されていて、送っても届かない相手 */
  lineBlocked?: boolean;
  client: { id: number; name: string; onedriveFolderPath: string | null; preferredChannel: string | null } | null;
  contact?: { id: number; name: string; role: string; roleLabel: string; organization: string | null; caseId: number; caseTitle: string } | null;
  cases: { id: number; title: string; summary: string | null }[];
  messages: Message[];
  drafts: { id: number; generatedText: string; instruction: string | null; createdAt: string; status: string }[];
  suggestions: { id: number; name: string }[];
  scheduled: Scheduled[];
  /** Chatwork のリアクション（ワンタップ返信）のボタン。Chatwork 以外では空 */
  reactions?: { label: string; text: string; emoji: string }[];
}
interface Scheduled {
  id: number;
  text: string;
  scheduledAt: string;
  status: string;
  attempts: number;
  error: string | null;
}
interface Template {
  key: string;
  label: string;
  when: string;
}
interface Session {
  id: number;
  kind: string;
  state: string;
  candidates: { startAt: string; endAt: string; eventId?: string }[];
  confirmedStartAt: string | null;
  zoom: { joinUrl: string; password: string } | null;
  proposedAt: string | null;
}
interface DriveFile {
  name: string;
  path: string;
  itemId?: string;
  modifiedAt?: string;
  size?: number;
  folder: string;
}

export default function Conversation() {
  const { id } = useParams();
  const qc = useQueryClient();
  const conv = useQuery({ queryKey: ['conversation', id], queryFn: () => api.get<Conv>(`/conversations/${id}`), refetchInterval: 30_000 });
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api.get<Template[]>('/templates') });
  const sessions = useQuery({ queryKey: ['scheduling', id], queryFn: () => api.get<Session[]>(`/scheduling?conversationId=${id}`) });
  // 要確認の「日程調整が停滞」から ?session=… で来たら、その 1 件まで動かして光らせる
  const spotlightSession = useSpotlight('session', !!sessions.data);

  const [text, setText] = useState('');
  const [instruction, setInstruction] = useState('');
  const [templateKey, setTemplateKey] = useState('');
  const [draftId, setDraftId] = useState<number | null>(null);
  const [createWaiting, setCreateWaiting] = useState(false);
  const [waitUntil, setWaitUntil] = useState<string | null>(null);
  // 返信・引用の対象（会話のメッセージから選ぶ）
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  // リアクション欄を開いているメッセージ
  const [reactFor, setReactFor] = useState<number | null>(null);
  // 事務局の質問を依頼者に確認する（Gmail・LINE）パネルを開いているメッセージ
  const [confirmFor, setConfirmFor] = useState<number | null>(null);
  const [quoteOf, setQuoteOf] = useState<Message | null>(null);
  const [showTimer, setShowTimer] = useState(false);
  const [sendAt, setSendAt] = useState('');
  // よく使う時刻のどれを押したか（「1 時間後」は時刻が進むと値が変わるので、選択中の表示はこれで見る）
  const [sendPreset, setSendPreset] = useState<string | null>(null);
  const [selectedAtt, setSelectedAtt] = useState<number[]>([]);
  const [driveFiles, setDriveFiles] = useState<DriveFile[]>([]);
  const [showFiles, setShowFiles] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [showStaffAsk, setShowStaffAsk] = useState(false);
  const [showExtract, setShowExtract] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [linkClientId, setLinkClientId] = useState('');

  // 自分が別の手段で送ったものが「受信」で入ったときに、向きを直す
  const fixDirection = useMutation({
    mutationFn: (v: { id: number; direction: 'in' | 'out' }) => api.put(`/messages/${v.id}/direction`, { direction: v.direction }),
    onSuccess: (_r, v) => {
      setMsg({ kind: 'ok', text: v.direction === 'out' ? '自分の送信に直しました' : '受信に戻しました' });
      invalidate();
    },
    onError: (e) => setMsg({ kind: 'err', text: (e as Error).message }),
  });
  // 入力途中の返信本文・指示はこの端末に自動保存し、画面を離れても消えないようにする
  const textDraft = useDraft(id ? `conv:${id}:text` : null, text, setText);
  const instructionDraft = useDraft(id ? `conv:${id}:instruction` : null, instruction, setInstruction);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['conversation', id] });
    qc.invalidateQueries({ queryKey: ['conversations'] });
    qc.invalidateQueries({ queryKey: ['scheduling', id] });
  };

  const attAction = useMutation({
    mutationFn: (v: { id: number; action: 'save' | 'ignore' }) => api.post(`/attachments/${v.id}/${v.action}`),
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ['attachments'] });
    },
    onError: (e) => setMsg({ kind: 'err', text: (e as Error).message }),
  });

  const draft = useMutation({
    mutationFn: () => api.post<{ id: number; generatedText: string }>(`/conversations/${id}/draft`, { instruction, templateKey: templateKey || null }),
    onSuccess: (d) => {
      setText(d.generatedText);
      setDraftId(d.id);
      setMsg(null);
    },
    onError: (e) => setMsg({ kind: 'err', text: (e as Error).message }),
  });

  const send = useMutation({
    mutationFn: (scheduledAt?: string) =>
      api.post<{ note?: string; links: { name: string }[]; manualFiles: string[]; scheduled?: Scheduled }>(`/conversations/${id}/send`, {
        text,
        attachmentIds: selectedAtt,
        driveFiles: driveFiles.map((f) => ({ itemId: f.itemId, name: f.name, path: f.path })),
        draftId,
        createWaitingTask: createWaiting,
        waitingFollowUpAt: createWaiting ? waitUntil : null,
        replyToMessageId: replyTo?.id ?? null,
        quoteMessageId: quoteOf?.id ?? null,
        scheduledAt: scheduledAt ?? null,
      }),
    onSuccess: (r) => {
      setText('');
      textDraft.clear();
      setDraftId(null);
      setSelectedAtt([]);
      setDriveFiles([]);
      setCreateWaiting(false);
      setWaitUntil(null);
      setReplyTo(null);
      setQuoteOf(null);
      setShowTimer(false);
      setSendAt('');
      setSendPreset(null);
      if (r.scheduled) {
        setMsg({ kind: 'ok', text: `${fmtDateTime(r.scheduled.scheduledAt)} に送信するよう予約しました` });
      } else {
        const notes = [r.note, r.links.length ? `${r.links.length} 件を共有リンクで送付` : '', r.manualFiles.length ? `手動送付が必要: ${r.manualFiles.join('、')}` : ''].filter(Boolean);
        setMsg({ kind: 'ok', text: `送信しました${notes.length ? `（${notes.join(' / ')}）` : ''}` });
      }
      invalidate();
    },
    onError: (e) => setMsg({ kind: 'err', text: (e as Error).message }),
  });

  const judge = useMutation({
    mutationFn: () => api.post<{ expectsReply: boolean; suggestedTitle: string }>(`/conversations/${id}/judge-waiting`, { text }),
    onSuccess: (r) => {
      setCreateWaiting(r.expectsReply);
      setMsg({ kind: 'ok', text: r.expectsReply ? `返信待ちになりそうです: ${r.suggestedTitle}` : '返信待ちにはならなさそうです' });
    },
  });

  const link = useMutation({
    mutationFn: (clientId: number) => api.post(`/conversations/${id}/link`, { clientId }),
    onSuccess: () => {
      setMsg({ kind: 'ok', text: '依頼者に紐付けました' });
      invalidate();
      qc.invalidateQueries({ queryKey: ['alerts'] });
    },
  });
  const unlink = useMutation({
    mutationFn: () => api.post(`/conversations/${id}/unlink`),
    onSuccess: () => {
      setMsg({ kind: 'ok', text: '紐付けを外しました' });
      invalidate();
    },
    onError: (e) => setMsg({ kind: 'err', text: (e as Error).message }),
  });
  const [linkMode, setLinkMode] = useState<'client' | 'contact'>('client');

  const toggle = useMutation({
    mutationFn: (v: { needsReply?: boolean; archived?: boolean }) => (v.needsReply !== undefined ? api.post(`/conversations/${id}/needs-reply`, v) : api.post(`/conversations/${id}/archive`, v)),
    onSuccess: invalidate,
  });

  const c = conv.data;
  const storedAtts = useMemo(() => c?.messages.flatMap((m) => m.attachments.filter((a) => a.status === 'stored')) ?? [], [c]);
  // 開いた時点の未読数を覚えておく（サーバーは開いた瞬間に既読にするので、取り直すと 0 になる）
  const [unreadMark, setUnreadMark] = useState<{ id: number; count: number } | null>(null);
  useEffect(() => {
    if (c && unreadMark?.id !== c.id) {
      setUnreadMark({ id: c.id, count: c.unread ?? 0 });
      // 開いた時点でサーバー側は既読になる。会話を開くのは（操作ではなく）読み込みなので、
      // ここで件数を取り直さないと、メニューとアイコンの数字が未読のまま残る
      if ((c.unread ?? 0) > 0) qc.invalidateQueries({ queryKey: ['nav-counts'] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c?.id]);
  // 「ここから未読」を入れる位置 = 相手からの直近 N 件の先頭
  const firstUnreadId = useMemo(() => {
    if (!c || !unreadMark || unreadMark.id !== c.id || unreadMark.count <= 0) return null;
    const inbound = c.messages.filter((m) => m.direction === 'in');
    return inbound[Math.max(0, inbound.length - unreadMark.count)]?.id ?? null;
  }, [c, unreadMark]);
  // 履歴の長いルームでも、開いたら最新（未読があればその先頭）が見えるようにする
  const listRef = useRef<HTMLDivElement>(null);
  const unreadRef = useRef<HTMLDivElement>(null);
  const lastScrolledFor = useRef<number | null>(null);
  useEffect(() => {
    if (!c || !listRef.current || lastScrolledFor.current === c.id) return;
    lastScrolledFor.current = c.id;
    const el = listRef.current;
    requestAnimationFrame(() => {
      if (unreadRef.current) el.scrollTop = Math.max(0, unreadRef.current.offsetTop - el.offsetTop - 8);
      else el.scrollTop = el.scrollHeight;
    });
  }, [c]);
  const scrollToLatest = () => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  useEffect(() => {
    if (c && !c.clientId && c.suggestions[0]) setLinkClientId(String(c.suggestions[0].id));
  }, [c]);

  if (!c) return <div className="loading-text text-slate-500">読み込み中…</div>;

  // Chatwork のグループチャットは相手個人ではなくルーム（件名に保持）を会話名にする
  const name = c.contact?.name ?? c.client?.name ?? (c.channel === 'chatwork' && c.subject ? c.subject : null) ?? c.counterpartName ?? c.counterpartAddress ?? '（不明）';

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/inbox" className="text-sm text-slate-500 hover:underline">
            ← 受信箱
          </Link>
          <span className={channelBadge(c.channel)}>{channelLabel(c.channel)}</span>
          {c.lineGroup && (
            <span className="badge badge-gray" title="このやり取りは LINE のグループです。送信するとグループ全員に届きます">
              グループ
            </span>
          )}
          <h1 className="text-lg font-bold">{name}</h1>
          {c.contact && (
            <span className="badge badge-orange" title={c.contact.organization ?? undefined}>
              {c.contact.roleLabel}
            </span>
          )}
          {c.contact && c.client && (
            <span className="text-sm text-slate-600">
              依頼者{' '}
              <Link to={`/clients/${c.client.id}`} className="text-blue-700 hover:underline">
                {c.client.name}
              </Link>{' '}
              の{' '}
              <Link to={`/cases/${c.contact.caseId}`} className="text-blue-700 hover:underline">
                {c.contact.caseTitle}
              </Link>
            </span>
          )}
          {c.client && !c.contact && (
            <Link to={`/clients/${c.client.id}`} className="text-sm text-blue-700 hover:underline">
              依頼者ページ
            </Link>
          )}
          {(c.clientId || c.contactId) && (
            <button
              type="button"
              className="text-xs text-slate-400 hover:text-red-600 hover:underline"
              onClick={() => {
                if (confirm('この会話の依頼者・事件・関係者への紐付けを外します。依頼者や関係者の連絡先は変更しません。よろしいですか？')) unlink.mutate();
              }}
              disabled={unlink.isPending}
              title="間違って紐付けたときに外します"
            >
              紐付けを外す
            </button>
          )}
          {c.subject && !(c.channel === 'chatwork' && !c.client) && <span className="text-sm text-slate-500">件名: {c.subject}</span>}
          <div className="ml-auto flex gap-2">
            <button className="btn btn-sm" onClick={() => toggle.mutate({ needsReply: !c.needsReply })}>
              {c.needsReply ? '対応済みにする' : '要返信にする'}
            </button>
            <button className="btn btn-sm" onClick={() => toggle.mutate({ archived: !c.archived })}>
              {c.archived ? 'アーカイブ解除' : 'アーカイブ'}
            </button>
          </div>
        </div>

        {c.staff && !c.clientId && (
          <div className="card border-slate-200 bg-slate-50 text-sm text-slate-600">
            <span className="badge badge-gray mr-2">事務局</span>
            事務局メンバーからの伝言です。どの依頼者・事件の話かは、伝言ごとに「紐付け」で指定します（本文に依頼者名があれば自動で付きます）。「タスク化」でそのままタスクにできます。
          </div>
        )}
        {!c.clientId && !c.staff && (
          <div className="card border-orange-200 bg-orange-50">
            <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
              <span className="font-semibold text-orange-800">この連絡先はまだ紐付いていません</span>
              <label className="flex items-center gap-1">
                <input type="radio" name="linkMode" checked={linkMode === 'client'} onChange={() => setLinkMode('client')} /> 依頼者本人
              </label>
              <label className="flex items-center gap-1" title="相手方・相手方代理人・裁判所・保険会社など、依頼者以外の相手">
                <input type="radio" name="linkMode" checked={linkMode === 'contact'} onChange={() => setLinkMode('contact')} /> 事件の関係者（相手方・相手方代理人など）
              </label>
            </div>
            {linkMode === 'client' ? (
              <div className="flex flex-wrap items-center gap-2">
                <ClientPicker value={linkClientId} onChange={setLinkClientId} suggestions={c.suggestions} />
                <button className="btn btn-primary btn-sm" disabled={!linkClientId} onClick={() => link.mutate(Number(linkClientId))}>
                  紐付ける
                </button>
                <Link to={`/clients?new=${encodeURIComponent(c.counterpartName ?? '')}&email=${encodeURIComponent(c.channel === 'gmail' ? c.counterpartAddress ?? '' : '')}`} className="btn btn-sm">
                  新規依頼者として登録
                </Link>
              </div>
            ) : (
              <ContactLinkForm
                conversationId={c.id}
                defaultName={c.counterpartName ?? ''}
                onDone={() => {
                  setMsg({ kind: 'ok', text: '関係者として紐付けました' });
                  invalidate();
                  qc.invalidateQueries({ queryKey: ['alerts'] });
                }}
              />
            )}
          </div>
        )}

        <div ref={listRef} className="card relative max-h-[55vh] space-y-3 overflow-y-auto">
          {c.messages.length > 8 && (
            <div className="sticky top-0 z-10 flex justify-end">
              <button type="button" className="rounded-full border border-slate-300 bg-white/90 px-2 py-0.5 text-xs text-slate-600 shadow-sm hover:bg-slate-50" onClick={scrollToLatest} title="最新のメッセージへ">
                ↓ 最新
              </button>
            </div>
          )}
          {c.messages.map((m) => (
            <Fragment key={m.id}>
              {m.id === firstUnreadId && (
                <div ref={unreadRef} className="flex items-center gap-2 text-xs text-orange-600">
                  <span className="h-px flex-1 bg-orange-200" />
                  ここから未読
                  <span className="h-px flex-1 bg-orange-200" />
                </div>
              )}
            <div id={`msg-${m.id}`} className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${m.direction === 'out' ? 'bg-blue-600 text-white' : 'bg-slate-100'}`}>
                <div className={`mb-1 text-xs ${m.direction === 'out' ? 'text-blue-100' : 'text-slate-500'}`}>
                  {m.direction === 'out' ? '自分' : (m.senderName ?? name)} ・ {fmtDateTime(m.sentAt)}
                  {c.channel === 'chatwork' && m.direction === 'in' && (
                    <span className="ml-1 rounded bg-white/70 px-1 text-[10px] text-slate-500" title="取込範囲のどの条件で受信箱に入ったか">
                      取込理由: {SCOPE_REASON_LABEL[m.scopeReason ?? 'none'] ?? m.scopeReason}
                    </span>
                  )}
                  {(m.clientConfirms?.length ?? 0) > 0 && (
                    <Link
                      to={`/inbox/${m.clientConfirms!.at(-1)!.conversationId}`}
                      className="ml-1 rounded bg-green-100 px-1 text-[10px] text-green-800 hover:underline"
                      title="この質問から依頼者に送った確認を開きます"
                    >
                      ✓ 依頼者に確認済み（{m.clientConfirms!.at(-1)!.channel === 'gmail' ? 'Gmail' : 'LINE'}・{fmtDateTime(m.clientConfirms!.at(-1)!.at)}）
                    </Link>
                  )}
                </div>
                {m.replyTo && (
                  <button
                    type="button"
                    className={`mb-1 block max-w-full truncate rounded-md border-l-2 px-2 py-0.5 text-left text-xs ${m.direction === 'out' ? 'border-blue-200 bg-white/10 text-blue-100' : 'border-slate-300 bg-white/70 text-slate-500'}`}
                    title="返信先へ移動"
                    onClick={() => document.getElementById(`msg-${m.replyTo!.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                  >
                    ↩ {m.replyTo.direction === 'out' ? '自分' : (m.replyTo.senderName ?? name)}: {m.replyTo.excerpt}
                  </button>
                )}
                <MessageBody body={m.body} channel={c.channel} mine={m.direction === 'out'} />
                <div className={`mt-1 flex flex-wrap gap-2 text-[11px] ${m.direction === 'out' ? 'text-blue-100' : 'text-slate-500'}`}>
                  {c.channel === 'chatwork' && (
                    <button type="button" className="hover:underline" onClick={() => setReplyTo(m)} title="このメッセージへの返信として送ります（Chatwork の返信タグ付き）">
                      ↩ 返信
                    </button>
                  )}
                  {c.channel === 'chatwork' && m.direction === 'in' && (c.reactions?.length ?? 0) > 0 && (
                    <button
                      type="button"
                      className="hover:underline"
                      onClick={() => setReactFor(reactFor === m.id ? null : m.id)}
                      title="「了解しました」などの短い一言を、このメッセージへの返信としてワンタップで送ります"
                    >
                      😊 リアクション
                    </button>
                  )}
                  {c.channel === 'chatwork' && m.direction === 'in' && (
                    <button
                      type="button"
                      className="font-medium text-blue-700 hover:underline"
                      onClick={() => setConfirmFor(confirmFor === m.id ? null : m.id)}
                      title="この質問を、自分から依頼者に確認する文に書き直して、Gmail か LINE で依頼者に送ります"
                    >
                      📨 依頼者に確認
                    </button>
                  )}
                  <button type="button" className="hover:underline" onClick={() => setQuoteOf(m)} title={c.channel === 'chatwork' ? 'Chatwork の引用として本文に付けます' : '「> 」付きの引用文として本文に付けます'}>
                    ❝ 引用
                  </button>
                  <button
                    type="button"
                    className="hover:underline"
                    onClick={() => fixDirection.mutate({ id: m.id, direction: m.direction === 'out' ? 'in' : 'out' })}
                    disabled={fixDirection.isPending}
                    title={m.direction === 'out' ? 'これは相手からの受信だった、というときに戻します' : '自分が別の方法（Gmail や LINE アプリなど）で送ったものが受信として入ったときに直します'}
                  >
                    {m.direction === 'out' ? '↩ 受信に戻す' : '✓ 自分の送信に直す'}
                  </button>
                </div>
                {reactFor === m.id && c.reactions && (
                  <ReactionBar
                    conversationId={c.id}
                    messageId={m.id}
                    reactions={c.reactions}
                    onSent={() => {
                      setReactFor(null);
                      invalidate();
                    }}
                  />
                )}
                {c.cases.length >= 2 && !c.contact && <CaseTag m={m} cases={c.cases} out={m.direction === 'out'} onChanged={invalidate} />}
                {c.channel === 'chatwork' && m.direction === 'in' && <MessageTools m={m} onChanged={invalidate} />}
                {m.attachments.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {m.attachments.map((a) => (
                      <li key={a.id} className="text-xs">
                        📎{' '}
                        {a.status !== 'ignored' ? (
                          <a className="underline" href={`/api/attachments/${a.id}/download`}>
                            {a.filename}
                          </a>
                        ) : (
                          <span className="line-through">{a.filename}</span>
                        )}{' '}
                        <span className={m.direction === 'out' ? 'text-blue-100' : 'text-slate-500'}>
                          {fmtBytes(a.size)} {a.status === 'unassigned' ? '（未振分）' : a.status === 'failed' ? '（取得失敗）' : a.status === 'pending' ? '（保存中）' : a.status === 'held' ? '（未保存）' : a.status === 'ignored' ? '（不要）' : '（保存済）'}
                        </span>
                        {(a.status === 'held' || a.status === 'failed') && m.direction === 'in' && (
                          <span className="ml-1 inline-flex gap-1">
                            <button type="button" className="rounded border border-slate-300 bg-white px-1.5 text-slate-700 hover:bg-slate-50" onClick={() => attAction.mutate({ id: a.id, action: 'save' })} disabled={attAction.isPending}>
                              {c.client ? 'フォルダに保存' : '保存'}
                            </button>
                            <button type="button" className="rounded border border-slate-300 bg-white px-1.5 text-slate-500 hover:bg-slate-50" onClick={() => attAction.mutate({ id: a.id, action: 'ignore' })} disabled={attAction.isPending}>
                              不要
                            </button>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            {confirmFor === m.id && (
              <ClientConfirmPanel
                messageId={m.id}
                onClose={() => setConfirmFor(null)}
                onSent={invalidate}
              />
            )}
            </Fragment>
          ))}
          {c.messages.length === 0 && <div className="text-sm text-slate-500">メッセージはありません</div>}
        </div>

        {c.scheduled.length > 0 && <ScheduledList items={c.scheduled} onChanged={invalidate} />}

        <div className="card space-y-3">
          {(replyTo || quoteOf) && (
            <div className="fade-in space-y-1 text-xs">
              {replyTo && (
                <div className="flex items-center gap-2 rounded-[8px] border-l-2 border-[var(--accent)] bg-[var(--accent-soft)] px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 truncate">
                    ↩ <b>{replyTo.direction === 'out' ? '自分' : (replyTo.senderName ?? name)}</b> への返信: {replyTo.body.replace(/\s+/g, ' ').slice(0, 80)}
                  </span>
                  <button type="button" className="text-slate-500 hover:text-red-600" onClick={() => setReplyTo(null)} aria-label="返信をやめる">
                    ×
                  </button>
                </div>
              )}
              {quoteOf && (
                <div className="flex items-center gap-2 rounded-[8px] border-l-2 border-slate-300 bg-black/[0.03] px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 truncate">
                    ❝ <b>{quoteOf.direction === 'out' ? '自分' : (quoteOf.senderName ?? name)}</b> を引用: {quoteOf.body.replace(/\s+/g, ' ').slice(0, 80)}
                  </span>
                  <button type="button" className="text-slate-500 hover:text-red-600" onClick={() => setQuoteOf(null)} aria-label="引用をやめる">
                    ×
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input className="input flex-1" placeholder="AI への指示（例: 来週火曜14時で確定と返す／資料の受領を伝えて次回期日を案内）" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
            <DraftHint handle={instructionDraft} className="w-full" />
            <select className="input w-auto" value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
              <option value="">テンプレートなし</option>
              {templates.data?.map((t) => (
                <option key={t.key} value={t.key} title={t.when}>
                  {t.label}
                </option>
              ))}
            </select>
            <button className="btn btn-primary" onClick={() => draft.mutate()} disabled={draft.isPending}>
              {draft.isPending ? '生成中…' : '自分らしい下書きを作成'}
            </button>
          </div>
          {c.channel === 'line' && (
            <div className="text-xs text-slate-500">
              送り先: {c.lineGroup ? 'この LINE グループ（参加者全員に届きます）' : `${name}（1 対 1 のトーク。グループには届きません）`}
            </div>
          )}
          {c.lineBlocked && (
            <div className="rounded-md bg-orange-50 px-3 py-2 text-sm text-orange-800">
              この相手は LINE公式アカウントをブロック（または友だち解除・退会）しています。LINE で送っても届きません。Gmail や電話など別の方法で連絡してください。
            </div>
          )}
          <textarea className="input min-h-40 font-mono text-sm" value={text} onChange={(e) => setText(e.target.value)} placeholder="返信本文（AI 下書きを編集して送信）" />
          <DraftHint handle={textDraft} />
          {(selectedAtt.length > 0 || driveFiles.length > 0) && (
            <div className="flex flex-wrap gap-1 text-xs">
              {selectedAtt.map((aid) => {
                const a = storedAtts.find((x) => x.id === aid);
                return (
                  <span key={aid} className="badge badge-gray">
                    📎 {a?.filename}{' '}
                    <button className="ml-1" onClick={() => setSelectedAtt(selectedAtt.filter((x) => x !== aid))}>
                      ×
                    </button>
                  </span>
                );
              })}
              {driveFiles.map((f) => (
                <span key={f.path} className="badge badge-gray">
                  📄 {f.name}{' '}
                  <button className="ml-1" onClick={() => setDriveFiles(driveFiles.filter((x) => x.path !== f.path))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {c.channel === 'line' && (selectedAtt.length > 0 || driveFiles.length > 0) && <div className="text-xs text-orange-700">LINE はファイルを直接送れないため、OneDrive の共有リンクとして送ります（発行できない場合は手動送付の案内文になります）。</div>}
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-sm" onClick={() => setShowFiles(!showFiles)} disabled={!c.client}>
              📄 フォルダのファイルを添付
            </button>
            <button className="btn btn-sm" onClick={() => setShowSchedule(!showSchedule)}>
              📅 日程調整
            </button>
            <button className="btn btn-sm" onClick={() => setShowExtract(!showExtract)} title="やり取りから日時を読み取ってカレンダーに登録します">
              🗓 会話から予定を登録
            </button>
            <button className="btn btn-sm" onClick={() => setShowStaffAsk(!showStaffAsk)} title="届いた連絡を引用して、Chatwork で担当事務局に確認します">
              💬 事務局に確認
            </button>
            <button className="btn btn-sm" onClick={() => judge.mutate()} disabled={!text || judge.isPending}>
              返信待ちになる？
            </button>
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={createWaiting} onChange={(e) => setCreateWaiting(e.target.checked)} /> 送信後「返信待ち」タスクを作る
            </label>
            {createWaiting && <WaitDeadlineSelect value={waitUntil} onChange={setWaitUntil} />}
            <div className="ml-auto flex items-center gap-1">
              <button className="btn btn-primary" onClick={() => send.mutate(undefined)} disabled={!text.trim() || send.isPending}>
                {send.isPending ? '送信中…' : c.lineGroup ? 'LINE グループに送信' : `${channelLabel(c.channel)} で送信`}
              </button>
              <button className={`btn ${showTimer ? 'text-[var(--accent)]' : ''}`} onClick={() => setShowTimer(!showTimer)} disabled={send.isPending} title="時刻を指定して、その時刻に自動で送ります" aria-expanded={showTimer}>
                <Icon name="clock" className="h-4 w-4" />
                時刻を指定
              </button>
            </div>
          </div>
          {showTimer && (
            <div className="fade-in flex flex-wrap items-center gap-2 rounded-[10px] bg-black/[0.03] px-3 py-2 text-sm">
              <span className="text-xs text-slate-500">送信する時刻:</span>
              {quickSendTimes().map((q) => (
                <button
                  key={q.key}
                  className={`btn btn-sm ${sendPreset === q.key ? 'btn-primary' : ''}`}
                  onClick={() => {
                    // 押した時点の値を使う（「1 時間後」なら今から 1 時間後）
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
              />
              <button className="btn btn-primary" onClick={() => send.mutate(fromLocalInput(sendAt))} disabled={!text.trim() || !sendAt || send.isPending}>
                {sendAt ? `${fmtDateTime(fromLocalInput(sendAt))} に送信予約` : '時刻を選んでください'}
              </button>
              <span className="text-xs text-slate-400">予約後も、この画面の「送信予約」から取消・時刻変更・今すぐ送信ができます</span>
            </div>
          )}
          {msg && <div className={`fade-in text-sm ${msg.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}>{msg.text}</div>}
          {showFiles && c.client && <FilePicker clientId={c.client.id} selectedPaths={driveFiles.map((f) => f.path)} onToggle={(f) => setDriveFiles(driveFiles.some((x) => x.path === f.path) ? driveFiles.filter((x) => x.path !== f.path) : [...driveFiles, f])} />}
          {storedAtts.length > 0 && showFiles && (
            <div className="text-xs">
              <div className="label">受領済みの添付を送り返す</div>
              <div className="flex flex-wrap gap-1">
                {storedAtts.map((a) => (
                  <label key={a.id} className="badge badge-gray cursor-pointer">
                    <input type="checkbox" className="mr-1" checked={selectedAtt.includes(a.id)} onChange={(e) => setSelectedAtt(e.target.checked ? [...selectedAtt, a.id] : selectedAtt.filter((x) => x !== a.id))} />
                    {a.filename}
                  </label>
                ))}
              </div>
            </div>
          )}
          {showStaffAsk && <StaffAskPanel base={`/conversations/${c.id}`} draftKey={`conv:${c.id}`} onClose={() => setShowStaffAsk(false)} onSent={invalidate} />}
          {showSchedule && <SchedulePanel conversationId={c.id} onText={(t) => setText((prev) => (prev ? `${prev}\n\n${t}` : t))} onDone={invalidate} />}
          {showExtract && (
            <ExtractSchedulePanel conversationId={c.id} cases={c.cases} onText={(t) => setText((prev) => (prev ? `${prev}\n\n${t}` : t))} onDone={invalidate} />
          )}
        </div>
      </div>

      <aside className="space-y-4">
        {sessions.data && sessions.data.filter((s) => s.state !== 'cancelled').length > 0 && (
          <div className="card">
            <h3 className="mb-2 text-sm font-semibold">日程調整</h3>
            {sessions.data
              .filter((s) => s.state !== 'cancelled')
              .map((s) => (
                <SessionCard key={s.id} s={s} spotlight={s.id === spotlightSession} onText={(t) => setText((prev) => (prev ? `${prev}\n\n${t}` : t))} onDone={invalidate} />
              ))}
          </div>
        )}
        {c.cases.length > 0 && (
          <div className="card">
            <h3 className="mb-2 text-sm font-semibold">事件</h3>
            <ul className="space-y-1 text-sm">
              {c.cases.map((k) => (
                <li key={k.id}>
                  <Link to={`/cases/${k.id}`} className="text-blue-700 hover:underline">
                    {k.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        {c.drafts.length > 0 && (
          <div className="card">
            <h3 className="mb-2 text-sm font-semibold">最近の下書き</h3>
            <ul className="space-y-2 text-xs">
              {c.drafts.map((d) => (
                <li key={d.id} className="rounded border border-slate-100 p-2">
                  <div className="mb-1 flex items-center justify-between text-slate-500">
                    <span>{fmtDateTime(d.createdAt)}</span>
                    <span className="badge badge-gray">{d.status === 'sent' ? '送信済' : '下書き'}</span>
                  </div>
                  <div className="line-clamp-3 whitespace-pre-wrap">{d.generatedText}</div>
                  <button
                    className="btn btn-sm mt-1"
                    onClick={() => {
                      setText(d.generatedText);
                      setDraftId(d.id);
                    }}
                  >
                    この下書きを使う
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <TaskMini conversationId={c.id} clientId={c.clientId} />
      </aside>
    </div>
  );
}

/** この会話の送信予約（取消・時刻変更・今すぐ送る） */
function ScheduledList({ items, onChanged }: { items: Scheduled[]; onChanged: () => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<number | null>(null);
  const [editAt, setEditAt] = useState('');
  const [err, setErr] = useState('');
  const done = () => {
    setErr('');
    setEditing(null);
    onChanged();
    qc.invalidateQueries({ queryKey: ['scheduled-messages'] });
  };
  const fail = (e: unknown) => setErr((e as Error).message);
  const cancel = useMutation({ mutationFn: (id: number) => api.del(`/scheduled-messages/${id}`), onSuccess: done, onError: fail });
  const sendNow = useMutation({ mutationFn: (id: number) => api.post(`/scheduled-messages/${id}/send-now`, {}), onSuccess: done, onError: fail });
  const retime = useMutation({ mutationFn: (id: number) => api.put(`/scheduled-messages/${id}`, { scheduledAt: fromLocalInput(editAt) }), onSuccess: done, onError: fail });
  const busy = cancel.isPending || sendNow.isPending || retime.isPending;
  return (
    <div className="card space-y-2">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <Icon name="clock" className="h-4 w-4 text-[var(--accent)]" />
        送信予約
      </h3>
      <ul className="divide-y divide-slate-100">
        {items.map((s) => (
          <li key={s.id} className="space-y-1 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`badge ${s.status === 'failed' ? 'badge-orange' : 'badge-blue'}`}>{s.status === 'failed' ? '失敗' : s.status === 'sending' ? '送信中' : '予約中'}</span>
              <span className="font-medium tabular-nums">{fmtDateTime(s.scheduledAt)}</span>
              <span className="text-xs text-slate-500">に送信</span>
              <div className="ml-auto flex flex-wrap gap-1">
                <button className="btn btn-sm" onClick={() => sendNow.mutate(s.id)} disabled={busy} title="予約を待たずに今すぐ送ります">
                  今すぐ送る
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setEditing(editing === s.id ? null : s.id);
                    setEditAt(toLocalInput(s.scheduledAt));
                  }}
                  disabled={busy}
                >
                  時刻変更
                </button>
                <button className="btn btn-sm text-red-600" onClick={() => confirm('この送信予約を取り消しますか？') && cancel.mutate(s.id)} disabled={busy}>
                  取消
                </button>
              </div>
            </div>
            <div className="whitespace-pre-wrap rounded-[8px] bg-black/[0.03] px-2.5 py-1.5 text-xs text-slate-600">{s.text.length > 200 ? `${s.text.slice(0, 200)}…` : s.text}</div>
            {s.error && <div className="text-xs text-red-600">{s.error}</div>}
            {editing === s.id && (
              <div className="fade-in flex flex-wrap items-center gap-2">
                {/* 送信予約のときと同じ「よく使う時刻」（1 時間後など）。押すと下の欄に入る */}
                {quickSendTimes().map((q) => (
                  <button key={q.key} className="btn btn-sm" onClick={() => setEditAt(q.value)}>
                    {q.label}
                  </button>
                ))}
                <input type="datetime-local" className="input w-auto" value={editAt} onChange={(e) => setEditAt(e.target.value)} />
                <button className="btn btn-primary btn-sm" onClick={() => retime.mutate(s.id)} disabled={!editAt || busy}>
                  この時刻に変更
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {err && <div className="fade-in text-xs text-red-600">{err}</div>}
    </div>
  );
}

function FilePicker({ clientId, selectedPaths, onToggle }: { clientId: number; selectedPaths: string[]; onToggle: (f: DriveFile) => void }) {
  const docs = useQuery({ queryKey: ['court-docs', clientId], queryFn: () => api.get<DriveFile[]>(`/court/docs/${clientId}`) });
  if (docs.isLoading) return <div className="text-xs text-slate-500">フォルダを読み込み中…</div>;
  if (docs.error) return <div className="text-xs text-red-600">{(docs.error as Error).message}</div>;
  return (
    <div className="max-h-48 overflow-y-auto rounded border border-slate-200 p-2 text-xs">
      <div className="label">依頼者フォルダのファイル（提出書面・直下）</div>
      {docs.data?.length === 0 && <div className="text-slate-500">ファイルがありません</div>}
      {docs.data?.map((f) => (
        <label key={f.path} className="flex cursor-pointer items-center gap-2 py-0.5 hover:bg-slate-50">
          <input type="checkbox" checked={selectedPaths.includes(f.path)} onChange={() => onToggle(f)} />
          <span className="truncate">{f.name}</span>
          <span className="ml-auto shrink-0 text-slate-400">
            {fmtBytes(f.size)} {f.modifiedAt ? fmtDateTime(f.modifiedAt) : ''}
          </span>
        </label>
      ))}
    </div>
  );
}

interface Prefs {
  found: boolean;
  earliest: string | null;
  latest: string | null;
  weekdays: number[];
  timeRanges: { from: string; to: string }[];
  avoid: { from: string; to: string; quote?: string }[];
  requested: { startAt: string; quote?: string }[];
  web: boolean | null;
  durationMinutes: number | null;
  note: string;
  summary: string;
}
const WD_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** "13:00-17:00, 10:00〜12:00" → [{from,to}] */
function parseTimeRanges(text: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  const norm = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[：]/g, ':');
  for (const m of norm.matchAll(/(\d{1,2}):(\d{2})\s*[-〜~～]\s*(\d{1,2}):(\d{2})/g)) {
    out.push({ from: `${m[1].padStart(2, '0')}:${m[2]}`, to: `${m[3].padStart(2, '0')}:${m[4]}` });
  }
  return out;
}

/**
 * リアクション（ワンタップ返信）。
 * Chatwork のリアクションそのものは公開 API に無いので、そのメッセージへの短い返信として送る。
 */
function ReactionBar({
  conversationId,
  messageId,
  reactions,
  onSent,
}: {
  conversationId: number;
  messageId: number;
  reactions: { label: string; text: string; emoji: string }[];
  onSent: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: (text: string) => api.post(`/conversations/${conversationId}/messages/${messageId}/reaction`, { text }),
    onSuccess: onSent,
    onError: (e) => setErr((e as Error).message),
  });
  return (
    <div className="fade-in mt-1">
      <div className="flex flex-wrap gap-1">
        {reactions.map((r) => (
          <button
            key={r.text}
            type="button"
            className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            disabled={send.isPending}
            title={`「${r.text}」と返信します`}
            onClick={() => {
              setErr(null);
              send.mutate(r.text);
            }}
          >
            {r.emoji} {r.label}
          </button>
        ))}
      </div>
      {err && <div className="mt-0.5 text-xs text-red-600">{err}</div>}
    </div>
  );
}

function SchedulePanel({ conversationId, onText, onDone }: { conversationId: number; onText: (t: string) => void; onDone: () => void }) {
  const [kind, setKind] = useState<string>('面談');
  const [from, setFrom] = useState(todayLocalInput(9).slice(0, 10));
  const [to, setTo] = useState(new Date(Date.now() + 14 * 86400_000 + 9 * 3600_000).toISOString().slice(0, 10));
  const [duration, setDuration] = useState(60);
  const [max, setMax] = useState(3);
  const [travel, setTravel] = useState('');
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [timeRanges, setTimeRanges] = useState('');
  const [avoid, setAvoid] = useState<Prefs['avoid']>([]);
  const [requested, setRequested] = useState<Prefs['requested']>([]);
  const [prefNote, setPrefNote] = useState('');
  const [location, setLocation] = useState('');
  const [err, setErr] = useState('');
  const readPrefs = useMutation({
    mutationFn: () => api.post<Prefs>(`/conversations/${conversationId}/schedule/preferences`),
    onSuccess: (r) => {
      setErr('');
      if (!r.found) {
        setPrefNote('相手の希望は読み取れませんでした（条件は手で指定できます）');
        return;
      }
      if (r.earliest) setFrom(r.earliest);
      if (r.latest) setTo(r.latest);
      setWeekdays(r.weekdays);
      setTimeRanges(r.timeRanges.map((t) => `${t.from}-${t.to}`).join(', '));
      setAvoid(r.avoid);
      setRequested(r.requested);
      if (r.durationMinutes) setDuration(r.durationMinutes);
      if (r.web === true) setKind('WEB');
      setPrefNote(`${r.note}${r.summary ? `（${r.summary}）` : ''}`);
    },
    onError: (e) => setErr((e as Error).message),
  });
  const propose = useMutation({
    mutationFn: () =>
      api.post<{ text: string; session: Session; slots: { startAt: string; requested?: boolean }[] }>('/scheduling/propose', {
        conversationId,
        kind,
        from: `${from}T00:00:00+09:00`,
        to: `${to}T23:59:59+09:00`,
        durationMinutes: duration,
        maxCandidates: max,
        preferences: { weekdays, timeRanges: parseTimeRanges(timeRanges), avoid, requested },
        location: location.trim() || null,
        ...(travel.trim() ? { travelBufferMinutes: Math.max(0, Math.min(240, Number(travel))) } : {}),
      }),
    onSuccess: (r) => {
      onText(`ご都合はいかがでしょうか。\n${r.text}`);
      onDone();
      setErr('');
    },
    onError: (e) => setErr((e as Error).message),
  });
  const toggleWd = (w: number) => setWeekdays((prev) => (prev.includes(w) ? prev.filter((x) => x !== w) : [...prev, w].sort()));
  return (
    <div className="rounded border border-slate-200 p-3 text-sm">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-semibold">候補日を提案して仮押さえ</span>
        <button type="button" className="btn btn-sm" onClick={() => readPrefs.mutate()} disabled={readPrefs.isPending} title="このやり取りから、相手が述べた期間・曜日・時間帯・都合の悪い日・希望日時を読み取って下の条件に入れます">
          {readPrefs.isPending ? '読み取り中…' : '相手の希望を読み取る（AI）'}
        </button>
        {prefNote && <span className="text-xs text-slate-600">{prefNote}</span>}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="label">種別</label>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            {SCHEDULING_KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">期間（開始）</label>
          <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label">期間（終了）</label>
          <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div>
          <label className="label">所要（分）</label>
          <input type="number" className="input w-20" value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
        </div>
        <div>
          <label className="label">候補数</label>
          <input type="number" className="input w-16" value={max} onChange={(e) => setMax(Number(e.target.value))} />
        </div>
        <div>
          <label className="label">移動時間（分）</label>
          <input type="number" className="input w-20" placeholder="設定値" value={travel} onChange={(e) => setTravel(e.target.value)} title="外出予定（裁判所など）の前後に空ける時間。空欄なら設定の値" />
        </div>
        <div className="min-w-0 flex-1">
          <label className="label">場所</label>
          <input className="input w-full min-w-40" value={location} onChange={(e) => setLocation(e.target.value)} placeholder={kind === 'WEB' ? '空欄なら会議 URL だけ' : '空欄なら事務所'} maxLength={200} title="仮押さえの予定と、確定した予定の場所に入ります。候補の文にも「場所: …」を添えます" />
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <div>
          <label className="label">曜日（指定なしなら平日すべて）</label>
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map((w) => (
              <label key={w} className="flex items-center gap-1">
                <input type="checkbox" checked={weekdays.includes(w)} onChange={() => toggleWd(w)} /> {WD_JA[w]}
              </label>
            ))}
          </div>
        </div>
        <div>
          <label className="label">時間帯（例: 13:00-17:00, 10:00-12:00）</label>
          <input className="input w-64" placeholder="空欄なら営業時間すべて" value={timeRanges} onChange={(e) => setTimeRanges(e.target.value)} />
        </div>
      </div>
      {(requested.length > 0 || avoid.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {requested.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-slate-500">相手の希望日時（空いていれば最優先）:</span>
              {requested.map((r, i) => (
                <span key={i} className="badge badge-blue" title={r.quote}>
                  {fmtDateTime(r.startAt)}
                  <button type="button" className="ml-1 text-slate-500 hover:text-red-600" onClick={() => setRequested(requested.filter((_, j) => j !== i))} aria-label="外す">
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {avoid.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-slate-500">相手の都合が悪い日時:</span>
              {avoid.map((a, i) => (
                <span key={i} className="badge badge-orange" title={a.quote}>
                  {fmtDateTime(a.from)}〜{fmtDateTime(a.to)}
                  <button type="button" className="ml-1 text-slate-500 hover:text-red-600" onClick={() => setAvoid(avoid.filter((_, j) => j !== i))} aria-label="外す">
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="mt-2">
        <button className="btn btn-primary" onClick={() => propose.mutate()} disabled={propose.isPending}>
          {propose.isPending ? '確認中…' : '空きを探して仮押さえ'}
        </button>
      </div>
      {err && <div className="fade-in mt-2 text-red-600">{err}</div>}
      <div className="mt-2 text-xs text-slate-500">
        Google カレンダーの空きから候補を出し、「{'{姓} {内容} 仮'}」として仮押さえします。外出予定の前後は移動時間を、予定同士の間は設定の間隔を空けます。候補文は返信欄に追加されます。
      </div>
    </div>
  );
}

function SessionCard({ s, onText, onDone, spotlight }: { s: Session; onText: (t: string) => void; onDone: () => void; spotlight?: boolean }) {
  const [chosen, setChosen] = useState(s.candidates[0]?.startAt ?? '');
  const [custom, setCustom] = useState('');
  const [zoom, setZoom] = useState(s.kind === 'WEB');
  const [err, setErr] = useState('');
  const confirm = useMutation({
    mutationFn: () => api.post<{ text: string }>('/scheduling/confirm', { sessionId: s.id, startAt: custom ? fromLocalInput(custom) : chosen, durationMinutes: 60, createZoom: zoom }),
    onSuccess: (r) => {
      onText(`では、${r.text}\nでお願いいたします。`);
      onDone();
    },
    onError: (e) => setErr((e as Error).message),
  });
  const cancel = useMutation({ mutationFn: () => api.post(`/scheduling/${s.id}/cancel`), onSuccess: onDone });
  return (
    <div id={`session-${s.id}`} className={`mb-2 rounded border border-slate-200 p-2 text-xs ${spotlight ? 'spotlight' : ''}`}>
      <div className="flex items-center justify-between">
        <span className="font-semibold">
          {s.kind} <span className="badge badge-gray">{s.state === 'proposing' ? '調整中' : s.state === 'confirmed' ? '確定' : s.state}</span>
        </span>
        {s.state === 'proposing' && (
          <button className="text-slate-500 hover:underline" onClick={() => cancel.mutate()}>
            取消
          </button>
        )}
      </div>
      {s.state === 'proposing' && (
        <div className="mt-1 space-y-1">
          {s.candidates.map((c) => (
            <label key={c.startAt} className="flex items-center gap-1">
              <input type="radio" checked={!custom && chosen === c.startAt} onChange={() => setChosen(c.startAt)} /> {fmtDateTime(c.startAt)}
            </label>
          ))}
          <div className="flex items-center gap-1">
            <span>別日時:</span>
            <input type="datetime-local" className="input" value={custom} onChange={(e) => setCustom(e.target.value)} />
          </div>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={zoom} onChange={(e) => setZoom(e.target.checked)} /> Zoom を発行
          </label>
          <button className="btn btn-primary btn-sm" onClick={() => confirm.mutate()} disabled={confirm.isPending}>
            確定（他の仮押さえを削除）
          </button>
          {err && <div className="fade-in text-red-600">{err}</div>}
        </div>
      )}
      {s.state === 'confirmed' && (
        <div className="mt-1">
          {fmtDateTime(s.confirmedStartAt)}
          {s.zoom && (
            <div className="mt-1 break-all text-slate-600">
              Zoom: {s.zoom.joinUrl}
              <br />
              パスコード: {s.zoom.password}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskMini({ conversationId, clientId }: { conversationId: number; clientId: number | null }) {
  const qc = useQueryClient();
  const tasks = useQuery({ queryKey: ['tasks', 'conv', conversationId], queryFn: () => api.get<{ id: number; title: string; status: string; followUpAt: string | null; dueAt: string | null }[]>(`/tasks?conversationId=${conversationId}&status=active`) });
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('waiting_client');
  const [newDeadline, setNewDeadline] = useState<string | null>(null);
  const waiting = status !== 'open';
  const add = useMutation({
    mutationFn: () => api.post('/tasks', { title, status, conversationId, clientId, followUpAt: waiting ? newDeadline : null, dueAt: waiting ? null : newDeadline }),
    onSuccess: () => {
      setTitle('');
      setNewDeadline(null);
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
  const done = useMutation({ mutationFn: (id: number) => api.put(`/tasks/${id}`, { status: 'done' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }) });
  const setDeadline = useMutation({ mutationFn: (v: { id: number; followUpAt: string }) => api.put(`/tasks/${v.id}`, { followUpAt: v.followUpAt }), onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }) });
  const setDue = useMutation({ mutationFn: (v: { id: number; dueAt: string }) => api.put(`/tasks/${v.id}`, { dueAt: v.dueAt }), onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }) });
  return (
    <div className="card">
      <h3 className="mb-2 text-sm font-semibold">この会話のタスク</h3>
      <ul className="mb-2 space-y-1 text-xs">
        {tasks.data?.map((t) => (
          <li key={t.id} className="space-y-0.5">
            <div className="flex items-center gap-2">
              <button className="text-slate-400 hover:text-green-600" title="完了" onClick={() => done.mutate(t.id)}>
                ☐
              </button>
              <span className="flex-1">{t.title}</span>
              <span className="badge badge-gray">{t.status === 'open' ? '対応中' : t.status === 'waiting_client' ? '依頼者待ち' : '相手方待ち'}</span>
            </div>
            <div className="pl-5">
              {t.status === 'open' ? (
                <DeadlineEditor compact label="期日:" value={t.dueAt ?? t.followUpAt} onChange={(iso) => setDue.mutate({ id: t.id, dueAt: iso })} />
              ) : (
                <DeadlineEditor compact label="いつまで待つ:" value={t.followUpAt} onChange={(iso) => setDeadline.mutate({ id: t.id, followUpAt: iso })} />
              )}
            </div>
          </li>
        ))}
        {tasks.data?.length === 0 && <li className="text-slate-500">なし</li>}
      </ul>
      <div className="flex flex-wrap items-center gap-1">
        <input className="input min-w-0 flex-1" placeholder="タスクを追加" value={title} onChange={(e) => setTitle(e.target.value)} />
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">対応中</option>
          <option value="waiting_client">依頼者待ち</option>
          <option value="waiting_other">相手方待ち</option>
        </select>
        <TaskDeadlineSelect value={newDeadline} onChange={setNewDeadline} label={waiting ? '期限' : '期日'} defaultLabel={waiting ? '既定' : 'なし'} />
        <button className="btn btn-sm" onClick={() => add.mutate()} disabled={!title}>
          追加
        </button>
      </div>
    </div>
  );
}


/**
 * メールの本文。返信に付いてくる過去のやり取りの引用は、既定で折りたたむ。
 * 引用が見つからないときは、そのまま全部出す。
 */
function MessageBody({ body, channel, mine }: { body: string; channel: string; mine: boolean }) {
  const [open, setOpen] = useState(false);
  // 引用が付いてくるのはメールだけ。LINE・Chatwork は本文をそのまま出す
  const { main, quoted } = useMemo(() => (channel === 'gmail' ? splitQuotedReply(body) : { main: body, quoted: '' }), [body, channel]);
  if (!quoted) return <div className="whitespace-pre-wrap break-words">{body}</div>;
  const quotedLines = quoted.split('\n').filter((l) => l.trim()).length;
  return (
    <div>
      <div className="whitespace-pre-wrap break-words">{main}</div>
      <button
        type="button"
        className={`mt-1 rounded-full px-2 py-0.5 text-[11px] ${mine ? 'bg-white/15 text-blue-100 hover:bg-white/25' : 'bg-slate-200/70 text-slate-600 hover:bg-slate-300/70'}`}
        onClick={() => setOpen(!open)}
        title={open ? '引用を隠します' : 'この返信に付いてきた、過去のやり取りを出します'}
      >
        {open ? '▾ 引用を隠す' : `▸ 引用された過去のやり取り（${quotedLines} 行）`}
      </button>
      {open && (
        <div className={`mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words border-l-2 pl-2 text-xs ${mine ? 'border-blue-300 text-blue-100' : 'border-slate-300 text-slate-500'}`}>{quoted}</div>
      )}
    </div>
  );
}

interface Extracted {
  status: 'confirmed' | 'candidates' | 'none';
  content: string;
  kind: 'meeting' | 'consult' | 'hearing';
  web: boolean;
  durationMinutes: number;
  location: string | null;
  slots: { startAt: string; endAt: string; timeKnown: boolean; quote: string; by: 'counterpart' | 'me' }[];
  note: string;
  clientId: number | null;
  clientName: string | null;
  counterpartName: string;
  title: string;
  /** いま使える WEB 会議の提供元 */
  webProvider: 'zoom' | 'meet' | 'none';
  /** 日程変更の元になりうる、この相手の予定 */
  existingEvents?: { id: number; title: string; startAt: string; endAt: string; kind: string; location: string | null }[];
  /** やり取りから日程変更と読み取ったとき（eventId は変更前の予定。分からなければ null） */
  reschedule?: { eventId: number | null; quote: string } | null;
}

interface Replaced {
  id: number;
  title: string;
  startAt: string;
  endAt: string;
}

const WEB_PROVIDER_LABEL: Record<'zoom' | 'meet' | 'none', string> = { zoom: 'Zoom', meet: 'Google Meet', none: '（未設定）' };

/** 会話のやり取りから日程を読み取り、確認してカレンダーに登録 */
function ExtractSchedulePanel({ conversationId, cases, onText, onDone }: { conversationId: number; cases: { id: number; title: string }[]; onText: (t: string) => void; onDone: () => void }) {
  const [res, setRes] = useState<Extracted | null>(null);
  const [mode, setMode] = useState<'confirmed' | 'holds'>('confirmed');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<EventKind>('meeting');
  const [duration, setDuration] = useState(60);
  const [location, setLocation] = useState('');
  const [caseId, setCaseId] = useState('');
  const [slots, setSlots] = useState<{ start: string; quote?: string; timeKnown?: boolean }[]>([]);
  const [web, setWeb] = useState(false);
  const [webText, setWebText] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');
  // 日程変更（リスケ）のとき、取り消す元の予定。'' は「新しく入れるだけ」
  const [replaceId, setReplaceId] = useState('');
  const extract = useMutation({
    mutationFn: () => api.post<Extracted>(`/conversations/${conversationId}/schedule/extract`),
    onSuccess: (r) => {
      setRes(r);
      setErr('');
      setDone('');
      setMode(r.status === 'confirmed' || r.slots.length <= 1 ? 'confirmed' : 'holds');
      setTitle(r.title);
      setKind(r.kind);
      setDuration(r.durationMinutes);
      setWeb(r.web);
      setWebText('');
      setLocation(r.web ? (r.location ?? '') : (r.location ?? ''));
      setCaseId(cases[0] ? String(cases[0].id) : '');
      setSlots(r.slots.map((s) => ({ start: toLocalInput(s.startAt), quote: s.quote, timeKnown: s.timeKnown })));
      // 日程変更と読み取れたら、元の予定を取り消す設定にしておく（画面で外せる）
      setReplaceId(r.reschedule?.eventId ? String(r.reschedule.eventId) : '');
    },
    onError: (e) => {
      // AI が使えないときも手入力で登録できるように空の結果を出す
      setErr(`読み取りに失敗しました: ${(e as Error).message}`);
      if (!res) {
        setRes({ status: 'none', content: '打合せ', kind: 'meeting', web: false, durationMinutes: 60, location: null, slots: [], note: '', clientId: null, clientName: null, counterpartName: '', title: '', webProvider: 'none' });
        setSlots([{ start: todayLocalInput(10) }]);
      }
    },
  });
  const register = useMutation({
    mutationFn: () =>
      api.post<{ mode: string; events: { id: number }[]; webText: string; replaced?: Replaced | null; replaces?: Replaced | null }>(`/conversations/${conversationId}/schedule/register`, {
        mode,
        title: mode === 'holds' ? title.replace(/\s*仮$/, '') : title,
        kind,
        caseId: caseId ? Number(caseId) : null,
        location: location || null,
        web,
        replaceEventId: replaceId ? Number(replaceId) : null,
        slots: (mode === 'confirmed' ? slots.slice(0, 1) : slots)
          .filter((s) => s.start)
          .map((s) => {
            const start = new Date(fromLocalInput(s.start));
            return { startAt: start.toISOString(), endAt: new Date(start.getTime() + Math.max(15, duration) * 60_000).toISOString() };
          }),
      }),
    onSuccess: (r) => {
      setWebText(r.webText ?? '');
      const was = (x: Replaced) => `${fmtDateTime(x.startAt)}「${x.title}」`;
      setDone(
        r.mode === 'confirmed'
          ? r.replaced
            ? `元の予定 ${was(r.replaced)} を取り消して、新しい日時で登録しました`
            : 'カレンダーに登録しました'
          : `${r.events.length} 件を仮押さえしました。確定したら「予定」画面の「この候補で確定」を押してください${web ? '（そのときに会議 URL を発行します）' : ''}${
              r.replaces ? `。確定した時点で、元の予定 ${was(r.replaces)} は取り消されます` : ''
            }`,
      );
      setErr('');
      onDone();
    },
    onError: (e) => setErr((e as Error).message),
  });
  useEffect(() => {
    if (!res && !extract.isPending) extract.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="rounded border border-slate-200 p-3 text-sm">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-semibold">会話から予定を登録</span>
        <button className="btn btn-sm ml-auto" onClick={() => extract.mutate()} disabled={extract.isPending}>
          {extract.isPending ? '読み取り中…' : '読み取り直す'}
        </button>
      </div>
      {extract.isPending && !res && <div className="text-slate-500">やり取りから日時を読み取っています…</div>}
      {err && <div className="fade-in mb-2 text-red-600">{err}</div>}
      {done && (
        <div className="mb-2 text-green-700">
          {done}{' '}
          <Link to="/calendar" className="text-blue-700 underline">
            予定を開く
          </Link>
        </div>
      )}
      {done && webText && (
        <div className="mb-2 rounded border border-blue-200 bg-blue-50 p-2">
          <div className="mb-1 text-xs font-medium text-blue-900">会議 URL を発行しました（予定の説明欄にも入れました）</div>
          <pre className="whitespace-pre-wrap break-all font-mono text-xs text-slate-700">{webText}</pre>
          <button type="button" className="btn btn-sm mt-2" onClick={() => onText(webText)}>
            返信欄に入れる
          </button>
        </div>
      )}
      {res && !done && (
        <div className="space-y-2">
          <div className="rounded bg-slate-50 p-2 text-xs text-slate-600">
            {res.status === 'none' ? '日程に関するやり取りは見つかりませんでした。下で手入力もできます。' : res.status === 'confirmed' ? '日時は確定しているようです。' : '候補が挙がっていますが未確定のようです。仮押さえとして登録できます。'} {res.note}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1">
              <input type="radio" checked={mode === 'confirmed'} onChange={() => setMode('confirmed')} /> 確定として登録（1 件）
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" checked={mode === 'holds'} onChange={() => setMode('holds')} /> 候補を仮押さえ（{slots.filter((s) => s.start).length} 件）
            </label>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <div className="md:col-span-2">
              <label className="label">件名{mode === 'holds' && '（末尾に「仮」が付きます）'}</label>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div>
              <label className="label">種別</label>
              <select className="input" value={kind} onChange={(e) => setKind(e.target.value as EventKind)}>
                {(['meeting', 'consult', 'hearing', 'other'] as EventKind[]).map((k) => (
                  <option key={k} value={k}>
                    {EVENT_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">所要時間（分）</label>
              <input type="number" className="input" min={15} step={15} value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
            </div>
            <div>
              <label className="label">場所</label>
              <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder={web ? WEB_PROVIDER_LABEL[res.webProvider] : '事務所 など'} />
            </div>
            <div className="md:col-span-2">
              <label className="flex flex-wrap items-center gap-2 text-sm">
                <input type="checkbox" checked={web} onChange={(e) => setWeb(e.target.checked)} />
                WEB 会議で行う（{WEB_PROVIDER_LABEL[res.webProvider]} の URL を発行する）
              </label>
              {web && (
                <p className="mt-1 text-xs text-slate-500">
                  {res.webProvider === 'none'
                    ? 'Zoom も Google Meet も使えない設定です。初期設定で Zoom を登録するか、Google に接続すると URL を自動で発行します。いまは場所に「WEB会議」とだけ入ります。'
                    : mode === 'confirmed'
                      ? `登録と同時に ${WEB_PROVIDER_LABEL[res.webProvider]} の会議を作り、予定の説明欄に URL を入れます。登録後にこの画面から返信欄へ貼り付けられます。`
                      : `候補の段階では会議を作りません。「この候補で確定」を押したときに ${WEB_PROVIDER_LABEL[res.webProvider]} の会議を 1 つだけ作ります。`}
                </p>
              )}
            </div>
            {cases.length > 0 && (
              <div>
                <label className="label">事件</label>
                <select className="input" value={caseId} onChange={(e) => setCaseId(e.target.value)}>
                  <option value="">（なし）</option>
                  {cases.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.title}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {(res.existingEvents?.length ?? 0) > 0 && (
              <div className={`md:col-span-2 rounded border p-2 ${replaceId ? 'border-amber-300 bg-amber-50' : 'border-slate-200'}`}>
                <label className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <input type="checkbox" checked={!!replaceId} onChange={(e) => setReplaceId(e.target.checked ? String(res.reschedule?.eventId ?? res.existingEvents![0]!.id) : '')} />
                  日程変更（リスケ）として登録する（元の予定を取り消す）
                </label>
                {res.reschedule && (
                  <div className="mt-1 text-xs text-amber-800">
                    やり取りから日程変更と読み取りました{res.reschedule.quote ? `（「${res.reschedule.quote}」）` : ''}。
                    {!res.reschedule.eventId && 'どの予定の変更かは下で選んでください。'}
                  </div>
                )}
                {replaceId && (
                  <div className="mt-1.5 space-y-1">
                    <select className="input w-auto max-w-full" value={replaceId} onChange={(e) => setReplaceId(e.target.value)} aria-label="取り消す予定">
                      {res.existingEvents!.map((ev) => (
                        <option key={ev.id} value={ev.id}>
                          {fmtDateTime(ev.startAt)}　{ev.title}
                        </option>
                      ))}
                    </select>
                    <div className="text-xs text-slate-600">
                      {mode === 'confirmed'
                        ? '新しい日時で登録したあと、この予定を取り消します（Google カレンダーからも消えます）。'
                        : '候補のどれかを「この候補で確定」したときに、この予定を取り消します。それまではこの予定も残ります。'}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="md:col-span-2">
              <label className="label">{mode === 'confirmed' ? '日時（先頭の 1 件を使います）' : '候補日時'}</label>
              <div className="space-y-1">
                {slots.map((s, i) => (
                  <div key={i} className={`flex flex-wrap items-center gap-2 ${mode === 'confirmed' && i > 0 ? 'opacity-50' : ''}`}>
                    <span className="w-5 text-xs text-slate-500">{i + 1}.</span>
                    <input type="datetime-local" className="input w-auto" value={s.start} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
                    {s.timeKnown === false && <span className="badge badge-orange">時刻は仮</span>}
                    {s.quote && <span className="min-w-0 truncate text-xs text-slate-500" title={s.quote}>「{s.quote}」</span>}
                    <button type="button" className="btn btn-sm" onClick={() => setSlots(slots.filter((_, j) => j !== i))} aria-label="外す">
                      ×
                    </button>
                  </div>
                ))}
                <button type="button" className="btn btn-sm" onClick={() => setSlots([...slots, { start: todayLocalInput(10) }])}>
                  ＋ 日時を追加
                </button>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn btn-primary shrink-0 whitespace-nowrap"
              onClick={() => {
                // 予定を消すので、確定の日程変更だけは念のため聞く（仮押さえは確定するまで消さない）
                const target = replaceId && mode === 'confirmed' ? res.existingEvents?.find((ev) => String(ev.id) === replaceId) : null;
                if (target && !window.confirm(`元の予定 ${fmtDateTime(target.startAt)}「${target.title}」を取り消して、新しい日時で登録します。よろしいですか？`)) return;
                register.mutate();
              }}
              disabled={register.isPending || !title.trim() || slots.filter((s) => s.start).length === 0}
            >
              {register.isPending ? '登録中…' : mode === 'confirmed' ? (replaceId ? '元の予定を取り消して登録' : 'カレンダーに登録') : `${slots.filter((s) => s.start).length} 件を仮押さえ`}
            </button>
            <span className="text-xs text-slate-500">内容を確認してから押してください。Google 接続時は Google カレンダーにも登録されます。</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** 事務局の伝言など、メッセージ単位の紐付けとタスク化 */
/** 依頼者に複数の事件があるとき、このメッセージがどの事件の話かを表示・変更する */
function CaseTag({ m, cases, out, onChanged }: { m: Message; cases: { id: number; title: string }[]; out: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const link = useMutation({
    mutationFn: (caseId: number | null) => api.put(`/messages/${m.id}/link`, { caseId }),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
  });
  const current = cases.find((k) => k.id === m.caseId);
  if (editing) {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
        <select className={`input w-auto py-0.5 text-xs ${out ? 'text-slate-800' : ''}`} value={m.caseId ?? ''} onChange={(e) => link.mutate(e.target.value ? Number(e.target.value) : null)} disabled={link.isPending} aria-label="事件">
          <option value="">事件未確定</option>
          {cases.map((k) => (
            <option key={k.id} value={k.id}>
              {k.title}
            </option>
          ))}
        </select>
        <button type="button" className={`hover:underline ${out ? 'text-blue-100' : 'text-slate-500'}`} onClick={() => setEditing(false)}>
          やめる
        </button>
      </div>
    );
  }
  return (
    <button type="button" className={`mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${current ? (out ? 'bg-white/15 text-white' : 'bg-[var(--accent-soft)] text-[var(--accent)]') : out ? 'bg-white/15 text-blue-100' : 'bg-orange-50 text-orange-700'}`} onClick={() => setEditing(true)} title="このメッセージがどの事件の話かを変えます">
      <Icon name="scale" className="h-3 w-3" />
      {current ? current.title : '事件未確定'}
      <span className="opacity-60">▾</span>
    </button>
  );
}

function MessageTools({ m, onChanged }: { m: Message; onChanged: () => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'link' | 'task' | null>(null);
  const [clientId, setClientId] = useState(m.clientId ? String(m.clientId) : '');
  const [caseId, setCaseId] = useState(m.caseId ? String(m.caseId) : '');
  const [title, setTitle] = useState(m.body.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 120) ?? '');
  const [due, setDue] = useState('');
  const [sync, setSync] = useState(false);
  const [err, setErr] = useState('');
  const cases = useQuery({ queryKey: ['cases', 'open'], queryFn: () => api.get<{ id: number; title: string; clientId: number; clientName: string }[]>('/cases?status=open'), enabled: mode === 'link' });
  const caseOptions = (cases.data ?? []).filter((k) => !clientId || k.clientId === Number(clientId));
  const link = useMutation({
    mutationFn: () => api.put(`/messages/${m.id}/link`, { clientId: clientId ? Number(clientId) : null, caseId: caseId ? Number(caseId) : null }),
    onSuccess: () => {
      setMode(null);
      setErr('');
      onChanged();
    },
    onError: (e) => setErr((e as Error).message),
  });
  const task = useMutation({
    mutationFn: () => api.post<{ id: number }>(`/messages/${m.id}/task`, { title, followUpAt: due ? fromLocalInput(`${due}T09:00`) : null, syncToChatwork: sync }),
    onSuccess: () => {
      setMode(null);
      setErr('');
      qc.invalidateQueries({ queryKey: ['tasks'] });
      onChanged();
    },
    onError: (e) => setErr((e as Error).message),
  });
  return (
    <div className="mt-1 text-xs">
      <div className="flex flex-wrap items-center gap-1 text-slate-500">
        {m.clientId ? (
          <span>
            →{' '}
            <Link to={`/clients/${m.clientId}`} className="text-blue-700 hover:underline">
              {m.clientName ?? '依頼者'}
            </Link>
            {m.caseId && (
              <>
                {' / '}
                <Link to={`/cases/${m.caseId}`} className="text-blue-700 hover:underline">
                  {m.caseTitle ?? '事件'}
                </Link>
              </>
            )}
          </span>
        ) : (
          <span className="text-slate-400">依頼者の紐付けなし</span>
        )}
        <button type="button" className="rounded border border-slate-300 bg-white px-1.5 text-slate-700 hover:bg-slate-50" onClick={() => setMode(mode === 'link' ? null : 'link')}>
          紐付け
        </button>
        <button type="button" className="rounded border border-slate-300 bg-white px-1.5 text-slate-700 hover:bg-slate-50" onClick={() => setMode(mode === 'task' ? null : 'task')}>
          タスク化
        </button>
      </div>
      {mode === 'link' && (
        <div className="mt-1 flex flex-wrap items-center gap-1 rounded border border-slate-200 bg-white p-2">
          <ClientPicker
            value={clientId}
            onChange={(v) => {
              setClientId(v);
              setCaseId('');
            }}
            emptyLabel="（依頼者なし）"
            selectClassName="w-44"
          />
          <select className="input w-44" value={caseId} onChange={(e) => setCaseId(e.target.value)} aria-label="事件">
            <option value="">（事件なし）</option>
            {caseOptions.map((k) => (
              <option key={k.id} value={k.id}>
                {clientId ? k.title : `${k.clientName} / ${k.title}`}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => link.mutate()} disabled={link.isPending}>
            保存
          </button>
        </div>
      )}
      {mode === 'task' && (
        <div className="mt-1 space-y-1 rounded border border-slate-200 bg-white p-2">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="タスク名" />
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1">
              期限 <input type="date" className="input w-auto py-0.5" value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> 担当事務局の Chatwork タスクにも登録
            </label>
            <button type="button" className="btn btn-primary btn-sm ml-auto" onClick={() => task.mutate()} disabled={!title.trim() || task.isPending}>
              タスクを作る
            </button>
          </div>
          <div className="text-slate-400">紐付いている依頼者・事件のタスクになります。Chatwork に登録する場合、事件に担当事務局と専用ルームが設定されていればその担当者に振ります。</div>
        </div>
      )}
      {err && <div className="fade-in text-red-600">{err}</div>}
    </div>
  );
}
