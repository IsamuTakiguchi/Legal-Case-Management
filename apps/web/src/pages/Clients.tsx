import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useDraftRecord, clearDraft, DraftHint } from '../lib/draft';
import { LineFriendPicker } from '../lib/LineFriendPicker';
import { CHANNEL_LABEL } from '@lcm/shared';
import { useSort, readingKey, SortHeader, type SortOption } from '../lib/sort';

const CLIENT_SORTS: SortOption<ClientRow>[] = [
  { key: 'reading', label: 'あいうえお順', value: (c) => readingKey(c.kana, c.name) },
  { key: 'name', label: '氏名', value: (c) => c.name },
  { key: 'folder', label: 'フォルダ', value: (c) => c.onedriveFolderPath ?? null },
  { key: 'updated', label: '更新が新しい順', value: (c) => c.updatedAt ?? null, desc: true },
];

export interface ClientRow {
  id: number;
  name: string;
  kana: string | null;
  aliases: string[];
  emails: string[];
  lineUserId: string | null;
  chatworkRoomId: number | null;
  chatworkAccountId: number | null;
  onedriveFolderPath: string | null;
  preferredChannel: string | null;
  notes: string | null;
  updatedAt?: string;
}

export default function Clients() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [showNew, setShowNew] = useState(params.has('new'));
  const [showImport, setShowImport] = useState(false);
  const list = useQuery({ queryKey: ['clients', q], queryFn: () => api.get<ClientRow[]>(`/clients${q ? `?q=${encodeURIComponent(q)}` : ''}`) });
  const create = useMutation({
    mutationFn: (body: Partial<ClientRow>) => api.post<ClientRow>('/clients', body),
    onSuccess: (c) => {
      clearDraft(clientFormDraftKey(null));
      qc.invalidateQueries({ queryKey: ['clients'] });
      nav(`/clients/${c.id}`);
    },
  });
  const [selected, setSelected] = useState<number[]>([]);
  const bulkDelete = useMutation({
    mutationFn: () => api.post<{ deleted: number }>('/clients/bulk-delete', { ids: selected }),
    onSuccess: () => {
      setSelected([]);
      qc.invalidateQueries({ queryKey: ['clients'] });
      qc.invalidateQueries({ queryKey: ['cases'] });
    },
  });
  const [showMerge, setShowMerge] = useState(false);
  const [folderMsg, setFolderMsg] = useState('');
  // OneDrive 側でフォルダ名を変えたとき、アプリ側の紐付けを付け直す
  const syncFolders = useMutation({
    mutationFn: () => api.post<{ checked: number; renamed: number; adopted: number; renames: { clientName: string; from: string; to: string }[] }>('/clients/folders/sync-names'),
    onSuccess: (r) => {
      setFolderMsg(
        r.renamed > 0
          ? `${r.renamed} 件のフォルダ名の変更を取り込みました: ${r.renames.map((x) => `${x.clientName}（${x.from} → ${x.to}）`).join('、')}`
          : `変更はありませんでした（${r.checked} 件を確認${r.adopted ? `、${r.adopted} 件のフォルダを新たに覚えました` : ''}）`,
      );
      qc.invalidateQueries({ queryKey: ['clients'] });
    },
    onError: (e) => setFolderMsg((e as Error).message),
  });
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const sort = useSort('clients', CLIENT_SORTS, 'reading');
  const rows = sort.apply(list.data ?? []);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">依頼者</h1>
        <input className="input md:ml-auto md:w-64" placeholder="名前・かなで検索" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input w-auto" value={sort.key} onChange={(e) => sort.setKey(e.target.value)} aria-label="並べ替え">
          {CLIENT_SORTS.map((o) => (
            <option key={o.key} value={o.key}>
              並べ替え: {o.label}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => setShowImport(!showImport)}>
          一括登録（フォルダ / Chatwork）
        </button>
        <button className="btn" onClick={() => syncFolders.mutate()} disabled={syncFolders.isPending} title="OneDrive でフォルダ名を変えた・別の区分へ移した場合に、アプリ側の紐付けを付け直します">
          {syncFolders.isPending ? '確認中…' : 'フォルダ名の変更を取り込む'}
        </button>
        <button className="btn" onClick={() => setShowMerge(!showMerge)} title="同じ名前で二重に登録した依頼者を 1 件にまとめます">
          重複の統合
        </button>
        <button className="btn btn-primary" onClick={() => setShowNew(!showNew)}>
          ＋ 新規依頼者
        </button>
      </div>
      {folderMsg && <div className="fade-in card text-sm text-slate-700">{folderMsg}</div>}
      {selected.length > 0 && (
        <div className="card flex flex-wrap items-center gap-2 border-red-200 bg-red-50 text-sm">
          <span>{selected.length} 件を選択中</span>
          <button
            className="btn btn-danger btn-sm"
            onClick={() => {
              if (confirm(`選択した ${selected.length} 件の依頼者を削除します。事件・ノート・タスクも削除されます（会話とファイルは残り、紐付けだけ外れます）。よろしいですか？`)) bulkDelete.mutate();
            }}
            disabled={bulkDelete.isPending}
          >
            選択した依頼者を削除
          </button>
          <button className="btn btn-sm" onClick={() => setSelected([])}>
            選択解除
          </button>
        </div>
      )}
      {showImport && <BulkImport onDone={() => { setShowImport(false); qc.invalidateQueries({ queryKey: ['clients'] }); }} />}
      {showMerge && <MergeDuplicates onDone={() => { qc.invalidateQueries({ queryKey: ['clients'] }); qc.invalidateQueries({ queryKey: ['cases'] }); }} />}
      {showNew && <ClientForm initial={{ name: params.get('new') ?? '', emails: params.get('email') ? [params.get('email')!] : [], lineUserId: params.get('line') || null, ...(params.get('line') ? { preferredChannel: 'line' } : {}) }} onSubmit={(b) => create.mutate(b)} onCancel={() => setShowNew(false)} busy={create.isPending} />}
      <div className="card p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2">
                <input type="checkbox" checked={!!list.data?.length && selected.length === list.data.length} onChange={(e) => setSelected(e.target.checked ? (list.data ?? []).map((c) => c.id) : [])} aria-label="すべて選択" />
              </th>
              <th className="px-4 py-2">
                <SortHeader label="氏名" sortKey="reading" current={sort.key} desc={sort.desc} onClick={sort.setKey} />
              </th>
              <th className="px-4 py-2">連絡手段</th>
              <th className="px-4 py-2">
                <SortHeader label="フォルダ" sortKey="folder" current={sort.key} desc={sort.desc} onClick={sort.setKey} />
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2">
                  <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} aria-label={`${c.name} を選択`} />
                </td>
                <td className="px-4 py-2">
                  <Link to={`/clients/${c.id}`} className="font-medium text-blue-700 hover:underline">
                    {c.name}
                  </Link>
                  {c.kana && <span className="ml-2 text-xs text-slate-500">{c.kana}</span>}
                </td>
                <td className="px-4 py-2 text-xs">
                  {c.emails.length > 0 && <span className="badge badge-gmail mr-1">Gmail</span>}
                  {c.lineUserId && <span className="badge badge-line mr-1">LINE</span>}
                  {c.chatworkRoomId && <span className="badge badge-chatwork mr-1">Chatwork</span>}
                  {c.preferredChannel && <span className="text-slate-500">主: {CHANNEL_LABEL[c.preferredChannel as keyof typeof CHANNEL_LABEL]}</span>}
                </td>
                <td className="px-4 py-2 text-xs text-slate-500">{c.onedriveFolderPath ?? `（氏名と同名）`}</td>
              </tr>
            ))}
            {list.data?.length === 0 && (
              <tr>
                <td className="px-4 py-4 text-slate-500" colSpan={4}>
                  依頼者がまだ登録されていません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 新規・編集フォームの下書きキー（保存できたら親から clearDraft で消す） */
export const clientFormDraftKey = (id?: number | null) => `client:${id ?? 'new'}:form`;

export function ClientForm({ initial, onSubmit, onCancel, busy }: { initial: Partial<ClientRow>; onSubmit: (b: Partial<ClientRow>) => void; onCancel: () => void; busy?: boolean }) {
  const base = { aliases: [], emails: [], ...initial } as Partial<ClientRow>;
  const [f, setF] = useState<Partial<ClientRow>>(base);
  // 入力途中の内容を自動保存する（保存前に画面を離れても消えない）
  const draft = useDraftRecord(clientFormDraftKey(initial.id), f as Record<string, unknown>, (v) => setF(v as Partial<ClientRow>), base as Record<string, unknown>);
  const folders = useQuery({ queryKey: ['drive-folders'], queryFn: () => api.get<{ path: string; items: { name: string; isFolder: boolean }[] }>('/drive/folders'), retry: false });
  const set = (k: keyof ClientRow, v: unknown) => setF({ ...f, [k]: v });
  return (
    <form
      className="card grid gap-3 md:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(f);
      }}
    >
      <div>
        <label className="label">氏名（必須）</label>
        <input className="input" required value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} />
      </div>
      <div>
        <label className="label">かな</label>
        <input className="input" value={f.kana ?? ''} onChange={(e) => set('kana', e.target.value)} />
      </div>
      <div>
        <label className="label">別名（カレンダーの表記など・カンマ区切り）</label>
        <input className="input" value={(f.aliases ?? []).join(', ')} onChange={(e) => set('aliases', e.target.value.split(/[,、]/).map((s) => s.trim()).filter(Boolean))} />
      </div>
      <div>
        <label className="label">メールアドレス（カンマ区切り）</label>
        <input className="input" value={(f.emails ?? []).join(', ')} onChange={(e) => set('emails', e.target.value.split(/[,、\s]+/).map((s) => s.trim()).filter(Boolean))} />
      </div>
      <div>
        <label className="label">Chatwork ルーム ID</label>
        <input className="input" type="number" value={f.chatworkRoomId ?? ''} onChange={(e) => set('chatworkRoomId', e.target.value ? Number(e.target.value) : null)} />
      </div>
      <div>
        <label className="label">LINE公式の友だち（一覧から選ぶ。受信があれば自動でも紐付きます）</label>
        <LineFriendPicker value={f.lineUserId ?? null} onChange={(v) => set('lineUserId', v)} clientId={f.id ?? null} />
      </div>
      <div>
        <label className="label">依頼者フォルダ（OneDrive の依頼者ルート配下。空なら氏名と同名）</label>
        <input className="input" list="folder-list" value={f.onedriveFolderPath ?? ''} onChange={(e) => set('onedriveFolderPath', e.target.value || null)} placeholder="例: 山田太郎_離婚" />
        <datalist id="folder-list">{folders.data?.items.filter((i) => i.isFolder).map((i) => <option key={i.name} value={i.name} />)}</datalist>
      </div>
      <div>
        <label className="label">主な連絡手段</label>
        <select className="input" value={f.preferredChannel ?? ''} onChange={(e) => set('preferredChannel', e.target.value || null)}>
          <option value="">未設定</option>
          <option value="line">LINE公式</option>
          <option value="chatwork">Chatwork</option>
          <option value="gmail">Gmail</option>
        </select>
      </div>
      <div className="md:col-span-2">
        <label className="label">メモ</label>
        <textarea className="input" rows={2} value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
      </div>
      <div className="flex items-center gap-2 md:col-span-2">
        <button className="btn btn-primary" disabled={busy}>
          保存
        </button>
        <DraftHint handle={draft} />
        <button type="button" className="btn" onClick={onCancel}>
          キャンセル
        </button>
      </div>
    </form>
  );
}

