import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { ClientPicker } from '../lib/ClientPicker';
import { fmtDateTime, fmtRelative } from '../lib/format';
import { CASE_STATUSES, CASE_STATUS_LABEL, type CaseStatus } from '@lcm/shared';
import { useSort, readingKey, SortHeader, type SortOption } from '../lib/sort';

interface CaseRow {
  id: number;
  title: string;
  clientId: number;
  clientName: string;
  clientKana: string | null;
  clientProvisional?: boolean;
  caseType: string;
  caseTypeLabel: string;
  hasCreditors: boolean;
  status: string;
  stage: string | null;
  courtName: string | null;
  caseNumber: string | null;
  nextHearingAt: string | null;
  updatedAt: string;
  staffName?: string | null;
}

const STATUS_BADGE: Record<string, string> = {
  consultation: 'badge-blue',
  active: 'badge-line',
  wrapup: 'badge-orange',
  closed: 'badge-gray',
};

const CASE_SORTS: SortOption<CaseRow>[] = [
  { key: 'client', label: '依頼者のあいうえお順', value: (c) => readingKey(c.clientKana, c.clientName) },
  { key: 'title', label: '事件名', value: (c) => c.title },
  { key: 'type', label: '類型', value: (c) => c.caseTypeLabel },
  { key: 'hearing', label: '次回期日が近い順', value: (c) => c.nextHearingAt ?? null },
  { key: 'updated', label: '更新が新しい順', value: (c) => c.updatedAt, desc: true },
];

