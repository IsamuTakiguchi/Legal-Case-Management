import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useDraftRecord, clearDraft, DraftHint } from '../lib/draft';
import { channelBadge, channelLabel, fmtDateTime, fmtBytes } from '../lib/format';
import { Icon } from '../lib/icons';
import { ClientForm, clientFormDraftKey, type ClientRow } from './Clients';
import { EVENT_KIND_LABEL, TASK_STATUS_LABEL, type EventKind, type TaskStatus, CASE_STATUSES, CASE_STATUS_LABEL, telHref, representativeLabel } from '@lcm/shared';
import { CaseStatusBadge } from './Cases';
import { ClientPicker } from '../lib/ClientPicker';
import { LineInvitePanel } from '../lib/LineInvite';

interface Detail extends ClientRow {
  folder: string;
  cases: { id: number; title: string; caseTypeLabel: string; status: string; nextHearingAt: string | null; stage: string | null }[];
  conversations: { id: number; channel: string; subject: string | null; lastMessageAt: string | null; needsReply: boolean; contact?: { name: string; roleLabel: string; caseTitle: string } | null }[];
  tasks: { id: number; title: string; status: string; followUpAt: string | null }[];
  events: { id: number; title: string; startAt: string; kind: string }[];
}

export default function ClientDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [edit, setEdit] = useState(false);
  const [newCase, setNewCase] = useState(false);
  const [sub, setSub] = useState('');
  // 依頼者フォルダの指定し直し・名前変更の欄
  const [folderEdit, setFolderEdit] = useState(false);
  const d = useQuery({ queryKey: ['client', id], queryFn: () => api.get<Detail>(`/clients/${id}`) });
  const files = useQuery({ queryKey: ['client-files', id, sub], queryFn: () => api.get<{ folder: string; exists?: boolean; items: { name: string; path: string; isFolder: boolean; size?: number; modifiedAt?: string; webUrl?: string }[] }>(`/clients/${id}/files?path=${encodeURIComponent(sub)}`), retry: false });
  const classify = useMutation({
    mutationFn: () => api.post<{ checked: number; assigned: number; skipped: string | null }>(`/clients/${id}/classify-messages`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['timeline'] }),
  });
  const createFolder = useMutation({
    mutationFn: () => api.post<{ folder: string; path: string }>(`/clients/${id}/folder`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['client-files', id] });
      qc.invalidateQueries({ queryKey: ['client', id] });
    },
  });
  const types = useQuery({ queryKey: ['case-types'], queryFn: () => api.get<{ key: string; label: string }[]>('/case-types') });
  const update = useMutation({
    mutationFn: (b: Partial<ClientRow>) => api.put(`/clients/${id}`, b),
    onSuccess: () => {
      clearDraft(clientFormDraftKey(Number(id)));
      setEdit(false);
      qc.invalidateQueries({ queryKey: ['client', id] });
    },
  });
  const [caseForm, setCaseForm] = useState({ title: '', caseType: 'general_civil', status: 'active', courtName: '', caseNumber: '' });
  const CASE_FORM_BASE = { title: '', caseType: 'general_civil', status: 'active', courtName: '', caseNumber: '' };
  // 入力途中の新規事件はこの端末に自動保存する
  const caseDraft = useDraftRecord(`client:${id}:new-case`, caseForm, setCaseForm, CASE_FORM_BASE);
  const createCase = useMutation({
    mutationFn: () => api.post<{ id: number }>('/cases', { ...caseForm, clientId: Number(id) }),
    onSuccess: () => {
      caseDraft.clear();
      setCaseForm(CASE_FORM_BASE);
      setNewCase(false);
      qc.invalidateQueries({ queryKey: ['client', id] });
    },
  });
  const c = d.data;
  if (!c) return <div className="loading-text text-slate-500">読み込み中…</div>;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link to="/clients" className="text-sm text-slate-500 hover:underline">
          ← 依頼者
        </Link>
        <h1 className="text-xl font-bold">{c.name}</h1>
        {c.provisional && <span className="badge badge-orange">氏名未確認</span>}
        {c.entityType === 'corporation' && <span className="badge badge-gray">法人</span>}
        {c.kana && <span className="text-sm text-slate-500">{c.kana}</span>}
        <button className="btn btn-sm ml-auto" onClick={() => setEdit(!edit)}>
          編集
        </button>
        <button
          className="btn btn-sm text-red-600"
          onClick={() => {
            if (confirm(`「${c.name}」を削除します。事件・ノート・タスクも削除されます（会話とファイルは残り、紐付けだけ外れます）。よろしいですか？`)) {
              api.del(`/clients/${c.id}`).then(() => {
                qc.invalidateQueries({ queryKey: ['clients'] });
                nav('/clients');
              });
            }
          }}
        >
          削除
        </button>
      </div>
      {edit && (
        <ClientForm
          initial={c}
          onSubmit={(b) => update.mutate(b)}
          onCancel={() => setEdit(false)}
          busy={update.isPending}
          onInviteChanged={() => qc.invalidateQueries({ queryKey: ['client', id] })}
        />
      )}
      {c.provisional && <ProvisionalClientPanel clientId={c.id} name={c.name} />}
      <ContactCard c={c} onEdit={() => setEdit(true)} />
      <div className="grid gap-4 md:grid-cols-2">
        <section className="card">
          <div className="mb-2 flex items-center">
            <h2 className="font-semibold">事件</h2>
            <button className="btn btn-sm ml-auto" onClick={() => setNewCase(!newCase)}>
              ＋ 事件を追加
            </button>
          </div>
          {newCase && (
            <form
              className="mb-3 grid gap-2 rounded border border-slate-200 p-2 text-sm md:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                createCase.mutate();
              }}
            >
              <input className="input md:col-span-2" placeholder="事件名（例: 損害賠償請求（交通事故））" required value={caseForm.title} onChange={(e) => setCaseForm({ ...caseForm, title: e.target.value })} />
              <select className="input" value={caseForm.status} onChange={(e) => setCaseForm({ ...caseForm, status: e.target.value })} aria-label="進捗区分">
                {CASE_STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {CASE_STATUS_LABEL[st]}
                  </option>
                ))}
              </select>
              <select className="input" value={caseForm.caseType} onChange={(e) => setCaseForm({ ...caseForm, caseType: e.target.value })}>
                {types.data?.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
              <input className="input" placeholder="裁判所" value={caseForm.courtName} onChange={(e) => setCaseForm({ ...caseForm, courtName: e.target.value })} />
              <input className="input" placeholder="事件番号" value={caseForm.caseNumber} onChange={(e) => setCaseForm({ ...caseForm, caseNumber: e.target.value })} />
              <div className="flex items-center gap-2 md:col-span-2">
                <button className="btn btn-primary">作成</button>
                <DraftHint handle={caseDraft} />
              </div>
            </form>
          )}
          {c.cases.length >= 2 && (
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              <button type="button" className="btn btn-sm" onClick={() => classify.mutate()} disabled={classify.isPending} title="この依頼者とのメール・LINE・Chatwork を、内容から事件ごとに振り分けます（事件が決まっていないものだけ）">
                {classify.isPending ? '振り分け中…' : 'メッセージを事件ごとに振り分け（AI）'}
              </button>
              {classify.data && <span className="fade-in text-slate-600">{classify.data.skipped ?? `${classify.data.checked} 件を確認し、${classify.data.assigned} 件を事件に振り分けました`}</span>}
              <span className="text-slate-400">受信・送信のたびに自動でも判定します。会話画面で個別に変えられます</span>
            </div>
          )}
          <ul className="space-y-1 text-sm">
            {c.cases.map((k) => (
              <li key={k.id} className="flex items-center gap-2">
                <Link to={`/cases/${k.id}`} className="text-blue-700 hover:underline">
                  {k.title}
                </Link>
                <CaseStatusBadge status={k.status} />
                <span className="badge badge-gray">{k.caseTypeLabel}</span>
                {k.stage && <span className="text-xs text-slate-500">{k.stage}</span>}
                {k.nextHearingAt && <span className="ml-auto text-xs text-slate-500">次回 {fmtDateTime(k.nextHearingAt)}</span>}
              </li>
            ))}
            {c.cases.length === 0 && <li className="text-slate-500">事件は未登録です</li>}
          </ul>
        </section>
        <section className="card">
          <h2 className="mb-2 font-semibold">会話</h2>
          <ul className="space-y-1 text-sm">
            {c.conversations.map((v) => (
              <li key={v.id} className="flex items-center gap-2">
                <span className={channelBadge(v.channel)}>{channelLabel(v.channel)}</span>
                {v.contact && (
                  <span className="badge badge-orange shrink-0 whitespace-nowrap" title={v.contact.caseTitle}>
                    {v.contact.roleLabel}: {v.contact.name}
                  </span>
                )}
                <Link to={`/inbox/${v.id}`} className="truncate hover:underline">
                  {v.subject ?? '（件名なし）'}
                </Link>
                {v.needsReply && <span className="badge badge-blue">要返信</span>}
                <span className="ml-auto shrink-0 text-xs text-slate-500">{fmtDateTime(v.lastMessageAt)}</span>
              </li>
            ))}
            {c.conversations.length === 0 && <li className="text-slate-500">まだやり取りがありません</li>}
          </ul>
        </section>
        <section className="card">
          <h2 className="mb-2 font-semibold">タスク</h2>
          <ul className="space-y-1 text-sm">
            {c.tasks
              .filter((t) => t.status !== 'done')
              .map((t) => (
                <li key={t.id} className="flex items-center gap-2">
                  <span>{t.title}</span>
                  <span className="badge badge-gray">{TASK_STATUS_LABEL[t.status as TaskStatus]}</span>
                </li>
              ))}
          </ul>
        </section>
        <section className="card">
          <h2 className="mb-2 font-semibold">予定</h2>
          <ul className="space-y-1 text-sm">
            {c.events.map((e) => (
              <li key={e.id} className="flex items-center gap-2">
                <span className="w-32 text-slate-500">{fmtDateTime(e.startAt)}</span>
                <span className="badge badge-gray">{EVENT_KIND_LABEL[e.kind as EventKind]}</span>
                <span>{e.title}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card md:col-span-2">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="font-semibold">依頼者フォルダ</h2>
            <span className="text-xs text-slate-500">{files.data?.folder ?? c.folder}</span>
            {sub && (
              <button className="btn btn-sm" onClick={() => setSub(sub.split('/').slice(0, -1).join('/'))}>
                ↑ 上へ
              </button>
            )}
            <button className="btn btn-sm ml-auto" onClick={() => setFolderEdit(!folderEdit)} title="別のフォルダを指定したり、フォルダ名を変えたりします">
              フォルダを変更
            </button>
          </div>
          {folderEdit && (
            <FolderEditor
              clientId={c.id}
              currentPath={c.onedriveFolderPath ?? ''}
              currentFolder={files.data?.folder ?? c.folder}
              exists={files.data?.exists !== false}
              onDone={() => {
                setFolderEdit(false);
                setSub('');
                qc.invalidateQueries({ queryKey: ['client-files', id] });
                qc.invalidateQueries({ queryKey: ['client', id] });
              }}
              onCancel={() => setFolderEdit(false)}
            />
          )}
          {files.error && <div className="text-sm text-red-600">{(files.error as Error).message}</div>}
          {files.data?.exists === false && (
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              {sub ? (
                <span>このフォルダはまだありません。</span>
              ) : (
                <>
                  <div>OneDrive にこの依頼者のフォルダはまだありません。最初のファイルを保存するときに上の場所へ自動で作られます。</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button className="btn btn-sm" onClick={() => createFolder.mutate()} disabled={createFolder.isPending}>
                      {createFolder.isPending ? '作成中…' : '今すぐフォルダを作る'}
                    </button>
                    <span className="text-xs text-slate-500">既にある別のフォルダを使うなら、右上の「フォルダを変更」から指定してください</span>
                  </div>
                  {createFolder.error && <div className="mt-1 text-xs text-red-600">{(createFolder.error as Error).message}</div>}
                </>
              )}
            </div>
          )}
          <table className="w-full text-sm">
            <tbody>
              {files.data?.items.map((f) => (
                <tr key={f.path} className="border-t border-slate-100">
                  <td className="py-1">
                    {f.isFolder ? (
                      <button className="text-blue-700 hover:underline" onClick={() => setSub(sub ? `${sub}/${f.name}` : f.name)}>
                        📁 {f.name}
                      </button>
                    ) : f.webUrl ? (
                      <a href={f.webUrl} target="_blank" rel="noreferrer" className="hover:underline">
                        📄 {f.name}
                      </a>
                    ) : (
                      <span>📄 {f.name}</span>
                    )}
                  </td>
                  <td className="py-1 text-right text-xs text-slate-500">{fmtBytes(f.size)}</td>
                  <td className="py-1 text-right text-xs text-slate-500">{fmtDateTime(f.modifiedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

/**
 * この依頼者の連絡先。受信がまだ無くても、ここで何が登録済みかが分かる。
 * LINE は相手の ID を先に知ることができないので、未登録なら友だち追加の案内をその場で開ける。
 */
function ContactCard({ c, onEdit }: { c: Detail; onEdit: () => void }) {
  const [invite, setInvite] = useState(false);
  const qc = useQueryClient();
  const waiting = !c.lineUserId && !!c.lineInvitedAt;
  return (
    <section className="card">
      <div className="mb-2 flex items-center">
        <h2 className="font-semibold">連絡先</h2>
        <button className="btn btn-sm ml-auto" onClick={onEdit}>
          連絡先を登録・変更
        </button>
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[6rem_1fr]">
        {c.entityType === 'corporation' && (
          <>
            <dt className="text-slate-500">代表者</dt>
            <dd>
              {representativeLabel(c) ?? <span className="text-slate-400">未登録</span>}
              {c.representativeKana && <span className="ml-2 text-xs text-slate-500">{c.representativeKana}</span>}
            </dd>
          </>
        )}
        <dt className="text-slate-500">電話</dt>
        <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {(c.phones ?? []).length ? (
            (c.phones ?? []).map((p) => (
              // スマホでは押すとそのまま発信できる
              <a key={p} href={telHref(p)} className="inline-flex items-center gap-1 text-blue-700 hover:underline">
                <Icon name="phone" className="h-3.5 w-3.5" />
                {p}
              </a>
            ))
          ) : (
            <span className="text-slate-400">未登録</span>
          )}
        </dd>
        <dt className="text-slate-500">メール</dt>
        <dd>{c.emails.length ? c.emails.join('、') : <span className="text-slate-400">未登録（登録すると、そのアドレスからのメールが自動でこの依頼者に入ります）</span>}</dd>
        <dt className="text-slate-500">Chatwork</dt>
        <dd>{c.chatworkRoomId ? `ルーム ${c.chatworkRoomId}` : <span className="text-slate-400">未登録</span>}</dd>
        <dt className="text-slate-500">LINE</dt>
        <dd className="flex flex-wrap items-center gap-2">
          {c.lineUserId ? (
            <span>紐付け済み（ID 末尾 …{c.lineUserId.slice(-6)}）</span>
          ) : waiting ? (
            <>
              <span className="rounded bg-amber-100 px-1 text-xs text-amber-800">連携待ち</span>
              <span className="text-slate-500">友だち追加されると「要確認」から紐付けられます</span>
            </>
          ) : (
            <span className="text-slate-400">未登録</span>
          )}
          {!c.lineUserId && (
            <button className="text-xs text-blue-700 hover:underline" onClick={() => setInvite(!invite)}>
              {invite ? '閉じる' : '友だち追加をお願いする'}
            </button>
          )}
        </dd>
        <dt className="text-slate-500">主な連絡手段</dt>
        <dd>{c.preferredChannel ? channelLabel(c.preferredChannel) : <span className="text-slate-400">未設定</span>}</dd>
      </dl>
      {invite && (
        <div className="mt-2">
          <LineInvitePanel clientId={c.id} invitedAt={c.lineInvitedAt ?? null} onChanged={() => qc.invalidateQueries({ queryKey: ['client', String(c.id)] })} />
        </div>
      )}
    </section>
  );
}

/**
 * 依頼者フォルダを直す。
 * - 別のフォルダを指定: 既にあるフォルダを選ぶ（アプリの指定だけを変える。OneDrive のフォルダはそのまま）
 * - フォルダ名を変更: OneDrive 上のフォルダの名前そのものを変える（中のファイルはそのまま）
 */
function FolderEditor({ clientId, currentPath, currentFolder, exists, onDone, onCancel }: { clientId: number; currentPath: string; currentFolder: string; exists: boolean; onDone: () => void; onCancel: () => void }) {
  const [mode, setMode] = useState<'pick' | 'rename'>(exists ? 'rename' : 'pick');
  const currentName = currentFolder.replace(/\/+$/, '').split('/').pop() ?? '';
  const [path, setPath] = useState(currentPath);
  const [name, setName] = useState(currentName);
  const [err, setErr] = useState<string | null>(null);
  const folders = useQuery({ queryKey: ['drive-folders'], queryFn: () => api.get<{ items: { name: string; isFolder: boolean }[] }>('/drive/folders'), retry: false });
  const pick = useMutation({
    mutationFn: () => api.put(`/clients/${clientId}`, { onedriveFolderPath: path.trim() || null }),
    onSuccess: onDone,
    onError: (e) => setErr((e as Error).message),
  });
  const rename = useMutation({
    mutationFn: () => api.post<{ from: string; to: string }>(`/clients/${clientId}/folder/rename`, { name: name.trim() }),
    onSuccess: onDone,
    onError: (e) => setErr((e as Error).message),
  });
  const busy = pick.isPending || rename.isPending;
  return (
    <div className="fade-in mb-3 space-y-2 rounded-md border border-blue-200 bg-blue-50/40 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-3" role="radiogroup" aria-label="フォルダの直し方">
        <label className="flex items-center gap-1">
          <input type="radio" name={`folder-mode-${clientId}`} checked={mode === 'rename'} onChange={() => setMode('rename')} disabled={!exists} /> フォルダ名を変更（OneDrive 上の名前も変える）
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" name={`folder-mode-${clientId}`} checked={mode === 'pick'} onChange={() => setMode('pick')} /> 別のフォルダを指定する
        </label>
      </div>
      {mode === 'rename' ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setErr(null);
            rename.mutate();
          }}
        >
          <input className="input min-w-0 flex-1" value={name} onChange={(e) => setName(e.target.value)} aria-label="新しいフォルダ名" maxLength={200} autoFocus />
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !name.trim() || name.trim() === currentName}>
            {rename.isPending ? '変更中…' : '名前を変える'}
          </button>
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            やめる
          </button>
          <div className="w-full text-xs text-slate-500">中のファイルはそのままです。保存済みファイルの場所の表示も新しい名前に付け替えます。</div>
        </form>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setErr(null);
            pick.mutate();
          }}
        >
          <input className="input min-w-0 flex-1" list={`client-folders-${clientId}`} value={path} onChange={(e) => setPath(e.target.value)} aria-label="依頼者フォルダのパス" placeholder="例: 1.進行事件/やまだ山田太郎_離婚（空なら氏名から自動）" autoFocus />
          <datalist id={`client-folders-${clientId}`}>{folders.data?.items.filter((i) => i.isFolder).map((i) => <option key={i.name} value={i.name} />)}</datalist>
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy || path.trim() === currentPath.trim()}>
            {pick.isPending ? '保存中…' : 'このフォルダにする'}
          </button>
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            やめる
          </button>
          <div className="w-full text-xs text-slate-500">OneDrive で名前を変えたあとに、アプリの指定を合わせるときはこちら。前のフォルダのファイルは移動しません。</div>
        </form>
      )}
      {err && <div className="text-xs text-red-600">{err}</div>}
    </div>
  );
}

/**
 * 氏名未確認の依頼者（紹介者からの代理相談など）。氏名が分かったら名前を確定するか、
 * すでに登録している依頼者だった場合はそちらにまとめる（事件・記録・会話などを引き継ぐ）
 */
function ProvisionalClientPanel({ clientId, name }: { clientId: number; name: string }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [newName, setNewName] = useState('');
  const [kana, setKana] = useState('');
  const [mergeInto, setMergeInto] = useState('');
  const [err, setErr] = useState('');
  const confirmName = useMutation({
    mutationFn: () => api.put(`/clients/${clientId}`, { name: newName.trim(), kana: kana.trim() || null, provisional: false }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['client', String(clientId)] });
      qc.invalidateQueries({ queryKey: ['clients'] });
      qc.invalidateQueries({ queryKey: ['cases'] });
    },
    onError: (e) => setErr((e as Error).message),
  });
  const merge = useMutation({
    mutationFn: () => api.post('/clients/merge', { keepId: Number(mergeInto), mergeIds: [clientId] }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      qc.invalidateQueries({ queryKey: ['cases'] });
      nav(`/clients/${mergeInto}`);
    },
    onError: (e) => setErr((e as Error).message),
  });
  return (
    <section className="card space-y-2 border-orange-200 bg-orange-50/50 text-sm">
      <div className="font-medium text-orange-900">当事者の氏名がまだ分かっていない依頼者です（「{name}」は仮の呼び名）</div>
      <div className="text-xs text-orange-800">氏名が分かったら、ここで確定してください。事件・記録はそのまま引き継がれます。</div>
      <div className="flex flex-wrap items-center gap-2">
        <input className="input w-48" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="氏名（例: 山田 太郎）" aria-label="確定する氏名" />
        <input className="input w-40" value={kana} onChange={(e) => setKana(e.target.value)} placeholder="読み（任意）" aria-label="読み" />
        <button type="button" className="btn btn-sm btn-primary" onClick={() => confirmName.mutate()} disabled={!newName.trim() || confirmName.isPending}>
          氏名を確定
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-600">すでに登録している依頼者だった場合:</span>
        <ClientPicker value={mergeInto} onChange={setMergeInto} emptyLabel="まとめ先の依頼者を選択…" selectClassName="w-56" />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => confirm('この依頼者の事件・記録・会話・タスクを、選んだ依頼者にまとめます。この仮の依頼者は消えます。よろしいですか？') && merge.mutate()}
          disabled={!mergeInto || mergeInto === String(clientId) || merge.isPending}
        >
          その依頼者にまとめる
        </button>
      </div>
      {err && <div className="text-xs text-red-600">{err}</div>}
    </section>
  );
}
