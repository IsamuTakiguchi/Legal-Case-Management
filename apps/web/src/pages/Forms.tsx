import { useState } from 'react';
import { InstructionBox } from '../lib/InstructionBox';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useDraftGroup, DraftHint } from '../lib/draft';
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
  detectedAt?: string | null;
  hasText: number;
  extractError: string | null;
}

/** OneDrive に新しくできたファイルから見つけた書式の候補 */
interface Candidate {
  id: number;
  name: string;
  path: string;
  webUrl: string | null;
  modifiedAt: string | null;
  size: number | null;
  caseType: string | null;
  docType: string | null;
  clientName: string | null;
  detectedAt: string | null;
  hasText: number;
  excerpt: string | null;
}

const SOURCE_LABEL: Record<string, string> = { library: '書式フォルダ', client_folder: '依頼者フォルダ', detected: '新しいファイル' };

export default function Forms() {
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [caseType, setCaseType] = useState(params.get('caseType') ?? '');
  const [docType, setDocType] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [showDraft, setShowDraft] = useState(false);
  const types = useQuery({ queryKey: ['case-types'], queryFn: () => api.get<{ key: string; label: string }[]>('/case-types') });
  const stats = useQuery({ queryKey: ['forms-stats'], queryFn: () => api.get<{ total: number; byDocType: Record<string, number>; candidates?: number }>('/forms/stats') });
  const list = useQuery({ queryKey: ['forms', q, caseType, docType], queryFn: () => api.get<FormRow[]>(`/forms?${new URLSearchParams({ q, caseType, docType }).toString()}`) });
  const index = useMutation({ mutationFn: () => api.post<{ scanned: number; indexed: number; errors: number }>('/forms/index'), onSuccess: () => { qc.invalidateQueries({ queryKey: ['forms'] }); qc.invalidateQueries({ queryKey: ['forms-stats'] }); } });
  const update = useMutation({ mutationFn: (v: { id: number; caseType?: string | null; docType?: string | null }) => api.put(`/forms/${v.id}`, v), onSuccess: () => qc.invalidateQueries({ queryKey: ['forms'] }) });
  // ライブラリから外す（もう候補にも出さない。OneDrive のファイルはそのまま）
  const remove = useMutation({
    mutationFn: (id: number) => api.post(`/forms/${id}/dismiss`),
    onSuccess: (_r, id) => {
      setSelected((s) => s.filter((x) => x !== id));
      qc.invalidateQueries({ queryKey: ['forms'] });
      qc.invalidateQueries({ queryKey: ['forms-stats'] });
    },
  });
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
      <FormCandidates types={types.data ?? []} />
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
                <td className="px-2 py-2 text-xs text-slate-500">
                  {SOURCE_LABEL[f.source] ?? f.source}
                  {f.source === 'detected' && <div className="text-slate-400">{f.detectedAt ? `${fmtDate(f.detectedAt)} 自動追加` : '自動追加'}</div>}
                </td>
                <td className="px-2 py-2 text-xs text-slate-500">
                  {fmtDate(f.modifiedAt)}
                  <div>
                    <button
                      type="button"
                      className="text-slate-400 hover:text-red-600 hover:underline"
                      onClick={() => confirm(`「${f.name}」を書式ライブラリから外しますか？（OneDrive のファイルはそのまま残ります）`) && remove.mutate(f.id)}
                      title="書式ライブラリから外します。もう候補にも出しません（OneDrive のファイルは消しません）"
                    >
                      外す
                    </button>
                  </div>
                </td>
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

/**
 * OneDrive（依頼者フォルダ）に新しくできたファイルから見つけた、書式の候補。
 * 文書種別がファイル名から分かる Word・Excel は自動でライブラリに入るので、ここに出るのはそれ以外（確認してから追加する）
 */
function FormCandidates({ types }: { types: { key: string; label: string }[] }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['form-candidates'], queryFn: () => api.get<Candidate[]>('/forms/candidates') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Record<string, string>>('/settings') });
  const [open, setOpen] = useState(true);
  // 追加する前に直した類型・文書種別
  const [edits, setEdits] = useState<Record<number, { caseType?: string | null; docType?: string | null }>>({});
  const [msg, setMsg] = useState('');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['form-candidates'] });
    qc.invalidateQueries({ queryKey: ['forms'] });
    qc.invalidateQueries({ queryKey: ['forms-stats'] });
  };
  const detect = useMutation({
    mutationFn: () => api.post<{ checked: number; added: number; candidates: number; skipped?: string }>('/forms/detect'),
    onSuccess: (r) => {
      setMsg(r.skipped ? r.skipped : r.added || r.candidates ? `自動で追加 ${r.added} 件 ／ 候補 ${r.candidates} 件` : '新しいファイルはありませんでした');
      refresh();
    },
    onError: (e) => setMsg((e as Error).message),
  });
  const accept = useMutation({ mutationFn: (id: number) => api.post(`/forms/${id}/accept`, edits[id] ?? {}), onSuccess: refresh, onError: (e) => setMsg((e as Error).message) });
  const dismiss = useMutation({ mutationFn: (id: number) => api.post(`/forms/${id}/dismiss`), onSuccess: refresh, onError: (e) => setMsg((e as Error).message) });
  const autoAdd = (settings.data?.forms_auto_add ?? '1') !== '0';
  const setAuto = useMutation({
    mutationFn: (on: boolean) => api.put('/settings', { forms_auto_add: on ? '1' : '0' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  const rows = list.data ?? [];
  const edit = (id: number, patch: { caseType?: string | null; docType?: string | null }) => setEdits((e) => ({ ...e, [id]: { ...e[id], ...patch } }));
  return (
    <section className="card space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="font-semibold" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? '▾' : '▸'} 新しいファイルから見つけた候補
        </button>
        <span className={`badge ${rows.length ? 'badge-orange' : 'badge-gray'}`}>{rows.length} 件</span>
        <button className="btn btn-sm ml-auto" onClick={() => detect.mutate()} disabled={detect.isPending} title="OneDrive の依頼者フォルダに新しくできたファイルを見に行きます（ふだんは 1 時間ごとに自動で見ています）">
          {detect.isPending ? '確認中…' : '新しいファイルを今すぐ確認'}
        </button>
        {msg && <span className="fade-in text-xs text-slate-600">{msg}</span>}
      </div>
      {open && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <span>OneDrive の依頼者フォルダに新しくできた Word・Excel などを 1 時間ごとに見て、書式になりそうなものを集めます（受領資料・送付ファイルは除く）。</span>
            <label className="flex items-center gap-1 text-slate-700">
              <input type="checkbox" checked={autoAdd} onChange={(e) => setAuto.mutate(e.target.checked)} disabled={!settings.data || setAuto.isPending} />
              ファイル名から文書種別（準備書面・契約書など）が分かる Word・Excel は自動でライブラリに追加する
            </label>
          </div>
          {rows.length === 0 ? (
            <div className="text-xs text-slate-500">確認待ちの候補はありません</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {rows.map((c) => {
                const e = edits[c.id] ?? {};
                return (
                  <li key={c.id} className="flex flex-wrap items-start gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      {c.webUrl ? (
                        <a href={c.webUrl} target="_blank" rel="noreferrer" className="font-medium text-blue-700 hover:underline">
                          {c.name}
                        </a>
                      ) : (
                        <span className="font-medium">{c.name}</span>
                      )}
                      <div className="truncate text-xs text-slate-400" title={c.path}>
                        {c.clientName && <span className="mr-1 text-slate-600">{c.clientName}</span>}
                        {c.path} {fmtBytes(c.size)} {c.modifiedAt && `更新 ${fmtDate(c.modifiedAt)}`}
                      </div>
                      {c.excerpt ? <div className="line-clamp-2 text-xs text-slate-500">{c.excerpt}</div> : !c.hasText && <div className="text-xs text-orange-600">本文を取り出せませんでした</div>}
                    </div>
                    <select className="input w-auto py-0.5 text-xs" value={(e.caseType !== undefined ? e.caseType : c.caseType) ?? ''} onChange={(ev) => edit(c.id, { caseType: ev.target.value || null })} aria-label="類型">
                      <option value="">未分類</option>
                      {types.map((t) => (
                        <option key={t.key} value={t.key}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                    <input
                      className="input w-28 py-0.5 text-xs"
                      value={(e.docType !== undefined ? e.docType : c.docType) ?? ''}
                      onChange={(ev) => edit(c.id, { docType: ev.target.value || null })}
                      placeholder="文書種別"
                      aria-label="文書種別"
                    />
                    <button className="btn btn-sm btn-primary" onClick={() => accept.mutate(c.id)} disabled={accept.isPending || dismiss.isPending}>
                      ライブラリに追加
                    </button>
                    <button className="btn btn-sm" onClick={() => dismiss.mutate(c.id)} disabled={accept.isPending || dismiss.isPending} title="書式にしません。もう候補に出しません（OneDrive のファイルはそのまま）">
                      対象外
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function DraftPanel({ templateIds, caseId, onClose }: { templateIds: number[]; caseId: number | null; onClose: () => void }) {
  const cases = useQuery({ queryKey: ['cases', 'open'], queryFn: () => api.get<{ id: number; title: string; clientName: string }[]>('/cases?status=open') });
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
  // 書きかけの題名・事実関係・指示を自動保存する（画面を閉じても消えない）
  const draft = useDraftGroup('forms:draft', {
    title: { value: title, set: setTitle },
    facts: { value: facts, set: setFacts },
    instruction: { value: instruction, set: setInstruction },
  });
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
        <InstructionBox className="md:col-span-2" rows={3} ariaLabel="指示" placeholder="指示（例: 請求棄却を求める答弁書。争点は消滅時効。）" value={instruction} onChange={setInstruction} />
        <DraftHint handle={draft} className="md:col-span-2" />
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
      {err && <div className="fade-in text-red-600">{err}</div>}
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