export function CaseStatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_BADGE[status] ?? 'badge-gray'}`}>{CASE_STATUS_LABEL[status as CaseStatus] ?? status}</span>;
}

export default function Cases() {
  // ダッシュボードの件数から ?status=consultation などで開ける。選び直したら URL も合わせる（戻るで元の区分に戻れる）
  const [status, setStatusState] = useState<string>(() => {
    const v = new URLSearchParams(location.search).get('status');
    return v === 'all' ? '' : v && (CASE_STATUSES as readonly string[]).includes(v) ? v : 'active';
  });
  const setStatus = (v: string) => {
    setStatusState(v);
    setSelected(new Set());
    const u = new URL(location.href);
    u.searchParams.set('status', v || 'all');
    history.replaceState(history.state, '', `${u.pathname}${u.search}`);
  };
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const all = useQuery({ queryKey: ['cases', 'all'], queryFn: () => api.get<CaseRow[]>('/cases') });
  // チェックした事件（まとめて区分・担当事務局・類型を変える）
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkMsg, setBulkMsg] = useState('');
  const sort = useSort('cases', CASE_SORTS, 'client');
  // 依頼者名・かな・事件名・事件番号・裁判所・類型をまとめてテキスト検索（カタカナはひらがなに寄せる）
  const hira = (t: string) => t.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60)).replace(/[\s　]/g, '').toLowerCase();
  const terms = hira(q).split(/[,、]/).filter(Boolean);
  const matches = (c: CaseRow) => {
    if (!terms.length) return true;
    const hay = hira([c.clientName, c.clientKana ?? '', c.title, c.caseNumber ?? '', c.courtName ?? '', c.caseTypeLabel, c.stage ?? ''].join(' '));
    return terms.every((t) => hay.includes(t));
  };
  const searched = (all.data ?? []).filter(matches);
  const rows = sort.apply(searched.filter((c) => !status || c.status === status));
  // 絞り込みで見えなくなった行は選択に数えない
  const picked = rows.filter((c) => selected.has(c.id));
  const allPicked = rows.length > 0 && picked.length === rows.length;
  const toggle = (id: number, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const counts: Record<string, number> = {};
  for (const c of searched) counts[c.status] = (counts[c.status] ?? 0) + 1;
  const H = (label: string, key: string) => <SortHeader label={label} sortKey={key} current={sort.key} desc={sort.desc} onClick={sort.setKey} />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">事件</h1>
        <button className="btn btn-primary ml-auto" onClick={() => setCreating(!creating)}>
          ＋ 新規事件
        </button>
        <input className="input w-full md:w-64" placeholder="依頼者名・かな・事件名・事件番号で検索" value={q} onChange={(e) => setQ(e.target.value)} aria-label="事件を検索" />
        <select className="input w-auto" value={sort.key} onChange={(e) => sort.setKey(e.target.value)} aria-label="並べ替え">
          {CASE_SORTS.map((o) => (
            <option key={o.key} value={o.key}>
              並べ替え: {o.label}
            </option>
          ))}
        </select>
      </div>
      {creating && <NewCaseForm onClose={() => setCreating(false)} />}
      <div className="flex flex-wrap gap-1">
        {CASE_STATUSES.map((s) => (
          <button key={s} type="button" className={`btn btn-sm ${status === s ? 'btn-primary' : ''}`} onClick={() => setStatus(s)}>
            {CASE_STATUS_LABEL[s]} <span className={status === s ? 'opacity-80' : 'text-slate-400'}>{counts[s] ?? 0}</span>
          </button>
        ))}
        <button type="button" className={`btn btn-sm ${status === '' ? 'btn-primary' : ''}`} onClick={() => setStatus('')}>
          すべて <span className={status === '' ? 'opacity-80' : 'text-slate-400'}>{searched.length}</span>
        </button>
        {q && <span className="self-center text-xs text-slate-500">「{q}」で検索中</span>}
      </div>
      <FolderStatusSync />
      <CaseBulkBar
        ids={picked.map((c) => c.id)}
        onClear={() => setSelected(new Set())}
        onDone={(msg) => {
          setBulkMsg(msg);
          setSelected(new Set());
        }}
      />
      {bulkMsg && picked.length === 0 && <div className="fade-in text-xs text-green-700">{bulkMsg}</div>}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="w-px py-2 pl-4">
                <input type="checkbox" checked={allPicked} ref={(el) => {
                    if (el) el.indeterminate = picked.length > 0 && !allPicked;
                  }} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((c) => c.id)) : new Set())} aria-label="表示中の事件をすべて選択" />
              </th>
              <th className="px-4 py-2">{H('事件名', 'title')}</th>
              <th className="px-4 py-2">{H('依頼者', 'client')}</th>
              <th className="px-4 py-2">区分</th>
              <th className="px-4 py-2">{H('類型', 'type')}</th>
              <th className="px-4 py-2">段階</th>
              <th className="px-4 py-2">担当事務局</th>
              <th className="px-4 py-2">{H('次回期日', 'hearing')}</th>
              <th className="px-4 py-2">{H('更新', 'updated')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className={`border-t border-slate-100 hover:bg-slate-50 ${selected.has(c.id) ? 'bg-blue-50/60' : ''}`}>
                <td className="py-2 pl-4">
                  <input type="checkbox" checked={selected.has(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} aria-label={`${c.title}（${c.clientName}）を選択`} />
                </td>
                <td className="px-4 py-2">
                  <Link to={`/cases/${c.id}`} className="font-medium text-blue-700 hover:underline">
                    {c.title}
                  </Link>
                  {c.caseNumber && <span className="ml-2 text-xs text-slate-500">{c.caseNumber}</span>}
                </td>
                <td className="px-4 py-2">
                  <Link to={`/clients/${c.clientId}`} className="hover:underline">
                    {c.clientName}
                  </Link>
                  {c.clientProvisional && <span className="badge badge-orange ml-1">氏名未確認</span>}
                </td>
                <td className="px-4 py-2">
                  <CaseStatusBadge status={c.status} />
                </td>
                <td className="px-4 py-2">
                  <span className="badge badge-gray">{c.caseTypeLabel}</span>
                  {c.hasCreditors && <span className="badge badge-blue ml-1">債権者</span>}
                </td>
                <td className="px-4 py-2 text-slate-600">{c.stage ?? ''}</td>
                <td className="px-4 py-2 text-slate-600">{c.staffName ?? ''}</td>
                <td className="px-4 py-2 text-slate-600">{c.nextHearingAt ? fmtDateTime(c.nextHearingAt) : <span className="text-slate-400">未定</span>}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{fmtRelative(c.updatedAt)}</td>
              </tr>
            ))}
            {all.data && rows.length === 0 && (
              <tr>
                <td className="px-4 py-4 text-slate-500" colSpan={9}>
                  {q ? `「${q}」に一致する事件はありません${status ? `（${CASE_STATUS_LABEL[status as CaseStatus]}の中）` : ''}。` : status ? `「${CASE_STATUS_LABEL[status as CaseStatus]}」の事件はありません。` : '事件がありません。「＋ 新規事件」から追加してください。'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface FolderMismatch {
  clientId: number;
  clientName: string;
  folder: string;
  folderStatus: CaseStatus;
  appStatus: CaseStatus;
  caseCount: number;
}
interface FolderRename {
  clientName: string;
  from: string;
  to: string;
  status?: { to: CaseStatus; changed: { title: string; from: CaseStatus; to: CaseStatus }[] };
}

/**
 * OneDrive の区分フォルダ（相談・進行事件・残務処理・終了事件）と事件の区分を合わせる。
 * フォルダを別の区分へ移すと 1 時間ごとの取り込みで区分も変わる。すぐ反映したいときは「OneDrive から取り込む」。
 * 以前から食い違っている依頼者は、ここで確かめてから合わせる
 */
function FolderStatusSync() {
  const qc = useQueryClient();
  const mism = useQuery({ queryKey: ['folder-status-mismatches'], queryFn: () => api.get<FolderMismatch[]>('/clients/folders/status-mismatches') });
  const [picked, setPicked] = useState<Set<number> | null>(null);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['cases'] });
    qc.invalidateQueries({ queryKey: ['folder-status-mismatches'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const sync = useMutation({
    mutationFn: () => api.post<{ checked: number; renamed: number; renames: FolderRename[] }>('/clients/folders/sync-names'),
    onSuccess: (r) => {
      const moved = r.renames.filter((x) => x.status);
      setMsg(
        moved.length
          ? `OneDrive での移動に合わせて区分を変えました: ${moved.map((x) => `${x.clientName}（${CASE_STATUS_LABEL[x.status!.to]}）`).join('、')}`
          : r.renamed
            ? `フォルダ名の変更を ${r.renamed} 件取り込みました（区分の変更はありません）`
            : `OneDrive 側の変更はありませんでした（${r.checked} 件を確認）`,
      );
      refresh();
    },
    onError: (e) => setMsg((e as Error).message),
  });
  const align = useMutation({
    mutationFn: (ids: number[]) => api.post<{ clients: number; changed: unknown[] }>('/clients/folders/align-status', { clientIds: ids }),
    onSuccess: (r) => {
      setMsg(`${r.clients} 人の依頼者の事件（${r.changed.length} 件）を、フォルダの区分に合わせました`);
      setOpen(false);
      setPicked(null);
      refresh();
    },
    onError: (e) => setMsg((e as Error).message),
  });
  const list = mism.data ?? [];
  const sel = picked ?? new Set(list.map((m) => m.clientId));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <button type="button" className="btn btn-sm" onClick={() => sync.mutate()} disabled={sync.isPending} title="OneDrive で依頼者フォルダを別の区分フォルダへ移したら、事件の区分もそれに合わせます（1 時間ごとにも自動で取り込みます）">
          {sync.isPending ? 'OneDrive を確認中…' : 'OneDrive から取り込む'}
        </button>
        {list.length > 0 && (
          <button type="button" className="text-orange-700 underline" onClick={() => setOpen((v) => !v)}>
            フォルダの区分と違う依頼者が {list.length} 人います
          </button>
        )}
        {msg && <span className="fade-in text-green-700">{msg}</span>}
      </div>
      {open && list.length > 0 && (
        <div className="fade-in card space-y-2 border-orange-200 text-sm">
          <div className="text-xs text-slate-600">OneDrive の依頼者フォルダが置かれている区分に、事件の区分を合わせます（フォルダは動かしません）。合わせない依頼者はチェックを外してください。</div>
          <ul className="space-y-1">
            {list.map((m) => (
              <li key={m.clientId} className="flex flex-wrap items-center gap-2">
                <input
                  type="checkbox"
                  checked={sel.has(m.clientId)}
                  onChange={(e) => {
                    const next = new Set(sel);
                    if (e.target.checked) next.add(m.clientId);
                    else next.delete(m.clientId);
                    setPicked(next);
                  }}
                  aria-label={`${m.clientName} を合わせる`}
                />
                <Link to={`/clients/${m.clientId}`} className="font-medium hover:underline">
                  {m.clientName}
                </Link>
                <span className="text-xs text-slate-500">
                  アプリ: <CaseStatusBadge status={m.appStatus} /> → フォルダ: <CaseStatusBadge status={m.folderStatus} />
                </span>
                <span className="truncate text-xs text-slate-400">{m.folder}</span>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => align.mutate([...sel])} disabled={!sel.size || align.isPending}>
              {align.isPending ? '変更中…' : `${sel.size} 人をフォルダの区分に合わせる`}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * チェックした事件をまとめて変更する（区分・担当事務局・事件類型）。
 * 区分を変えると、区分フォルダ運用なら依頼者フォルダも移動する
 */
function CaseBulkBar({ ids, onClear, onDone }: { ids: number[]; onClear: () => void; onDone: (msg: string) => void }) {
  const qc = useQueryClient();
  const types = useQuery({ queryKey: ['case-types'], queryFn: () => api.get<{ key: string; label: string }[]>('/case-types') });
  const staff = useQuery({ queryKey: ['staff'], queryFn: () => api.get<{ id: number; name: string }[]>('/staff') });
  const [err, setErr] = useState('');
  const run = useMutation({
    mutationFn: (v: { patch: { status?: CaseStatus; staffId?: number | null; caseType?: string }; label: string }) => api.post<{ updated: number }>('/cases/bulk', { ids, ...v.patch }),
    onSuccess: (r, v) => {
      setErr('');
      qc.invalidateQueries({ queryKey: ['cases'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      onDone(r.updated ? `${r.updated} 件を${v.label}` : '変更はありませんでした（すでに同じ内容です）');
    },
    onError: (e) => setErr((e as Error).message),
  });
  if (!ids.length) return <div className="text-xs text-slate-400">チェックを付けると、まとめて区分・担当事務局・事件類型を変えられます</div>;
  const setStatusTo = (st: CaseStatus) => {
    if (st === 'closed' && !confirm(`${ids.length} 件を「終了事件」にしますか？（区分フォルダで管理していれば、依頼者フォルダも終了事件のフォルダへ移ります）`)) return;
    run.mutate({ patch: { status: st }, label: `「${CASE_STATUS_LABEL[st]}」にしました` });
  };
  return (
    <div className="fade-in card flex flex-wrap items-center gap-2 border-blue-200 py-2 text-sm">
      <span className="font-medium text-slate-700">{ids.length} 件を選択中</span>
      <span className="text-xs text-slate-500">区分:</span>
      {CASE_STATUSES.map((st) => (
        <button key={st} type="button" className="btn btn-sm" onClick={() => setStatusTo(st)} disabled={run.isPending}>
          {CASE_STATUS_LABEL[st]}
        </button>
      ))}
      <select
        className="input w-auto py-1 text-xs"
        value=""
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          const staffId = v === 'none' ? null : Number(v);
          const name = staffId ? staff.data?.find((x) => x.id === staffId)?.name : null;
          run.mutate({ patch: { staffId }, label: name ? `担当事務局「${name}」にしました` : '担当事務局なしにしました' });
        }}
        disabled={run.isPending}
        aria-label="担当事務局をまとめて設定"
      >
        <option value="">担当事務局を設定…</option>
        {staff.data?.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
        <option value="none">（担当なしにする）</option>
      </select>
      <select
        className="input w-auto py-1 text-xs"
        value=""
        onChange={(e) => {
          const key = e.target.value;
          if (!key) return;
          const label = types.data?.find((t) => t.key === key)?.label ?? key;
          run.mutate({ patch: { caseType: key }, label: `事件類型「${label}」にしました` });
        }}
        disabled={run.isPending}
        aria-label="事件類型をまとめて変更"
      >
        <option value="">事件類型を変更…</option>
        {types.data?.map((t) => (
          <option key={t.key} value={t.key}>
            {t.label}
          </option>
        ))}
      </select>
      <button type="button" className="btn btn-sm text-slate-500" onClick={onClear}>
        選択解除
      </button>
      {run.isPending && <span className="loading-text text-xs text-slate-500">変更中…</span>}
      {err && <span className="text-xs text-red-600">{err}</span>}
    </div>
  );
}

/** 既存の依頼者に新しい事件を登録する */
function NewCaseForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const types = useQuery({ queryKey: ['case-types'], queryFn: () => api.get<{ key: string; label: string }[]>('/case-types') });
  const [form, setForm] = useState({ clientId: '', title: '', caseType: 'general_civil', status: 'active', courtName: '', caseNumber: '', referrer: '' });
  // 当事者の氏名がまだ分からない相談（紹介者からの代理相談など）
  const [unknownClient, setUnknownClient] = useState(false);
  const [provisionalLabel, setProvisionalLabel] = useState('');
  const [err, setErr] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: number }>('/cases', {
        ...form,
        clientId: unknownClient ? undefined : Number(form.clientId),
        provisionalClient: unknownClient ? { label: provisionalLabel.trim() || null } : undefined,
        courtName: form.courtName || null,
        caseNumber: form.caseNumber || null,
        referrer: form.referrer.trim() || null,
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['cases'] });
      qc.invalidateQueries({ queryKey: ['client', form.clientId] });
      onClose();
      nav(`/cases/${r.id}`);
    },
    onError: (e) => setErr((e as Error).message),
  });
  return (
    <form
      className="card space-y-3 border-blue-200"
      onSubmit={(e) => {
        e.preventDefault();
        if (!unknownClient && !form.clientId) {
          setErr('依頼者を選んでください（氏名が分からない場合は「当事者の氏名が未確認」にチェック）');
          return;
        }
        create.mutate();
      }}
    >
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">新規事件</h2>
        <button type="button" className="btn btn-sm ml-auto" onClick={onClose}>
          閉じる
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="label">依頼者（登録済みから選ぶ）</label>
          {unknownClient ? (
            <input className="input" value={provisionalLabel} onChange={(e) => setProvisionalLabel(e.target.value)} placeholder={`仮の呼び名（空なら「（氏名未確認）${form.referrer.trim() ? `${form.referrer.trim().replace(/(さん|様|氏)$/, '')}さん` : '紹介者'}紹介の相談者」）`} aria-label="仮の呼び名" />
          ) : (
            <ClientPicker value={form.clientId} onChange={(v) => setForm({ ...form, clientId: v })} emptyLabel="依頼者を選択…" selectClassName="min-w-48 flex-1" autoFocus />
          )}
          <label className="mt-1 flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={unknownClient}
              onChange={(e) => {
                setUnknownClient(e.target.checked);
                // 氏名未確認はたいてい相談段階
                if (e.target.checked && form.status === 'active') setForm({ ...form, status: 'consultation' });
              }}
            />
            当事者の氏名が未確認（紹介者からの代理相談など）
          </label>
          <div className="mt-1 text-xs text-slate-500">
            {unknownClient ? (
              '仮の依頼者（氏名未確認）を作って記録します。氏名が分かったら、依頼者ページで確定するか、登録済みの依頼者にまとめられます。'
            ) : (
              <>
                新しい依頼者の場合は{' '}
                <Link to="/clients" className="text-blue-700 hover:underline">
                  依頼者ページ
                </Link>{' '}
                で先に登録してください。
              </>
            )}
          </div>
          <label className="label mt-2">紹介者（任意）</label>
          <input className="input" value={form.referrer} onChange={(e) => setForm({ ...form, referrer: e.target.value })} placeholder="例: 〇〇税理士、△△さん" />
        </div>
        <div className="space-y-3">
          <div>
            <label className="label">事件名</label>
            <input className="input" placeholder="例: 損害賠償請求（交通事故）" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">進捗区分</label>
              <select className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {CASE_STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {CASE_STATUS_LABEL[st]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">類型</label>
              <select className="input" value={form.caseType} onChange={(e) => setForm({ ...form, caseType: e.target.value })}>
                {types.data?.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">裁判所</label>
              <input className="input" value={form.courtName} onChange={(e) => setForm({ ...form, courtName: e.target.value })} />
            </div>
            <div>
              <label className="label">事件番号</label>
              <input className="input" value={form.caseNumber} onChange={(e) => setForm({ ...form, caseNumber: e.target.value })} />
            </div>
          </div>
        </div>
      </div>
      {err && <div className="fade-in text-sm text-red-600">{err}</div>}
      <div className="flex items-center gap-2">
        <button className="btn btn-primary" disabled={create.isPending}>
          {create.isPending ? '登録中…' : '登録'}
        </button>
        <span className="text-xs text-slate-500">登録すると事件ページに移動します。区分フォルダを使っている場合、依頼者フォルダの区分もこの事件に合わせて整えます。</span>
      </div>
    </form>
  );
}
