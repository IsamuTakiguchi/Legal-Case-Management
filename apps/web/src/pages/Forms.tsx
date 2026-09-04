import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, postSSE } from '../lib/api';
import { fmtDate, fmtBytes } from '../lib/format';

interface FormRow {
  id: number;
  name: string;
  path: string;
  webUrl: string | null;
  ext: string | null;
  modifiedAt: string | null;
  size: number | null;
  caseType: string | null;
  docType: string | null;
  source: string;
  hasText: number;
  extractError: string | null;
}

export default function Forms() {
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [caseType, setCaseType] = useState(params.get('caseType') ?? '');
  const [docType, setDocType] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [showDraft, setShowDraft] = useState(false);
  const types = useQuery({ queryKey: ['case-types'], queryFn: () => api.get<{ key: string; label: string }[]>('/case-types') });
  const stats = useQuery({ queryKey: ['forms-stats'], queryFn: () => api.get<{ total: number; byDocType: Record<string, number> }>('/forms/stats') });
  const list = useQuery({ queryKey: ['forms', q, caseType, docType], queryFn: () => api.get<FormRow[]>(`/forms?${new URLSearchParams({ q, caseType, docType }).toString()}`) });
  const index = useMutation({ mutationFn: () => api.post<{ scanned: number; indexed: number; errors: number }>('/forms/index'), onSuccess: () => { qc.invalidateQueries({ queryKey: ['forms'] }); qc.invalidateQueries({ queryKey: ['forms-stats'] }); } });
  const update = useMutation({ mutationFn: (v: { id: number; caseType?: string | null; docType?: string | null }) => api.put(`/forms/${v.id}`, v), onSuccess: () => qc.invalidateQueries({ queryKey: ['forms'] }) });
  const typeLabel = (k: string | null) => types.data?.find((t) => t.key === k)?.label ?? (k ?? '未分類');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">書式ライブラリ</h1>
        <span className="text-sm text-slate-500">{stats.data?.total ?? 0} 件</span>
        <button className="btn btn-sm ml-auto" onClick={() => index.mutate()} disabled={index.isPending}>
          {index.isPending ? '索引化中…' : 'OneDrive を再索引'}
        </button>
        {index.data && <span className="text-xs text-slate-500">走査 {index.data.scanned} / 更新 {index.data.indexed} / 失敗 {index.data.errors}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        <input className="input w-64" placeholder="本文・ファイル名で検索（3文字以上）" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input w-auto" value={caseType} onChange={(e) => setCaseType(e.target.value)}>
          <option value="">全類型</option>
          {types.data?.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
        <select className="input w-auto" value={docType} onChange={(e) => setDocType(e.target.value)}>
          <option value="">全文書種別</option>
          {Object.keys(stats.data?.byDocType ?? {}).map((d) => (
            <option key={d} value={d === '未分類' ? '' : d}>
              {d}
            </option>
          ))}
        </select>
        {selected.length > 0 && (
          <button className="btn btn-primary" onClick={() => setShowDraft(true)}>
            選択した {selected.length} 件を雛形に AI 下書き
          </button>
        )}
      </div>
      {showDraft && <DraftPanel templateIds={selected} caseId={params.get('caseId') ? Number(params.get('caseId')) : null} onClose={() => setShowDraft(false)} />}
      <div className="card p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-2 py-2"></th>
              <th className="px-2 py-2">ファイル</th>
              <th className="px-2 py-2">類型</th>
              <th className="px-2 py-2">文書種別</th>
              <th className="px-2 py-2">元</th>
              <th className="px-2 py-2">更新</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((f) => (
              <tr key={f.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-2 py-2">
                  <input type="checkbox" checked={selected.includes(f.id)} disabled={!selected.includes(f.id) && selected.length >= 3} onChange={(e) => setSelected(e.target.checked ? [...selected, f.id] : selected.filter((x) => x !== f.id))} />
                </td>
                <td className="px-2 py-2">
                  {f.webUrl ? (
                    <a href={f.webUrl} target="_blank" rel="noreferrer" className="font-medium text-blue-700 hover:underline">
                      {f.name}
                    </a>
                  ) : (
                    <span className="font-medium">{f.name}</span>
                  )}
                  <div className="text-xs text-slate-400">
                    {f.path} {fmtBytes(f.size)} {!f.hasText && <span className="text-orange-600">本文未抽出</span>}
                  </div>
                </td>
                <td className="px-2 py-2">
                  <select className="input w-auto py-0.5 text-xs" value={f.caseType ?? ''} onChange={(e) => update.mutate({ id: f.id, caseType: e.target.value || null })}>
                    <option value="">未分類</option>
                    {types.data?.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-2">
                  <input className="input w-28 py-0.5 text-xs" defaultValue={f.docType ?? ''} onBlur={(e) => e.target.value !== (f.docType ?? '') && update.mutate({ id: f.id, docType: e.target.value || null })} />
                </td>
                <td className="px-2 py-2 text-xs text-slate-500">{f.source === 'library' ? '書式フォルダ' : '依頼者フォルダ'}</td>
                <td className="px-2 py-2 text-xs text-slate-500">{fmtDate(f.modifiedAt)}</td>
              </tr>
            ))}
            {list.data?.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-4 text-slate-500">
                  書式が見つかりません。設定で書式フォルダのパスを確認し「OneDrive を再索引」を実行してください。{' '}
                  {typeLabel(caseType)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DraftPanel({ templateIds, caseId, onClose }: { templateIds: number[]; caseId: number | null; onClose: () => void }) {
  const cases = useQuery({ queryKey: ['cases', 'active'], queryFn: () => api.get<{ id: number; title: string; clientName: string }[]>('/cases?status=active') });
  const [selCase, setSelCase] = useState<string>(caseId ? String(caseId) : '');
  const [title, setTitle] = useState('');
  const [instruction, setInstruction] = useState('');
  const [facts, setFacts] = useState('');
  const [anon, setAnon] = useState(true);
  const [save, setSave] = useState(true);
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ filename: string; savedPath?: string; webUrl?: string; docxBase64: string } | null>(null);
  const [err, setErr] = useState('');
  const run = async () => {
    setBusy(true);
    setOut('');
    setDone(null);
    setErr('');
    await postSSE(
      '/forms/draft',
      { templateIds, caseId: selCase ? Number(selCase) : null, title: title || undefined, instruction, facts, anonymizeSources: anon, saveToClientFolder: save },
      {
        onDelta: (t) => setOut((p) => p + t),
        onDone: (d) => setDone(d as unknown as typeof done),
        onError: (m) => setErr(m),
      },
    );
    setBusy(false);
  };
  const download = () => {
    if (!done) return;
    const bin = atob(done.docxBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = done.filename;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="card space-y-2 text-sm">
      <div className="flex items-center">
        <h2 className="font-semibold">書式を雛形に AI 下書き（Word）</h2>
        <button className="btn btn-sm ml-auto" onClick={onClose}>
          閉じる
        </button>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <select className="input" value={selCase} onChange={(e) => setSelCase(e.target.value)}>
          <option value="">事件を選択（依頼者フォルダに保存する場合）</option>
          {cases.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.clientName} / {c.title}
            </option>
          ))}
        </select>
        <input className="input" placeholder="書面の題名（例: 答弁書）" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="input md:col-span-2" rows={4} placeholder="事実関係・書きたい内容（当事者、経緯、主張したい点）" value={facts} onChange={(e) => setFacts(e.target.value)} />
        <textarea className="input md:col-span-2" rows={2} placeholder="指示（例: 請求棄却を求める答弁書。争点は消滅時効。）" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={anon} onChange={(e) => setAnon(e.target.checked)} /> 参考書式の個人情報を伏字化して AI に渡す
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> 依頼者フォルダの「下書き」に保存
        </label>
        <button className="btn btn-primary ml-auto" onClick={run} disabled={busy}>
          {busy ? '生成中…' : '下書きを生成'}
        </button>
      </div>
      {err && <div className="text-red-600">{err}</div>}
      {(out || done) && (
        <div className="space-y-2">
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 p-3 font-sans text-sm">{done ? (done as unknown as { text?: string }).text ?? out : out}</pre>
          {done && (
            <div className="flex items-center gap-2">
              <button className="btn" onClick={download}>
                Word をダウンロード
              </button>
              {done.savedPath && <span className="text-xs text-slate-600">保存先: {done.savedPath}</span>}
              {done.webUrl && (
                <a className="text-xs text-blue-700 hover:underline" href={done.webUrl} target="_blank" rel="noreferrer">
                  OneDrive で開く
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