interface Candidate {
  source: 'onedrive' | 'chatwork';
  name: string;
  folderPath?: string;
  chatworkRoomId?: number;
  existingClientId?: number | null;
  note?: string;
  caseStatus?: string | null;
  caseTitle?: string | null;
  caseType?: string | null;
  kana?: string | null;
}

const CASE_STATUS_JA: Record<string, string> = { consultation: '相談', active: '進行事件', wrapup: '残務処理', closed: '終了事件' };

function BulkImport({ onDone }: { onDone: () => void }) {
  const [source, setSource] = useState<'onedrive' | 'chatwork'>('onedrive');
  const [rows, setRows] = useState<(Candidate & { checked: boolean })[]>([]);
  const [msg, setMsg] = useState('');
  const load = useMutation({
    mutationFn: () => api.get<Candidate[]>(`/clients/import/candidates?source=${source}`),
    onSuccess: (r) => {
      setRows(r.map((c) => ({ ...c, checked: !c.existingClientId })));
      setMsg(r.length === 0 ? '候補が見つかりませんでした' : '');
    },
    onError: (e) => setMsg((e as Error).message),
  });
  const [withCases, setWithCases] = useState(true);
  const apply = useMutation({
    mutationFn: () =>
      api.post<{ created: number; updated: number; casesCreated: number }>(
        '/clients/import',
        rows
          .filter((r) => r.checked)
          .map(({ name, folderPath, chatworkRoomId, existingClientId, caseStatus, caseTitle, caseType, kana }) => ({ name, folderPath, chatworkRoomId, existingClientId, caseStatus: withCases ? caseStatus : null, caseTitle, caseType, kana })),
      ),
    onSuccess: (r) => {
      setMsg(`依頼者 ${r.created} 件を登録、既存 ${r.updated} 件を更新、事件 ${r.casesCreated} 件を作成しました`);
      onDone();
    },
    onError: (e) => setMsg((e as Error).message),
  });
  const hasStatus = rows.some((r) => r.caseStatus);
  return (
    <div className="card space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">一括登録</span>
        <select className="input w-auto" value={source} onChange={(e) => setSource(e.target.value as 'onedrive' | 'chatwork')}>
          <option value="onedrive">OneDrive の依頼者フォルダ名から</option>
          <option value="chatwork">Chatwork のルームから</option>
        </select>
        <button className="btn btn-sm" onClick={() => load.mutate()} disabled={load.isPending}>
          {load.isPending ? '読み込み中…' : '候補を読み込む'}
        </button>
        {rows.length > 0 && (
          <button className="btn btn-primary btn-sm ml-auto" onClick={() => apply.mutate()} disabled={apply.isPending || rows.every((r) => !r.checked)}>
            選択した {rows.filter((r) => r.checked).length} 件を登録
          </button>
        )}
      </div>
      <div className="text-xs text-slate-500">フォルダ名やルーム名から氏名を推定します。氏名は登録前に編集できます。既に登録済みの依頼者にはフォルダ／ルームだけを紐付けます。</div>
      {hasStatus && (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={withCases} onChange={(e) => setWithCases(e.target.checked)} />
          区分フォルダ（相談／進行事件／残務処理／終了事件）に合わせて、フォルダ名を事件名にした事件も同時に作る（事件がまだ無い依頼者のみ）
        </label>
      )}
      {msg && <div className="fade-in text-xs text-slate-700">{msg}</div>}
      {rows.length > 0 && (
        <div className="max-h-80 overflow-y-auto rounded border border-slate-200">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-2 py-1">
                  <input type="checkbox" checked={rows.every((r) => r.checked)} onChange={(e) => setRows(rows.map((r) => ({ ...r, checked: e.target.checked })))} />
                </th>
                <th className="px-2 py-1">氏名（編集可）</th>
                <th className="px-2 py-1">{source === 'onedrive' ? 'フォルダ' : 'ルーム'}</th>
                {hasStatus && <th className="px-2 py-1">区分</th>}
                <th className="px-2 py-1">状態</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="px-2 py-1">
                    <input type="checkbox" checked={r.checked} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, checked: e.target.checked } : x)))} />
                  </td>
                  <td className="px-2 py-1">
                    <input className="input py-0.5" value={r.name} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  </td>
                  <td className="px-2 py-1 text-slate-600">{r.folderPath ?? r.note}</td>
                  {hasStatus && <td className="px-2 py-1 text-slate-600">{r.caseStatus ? CASE_STATUS_JA[r.caseStatus] ?? r.caseStatus : <span className="text-slate-400">（事件は作らない）</span>}</td>}
                  <td className="px-2 py-1">{r.existingClientId ? <span className="badge badge-gray">登録済（紐付けのみ）</span> : <span className="badge badge-blue">新規</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- 同じ名前の依頼者を 1 件に統合 ----

interface MergeCandidate {
  id: number;
  name: string;
  kana: string | null;
  emails: string[];
  lineUserId: string | null;
  chatworkRoomId: number | null;
  onedriveFolderPath: string | null;
  createdAt: string;
  updatedAt: string;
  counts: { cases: number; conversations: number; messages: number; tasks: number; notes: number; attachments: number; events: number };
}

interface DuplicateGroup {
  key: string;
  name: string;
  clients: MergeCandidate[];
  suggestedKeepId: number;
}

interface MergeResult {
  keepId: number;
  mergedIds: number[];
  moved: { cases: number; conversations: number; messages: number; tasks: number; notes: number; attachments: number; events: number };
  conflicts: string[];
}

function MergeDuplicates({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const dups = useQuery({ queryKey: ['client-duplicates'], queryFn: () => api.get<DuplicateGroup[]>('/clients/duplicates') });
  const [keep, setKeep] = useState<Record<string, number>>({});
  const [msg, setMsg] = useState('');
  const merge = useMutation({
    mutationFn: (v: { keepId: number; mergeIds: number[] }) => api.post<MergeResult>('/clients/merge', v),
    onSuccess: (r) => {
      const m = r.moved;
      setMsg(
        `統合しました（事件 ${m.cases} 件、会話 ${m.conversations} 件、タスク ${m.tasks} 件、記録 ${m.notes} 件、ファイル ${m.attachments} 件を引き継ぎ）` +
          (r.conflicts.length ? `\n※ ${r.conflicts.join('\n※ ')}` : ''),
      );
      qc.invalidateQueries({ queryKey: ['client-duplicates'] });
      onDone();
    },
    onError: (e) => setMsg((e as Error).message),
  });
  const groups = dups.data ?? [];
  return (
    <section className="card space-y-3 text-sm">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">重複の統合</h2>
        <button className="btn btn-sm ml-auto" onClick={() => dups.refetch()} disabled={dups.isFetching}>
          {dups.isFetching ? '確認中…' : '再確認'}
        </button>
      </div>
      <p className="text-xs text-slate-500">
        名前が同じ依頼者（空白や全角半角の違いは無視）を探します。残す依頼者を選んで統合すると、もう一方の事件・会話・タスク・記録・受信ファイル・予定がすべて残す側に付け替わります。OneDrive のフォルダは自動では統合しません（別のフォルダがある場合はお知らせします）。
      </p>
      {msg && <div className="fade-in whitespace-pre-wrap rounded border border-blue-200 bg-blue-50 p-2 text-slate-700">{msg}</div>}
      {dups.isLoading && <div className="loading-text text-slate-500">確認中…</div>}
      {!dups.isLoading && groups.length === 0 && <div className="text-slate-500">同じ名前の依頼者は見つかりませんでした。</div>}
      {groups.map((g) => {
        const keepId = keep[g.key] ?? g.suggestedKeepId;
        const mergeIds = g.clients.filter((c) => c.id !== keepId).map((c) => c.id);
        return (
          <div key={g.key} className="rounded border border-slate-200 p-2">
            <div className="mb-1 font-semibold">{g.name}（{g.clients.length} 件）</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-slate-500">
                  <tr>
                    <th className="py-1 pr-2">残す</th>
                    <th className="py-1 pr-2">名前 / かな</th>
                    <th className="py-1 pr-2">事件</th>
                    <th className="py-1 pr-2">会話</th>
                    <th className="py-1 pr-2">タスク</th>
                    <th className="py-1 pr-2">記録</th>
                    <th className="py-1 pr-2">ファイル</th>
                    <th className="py-1 pr-2">連絡先</th>
                    <th className="py-1 pr-2">フォルダ</th>
                  </tr>
                </thead>
                <tbody>
                  {g.clients.map((c) => (
                    <tr key={c.id} className={c.id === keepId ? 'bg-blue-50' : ''}>
                      <td className="py-1 pr-2">
                        <input type="radio" name={`keep-${g.key}`} checked={c.id === keepId} onChange={() => setKeep({ ...keep, [g.key]: c.id })} aria-label={`${c.name} を残す`} />
                      </td>
                      <td className="py-1 pr-2">
                        <Link to={`/clients/${c.id}`} className="text-blue-700 hover:underline">
                          {c.name}
                        </Link>
                        {c.kana && <span className="ml-1 text-slate-500">{c.kana}</span>}
                        <span className="ml-1 text-slate-400">ID {c.id}</span>
                      </td>
                      <td className="py-1 pr-2">{c.counts.cases}</td>
                      <td className="py-1 pr-2">{c.counts.conversations}</td>
                      <td className="py-1 pr-2">{c.counts.tasks}</td>
                      <td className="py-1 pr-2">{c.counts.notes}</td>
                      <td className="py-1 pr-2">{c.counts.attachments}</td>
                      <td className="py-1 pr-2">
                        {[c.emails.join(' '), c.lineUserId ? 'LINE' : '', c.chatworkRoomId ? `CW ${c.chatworkRoomId}` : ''].filter(Boolean).join(' / ') || '—'}
                      </td>
                      <td className="py-1 pr-2 text-slate-500">{c.onedriveFolderPath ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              className="btn btn-primary btn-sm mt-2"
              disabled={merge.isPending || mergeIds.length === 0}
              onClick={() => {
                const names = g.clients.filter((c) => mergeIds.includes(c.id)).map((c) => `${c.name}（ID ${c.id}）`).join('、');
                const target = g.clients.find((c) => c.id === keepId);
                if (confirm(`${names} を ${target?.name}（ID ${keepId}）に統合します。事件・会話・タスク・記録・ファイルは残す側に移り、統合した依頼者は削除されます。よろしいですか？`)) {
                  merge.mutate({ keepId, mergeIds });
                }
              }}
            >
              {merge.isPending ? '統合中…' : 'この組を統合する'}
            </button>
          </div>
        );
      })}
    </section>
  );
}
