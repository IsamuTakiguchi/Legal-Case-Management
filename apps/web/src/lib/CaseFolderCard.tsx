import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export interface CaseFolderInfo {
  /** 実際に使うフォルダ（依頼者ルートからの相対） */
  rel: string;
  /** OneDrive 上のパス */
  path: string;
  /** この事件のフォルダが決まっているか（false なら依頼者フォルダを使っている） */
  own: boolean;
  /** 新しく作るときのフォルダ（「1.進行事件/や 山田花子　離婚」など） */
  suggested: string;
}

interface Listing {
  sub: string;
  parent: string | null;
  folders: { name: string; path: string; sub: string }[];
  files: { name: string; path: string; modifiedAt?: string }[];
}

const lastName = (rel: string) => rel.replace(/\/+$/, '').split('/').pop() ?? rel;

/**
 * 事件の OneDrive フォルダ。「や 山田花子 離婚」のように事件ごとにフォルダを分けていれば、その事件のフォルダを指定・作成する。
 * 受信ファイル・送付ファイル・書面の下書き・期日連絡の書面候補は、この事件のフォルダを使う（決まっていなければ依頼者フォルダ）
 */
export function CaseFolderCard({ caseId, clientId, folder }: { caseId: number; clientId: number; folder: CaseFolderInfo }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<null | 'pick' | 'create'>(null);
  const [path, setPath] = useState(folder.own ? folder.rel : '');
  const [name, setName] = useState(lastName(folder.suggested));
  const [sub, setSub] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const folders = useQuery({ queryKey: ['drive-folders'], queryFn: () => api.get<{ items: { name: string; isFolder: boolean }[] }>('/drive/folders'), retry: false, enabled: mode === 'pick' });
  const list = useQuery({
    queryKey: ['case-folder-list', caseId, folder.rel, sub],
    queryFn: () => api.get<Listing>(`/clients/${clientId}/folder?caseId=${caseId}&sub=${encodeURIComponent(sub)}`),
    retry: false,
  });
  const refresh = (text: string) => {
    setMode(null);
    setSub('');
    setMsg({ kind: 'ok', text });
    qc.invalidateQueries({ queryKey: ['case', String(caseId)] });
    qc.invalidateQueries({ queryKey: ['case-folder-list', caseId] });
  };
  const pick = useMutation({
    mutationFn: (p: string | null) => api.put<{ path: string | null }>(`/cases/${caseId}/folder`, { path: p }),
    onSuccess: (r) => refresh(r.path ? `この事件のフォルダを「${r.path}」にしました` : '依頼者フォルダを使うように戻しました'),
    onError: (e) => setMsg({ kind: 'err', text: (e as Error).message }),
  });
  const create = useMutation({
    mutationFn: () => api.post<{ path: string }>(`/cases/${caseId}/folder`, { name: name.trim() || null }),
    onSuccess: (r) => refresh(`OneDrive に「${r.path}」を作り、この事件のフォルダにしました`),
    onError: (e) => setMsg({ kind: 'err', text: (e as Error).message }),
  });
  return (
    <section className="card space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">事件フォルダ</h2>
        {!folder.own && <span className="badge badge-gray">依頼者フォルダを使用</span>}
      </div>
      <div className="break-all text-xs text-slate-600" title={folder.path}>
        📁 {folder.rel || '（未設定）'}
      </div>
      <div className="flex flex-wrap gap-1">
        <button className="btn btn-sm" onClick={() => setMode(mode === 'pick' ? null : 'pick')}>
          既存のフォルダを指定
        </button>
        <button className="btn btn-sm" onClick={() => setMode(mode === 'create' ? null : 'create')}>
          この事件のフォルダを作る
        </button>
        {folder.own && (
          <button className="btn btn-sm" disabled={pick.isPending} onClick={() => pick.mutate(null)} title="この事件専用のフォルダをやめ、依頼者フォルダを使います（OneDrive のフォルダは消しません）">
            依頼者フォルダに戻す
          </button>
        )}
      </div>
      {mode === 'pick' && (
        <div className="fade-in space-y-1 rounded border border-blue-200 bg-blue-50/40 p-2">
          <input className="input w-full min-w-0" list={`case-folders-${caseId}`} value={path} onChange={(e) => setPath(e.target.value)} placeholder="例: 1.進行事件/や 山田花子　離婚" aria-label="事件フォルダのパス" autoFocus />
          <datalist id={`case-folders-${caseId}`}>
            {folders.data?.items.filter((i) => i.isFolder).map((i) => <option key={i.name} value={i.name} />)}
          </datalist>
          <div className="flex items-center gap-2">
            <button className="btn btn-primary btn-sm" disabled={!path.trim() || pick.isPending} onClick={() => pick.mutate(path.trim())}>
              このフォルダにする
            </button>
            <span className="text-xs text-slate-500">区分フォルダの中のフォルダから選べます</span>
          </div>
        </div>
      )}
      {mode === 'create' && (
        <div className="fade-in space-y-1 rounded border border-blue-200 bg-blue-50/40 p-2">
          <input className="input w-full min-w-0" value={name} onChange={(e) => setName(e.target.value)} aria-label="新しいフォルダの名前" autoFocus />
          <div className="text-xs text-slate-500">作る場所: {folder.suggested.includes('/') ? folder.suggested.split('/').slice(0, -1).join('/') : '依頼者ルート直下'}（事件の区分のフォルダ）</div>
          <button className="btn btn-primary btn-sm" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? '作成中…' : 'OneDrive に作る'}
          </button>
        </div>
      )}
      {msg && <div className={`fade-in text-xs ${msg.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}>{msg.text}</div>}
      <div className="max-h-56 overflow-y-auto rounded border border-slate-100 p-1 text-xs">
        {sub && (
          <button className="text-blue-700 hover:underline" onClick={() => setSub(list.data?.parent ?? '')}>
            ↑ 上へ
          </button>
        )}
        {list.isLoading && <div className="loading-text text-slate-500">読み込み中…</div>}
        {list.error && <div className="text-slate-500">フォルダはまだありません（最初のファイルを保存するときに作られます）</div>}
        {list.data?.folders.map((f) => (
          <div key={f.path}>
            <button className="text-blue-700 hover:underline" onClick={() => setSub(f.sub)}>
              📁 {f.name}
            </button>
          </div>
        ))}
        {list.data?.files.map((f) => (
          <div key={f.path} className="truncate text-slate-700">
            📄 {f.name}
          </div>
        ))}
        {list.data && !list.data.folders.length && !list.data.files.length && <div className="text-slate-400">空です</div>}
      </div>
      <div className="text-xs text-slate-400">受信ファイル・送付ファイル・書面の下書き・期日連絡の書面候補は、この事件のフォルダを使います。事件の区分を変えると、フォルダも区分フォルダ間で移ります。</div>
    </section>
  );
}
