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
  const [status, setStatus] = useState<string>('active');
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const all = useQuery({ queryKey: ['cases', 'all'], queryFn: () => api.get<CaseRow[]>('/cases') });
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
      <div className="card p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
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
              <tr key={c.id} className="border-t border-slate-100 hover:bg-slate-50">
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
                <td className="px-4 py-4 text-slate-500" colSpan={8}>
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

/** 既存の依頼者に新しい事件を登録する */
function NewCaseForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const types = useQuery({ queryKey: ['case-types'], queryFn: () => api.get<{ key: string; label: string }[]>('/case-types') });
  const [form, setForm] = useState({ clientId: '', title: '', caseType: 'general_civil', status: 'active', courtName: '', caseNumber: '' });
  const [err, setErr] = useState('');
  const create = useMutation({
    mutationFn: () => api.post<{ id: number }>('/cases', { ...form, clientId: Number(form.clientId), courtName: form.courtName || null, caseNumber: form.caseNumber || null }),
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
        if (!form.clientId) {
          setErr('依頼者を選んでください');
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
          <ClientPicker value={form.clientId} onChange={(v) => setForm({ ...form, clientId: v })} emptyLabel="依頼者を選択…" selectClassName="min-w-48 flex-1" autoFocus />
          <div className="mt-1 text-xs text-slate-500">
            新しい依頼者の場合は{' '}
            <Link to="/clients" className="text-blue-700 hover:underline">
              依頼者ページ
            </Link>{' '}
            で先に登録してください。
          </div>
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
