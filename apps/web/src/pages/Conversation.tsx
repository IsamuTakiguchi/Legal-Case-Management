import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { channelBadge, channelLabel, fmtDateTime, fmtBytes, fromLocalInput, todayLocalInput } from '../lib/format';
import { SCHEDULING_KINDS } from '@lcm/shared';

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
}
interface Conv {
  id: number;
  channel: string;
  subject: string | null;
  counterpartName: string | null;
  counterpartAddress: string | null;
  clientId: number | null;
  needsReply: boolean;
  archived: boolean;
  client: { id: number; name: string; onedriveFolderPath: string | null; preferredChannel: string | null } | null;
  cases: { id: number; title: string; summary: string | null }[];
  messages: Message[];
  drafts: { id: number; generatedText: string; instruction: string | null; createdAt: string; status: string }[];
  suggestions: { id: number; name: string }[];
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
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => api.get<{ id: number; name: string }[]>('/clients') });

  const [text, setText] = useState('');
  const [instruction, setInstruction] = useState('');
  const [templateKey, setTemplateKey] = useState('');
  const [draftId, setDraftId] = useState<number | null>(null);
  const [createWaiting, setCreateWaiting] = useState(false);
  const [selectedAtt, setSelectedAtt] = useState<number[]>([]);
  const [driveFiles, setDriveFiles] = useState<DriveFile[]>([]);
  const [showFiles, setShowFiles] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [linkClientId, setLinkClientId] = useState('');

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['conversation', id] });
    qc.invalidateQueries({ queryKey: ['conversations'] });
    qc.invalidateQueries({ queryKey: ['scheduling', id] });
  };

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
    mutationFn: () =>
      api.post<{ note?: string; links: { name: string }[]; manualFiles: string[] }>(`/conversations/${id}/send`, {
        text,
        attachmentIds: selectedAtt,
        driveFiles: driveFiles.map((f) => ({ itemId: f.itemId, name: f.name, path: f.path })),
        draftId,
        createWaitingTask: createWaiting,
      }),
    onSuccess: (r) => {
      setText('');
      setDraftId(null);
      setSelectedAtt([]);
      setDriveFiles([]);
      setCreateWaiting(false);
      const notes = [r.note, r.links.length ? `${r.links.length} 件を共有リンクで送付` : '', r.manualFiles.length ? `手動送付が必要: ${r.manualFiles.join('、')}` : ''].filter(Boolean);
      setMsg({ kind: 'ok', text: `送信しました${notes.length ? `（${notes.join(' / ')}）` : ''}` });
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

  const toggle = useMutation({
    mutationFn: (v: { needsReply?: boolean; archived?: boolean }) => (v.needsReply !== undefined ? api.post(`/conversations/${id}/needs-reply`, v) : api.post(`/conversations/${id}/archive`, v)),
    onSuccess: invalidate,
  });

  const c = conv.data;
  const storedAtts = useMemo(() => c?.messages.flatMap((m) => m.attachments.filter((a) => a.status === 'stored')) ?? [], [c]);

  useEffect(() => {
    if (c && !c.clientId && c.suggestions[0]) setLinkClientId(String(c.suggestions[0].id));
  }, [c]);

  if (!c) return <div className="text-slate-500">読み込み中…</div>;

  const name = c.client?.name ?? c.counterpartName ?? c.counterpartAddress ?? '（不明）';

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/inbox" className="text-sm text-slate-500 hover:underline">
            ← 受信箱
          </Link>
          <span className={channelBadge(c.channel)}>{channelLabel(c.channel)}</span>
          <h1 className="text-lg font-bold">{name}</h1>
          {c.client && (
            <Link to={`/clients/${c.client.id}`} className="text-sm text-blue-700 hover:underline">
              依頼者ページ
            </Link>
          )}
          {c.subject && <span className="text-sm text-slate-500">件名: {c.subject}</span>}
          <div className="ml-auto flex gap-2">
            <button className="btn btn-sm" onClick={() => toggle.mutate({ needsReply: !c.needsReply })}>
              {c.needsReply ? '対応済みにする' : '要返信にする'}
            </button>
            <button className="btn btn-sm" onClick={() => toggle.mutate({ archived: !c.archived })}>
              {c.archived ? 'アーカイブ解除' : 'アーカイブ'}
            </button>
          </div>
        </div>

        {!c.clientId && (
          <div className="card border-orange-200 bg-orange-50">
            <div className="mb-2 text-sm font-semibold text-orange-800">この連絡先はまだ依頼者に紐付いていません</div>
            <div className="flex flex-wrap items-center gap-2">
              <select className="input w-64" value={linkClientId} onChange={(e) => setLinkClientId(e.target.value)}>
                <option value="">依頼者を選択…</option>
                {c.suggestions.length > 0 && (
                  <optgroup label="候補">
                    {c.suggestions.map((s) => (
                      <option key={`s${s.id}`} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="すべて">
                  {clients.data?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>
              </select>
              <button className="btn btn-primary btn-sm" disabled={!linkClientId} onClick={() => link.mutate(Number(linkClientId))}>
                紐付ける
              </button>
              <Link to={`/clients?new=${encodeURIComponent(c.counterpartName ?? '')}&email=${encodeURIComponent(c.channel === 'gmail' ? c.counterpartAddress ?? '' : '')}`} className="btn btn-sm">
                新規依頼者として登録
              </Link>
            </div>
          </div>
        )}

        <div className="card max-h-[55vh] space-y-3 overflow-y-auto">
          {c.messages.map((m) => (
            <div key={m.id} className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${m.direction === 'out' ? 'bg-blue-600 text-white' : 'bg-slate-100'}`}>
                <div className={`mb-1 text-xs ${m.direction === 'out' ? 'text-blue-100' : 'text-slate-500'}`}>
                  {m.direction === 'out' ? '自分' : (m.senderName ?? name)} ・ {fmtDateTime(m.sentAt)}
                </div>
                <div className="whitespace-pre-wrap break-words">{m.body}</div>
                {m.attachments.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {m.attachments.map((a) => (
                      <li key={a.id} className="text-xs">
                        📎{' '}
                        {a.status === 'stored' ? (
                          <a className="underline" href={`/api/attachments/${a.id}/download`}>
                            {a.filename}
                          </a>
                        ) : (
                          a.filename
                        )}{' '}
                        <span className={m.direction === 'out' ? 'text-blue-100' : 'text-slate-500'}>
                          {fmtBytes(a.size)} {a.status === 'unassigned' ? '（未振分）' : a.status === 'failed' ? '（取得失敗）' : a.status === 'pending' ? '（保存中）' : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ))}
          {c.messages.length === 0 && <div className="text-sm text-slate-500">メッセージはありません</div>}
        </div>

        <div className="card space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input className="input flex-1" placeholder="AI への指示（例: 来週火曜14時で確定と返す／資料の受領を伝えて次回期日を案内）" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
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
          <textarea className="input min-h-40 font-mono text-sm" value={text} onChange={(e) => setText(e.target.value)} placeholder="返信本文（AI 下書きを編集して送信）" />
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
            <button className="btn btn-sm" onClick={() => judge.mutate()} disabled={!text || judge.isPending}>
              返信待ちになる？
            </button>
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={createWaiting} onChange={(e) => setCreateWaiting(e.target.checked)} /> 送信後「返信待ち」タスクを作る
            </label>
            <button className="btn btn-primary ml-auto" onClick={() => send.mutate()} disabled={!text.trim() || send.isPending}>
              {send.isPending ? '送信中…' : `${channelLabel(c.channel)} で送信`}
            </button>
          </div>
          {msg && <div className={`text-sm ${msg.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}>{msg.text}</div>}
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
          {showSchedule && <SchedulePanel conversationId={c.id} onText={(t) => setText((prev) => (prev ? `${prev}\n\n${t}` : t))} onDone={invalidate} />}
        </div>
      </div>

      <aside className="space-y-4">
        {sessions.data && sessions.data.filter((s) => s.state !== 'cancelled').length > 0 && (
          <div className="card">
            <h3 className="mb-2 text-sm font-semibold">日程調整</h3>
            {sessions.data
              .filter((s) => s.state !== 'cancelled')
              .map((s) => (
                <SessionCard key={s.id} s={s} onText={(t) => setText((prev) => (prev ? `${prev}\n\n${t}` : t))} onDone={invalidate} />
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

function SchedulePanel({ conversationId, onText, onDone }: { conversationId: number; onText: (t: string) => void; onDone: () => void }) {
  const [kind, setKind] = useState<string>('面談');
  const [from, setFrom] = useState(todayLocalInput(9).slice(0, 10));
  const [to, setTo] = useState(new Date(Date.now() + 14 * 86400_000 + 9 * 3600_000).toISOString().slice(0, 10));
  const [duration, setDuration] = useState(60);
  const [max, setMax] = useState(3);
  const [err, setErr] = useState('');
  const propose = useMutation({
    mutationFn: () => api.post<{ text: string; session: Session }>('/scheduling/propose', { conversationId, kind, from: `${from}T00:00:00+09:00`, to: `${to}T23:59:59+09:00`, durationMinutes: duration, maxCandidates: max }),
    onSuccess: (r) => {
      onText(`ご都合はいかがでしょうか。\n${r.text}`);
      onDone();
      setErr('');
    },
    onError: (e) => setErr((e as Error).message),
  });
  return (
    <div className="rounded border border-slate-200 p-3 text-sm">
      <div className="mb-2 font-semibold">候補日を提案して仮押さえ</div>
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
        <button className="btn btn-primary" onClick={() => propose.mutate()} disabled={propose.isPending}>
          {propose.isPending ? '確認中…' : '空きを探して仮押さえ'}
        </button>
      </div>
      {err && <div className="mt-2 text-red-600">{err}</div>}
      <div className="mt-2 text-xs text-slate-500">Google カレンダーの空きから候補を出し、「{'{姓} {内容} 仮'}」として仮押さえします。候補文は返信欄に追加されます。</div>
    </div>
  );
}

function SessionCard({ s, onText, onDone }: { s: Session; onText: (t: string) => void; onDone: () => void }) {
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
    <div className="mb-2 rounded border border-slate-200 p-2 text-xs">
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
          {err && <div className="text-red-600">{err}</div>}
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
  const tasks = useQuery({ queryKey: ['tasks', 'conv', conversationId], queryFn: () => api.get<{ id: number; title: string; status: string; followUpAt: string | null }[]>(`/tasks?conversationId=${conversationId}&status=active`) });
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('waiting_client');
  const add = useMutation({
    mutationFn: () => api.post('/tasks', { title, status, conversationId, clientId }),
    onSuccess: () => {
      setTitle('');
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
  const done = useMutation({ mutationFn: (id: number) => api.put(`/tasks/${id}`, { status: 'done' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }) });
  return (
    <div className="card">
      <h3 className="mb-2 text-sm font-semibold">この会話のタスク</h3>
      <ul className="mb-2 space-y-1 text-xs">
        {tasks.data?.map((t) => (
          <li key={t.id} className="flex items-center gap-2">
            <button className="text-slate-400 hover:text-green-600" title="完了" onClick={() => done.mutate(t.id)}>
              ☐
            </button>
            <span className="flex-1">{t.title}</span>
            <span className="badge badge-gray">{t.status === 'open' ? '対応中' : t.status === 'waiting_client' ? '依頼者待ち' : '相手方待ち'}</span>
          </li>
        ))}
        {tasks.data?.length === 0 && <li className="text-slate-500">なし</li>}
      </ul>
      <div className="flex gap-1">
        <input className="input" placeholder="タスクを追加" value={title} onChange={(e) => setTitle(e.target.value)} />
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">対応中</option>
          <option value="waiting_client">依頼者待ち</option>
          <option value="waiting_other">相手方待ち</option>
        </select>
        <button className="btn btn-sm" onClick={() => add.mutate()} disabled={!title}>
          追加
        </button>
      </div>
    </div>
  );
}
