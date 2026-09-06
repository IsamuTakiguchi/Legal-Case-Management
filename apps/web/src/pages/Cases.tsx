import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
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
  const all = useQuery({ queryKey: ['cases', 'all'], queryFn: () => api.get<CaseRow[]>('/cases') });
  const sort = useSort('cases', CASE_SORTS, 'client');
  const rows = sort.apply((all.data ?? []).filter((c) => !status || c.status === status));
  const counts: Record<string, number> = {};
  for (const c of all.data ?? []) counts[c.status] = (counts[c.status] ?? 0) + 1;
  const H = (label: string, key: string) => <SortHeader label={label} sortKey={key} current={sort.key} desc={sort.desc} onClick={sort.setKey} />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">事件</h1>
        <select className="input ml-auto w-auto" value={sort.key} onChange={(e) => sort.setKey(e.target.value)} aria-label="並べ替え">
          {CASE_SORTS.map((o) => (
            <option key={o.key} value={o.key}>
              並べ替え: {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap gap-1">
        {CASE_STATUSES.map((s) => (
          <button key={s} type="button" className={`btn btn-sm ${status === s ? 'btn-primary' : ''}`} onClick={() => setStatus(s)}>
            {CASE_STATUS_LABEL[s]} <span className={status === s ? 'opacity-80' : 'text-slate-400'}>{counts[s] ?? 0}</span>
          </button>
        ))}
        <button type="button" className={`btn btn-sm ${status === '' ? 'btn-primary' : ''}`} onClick={() => setStatus('')}>
          すべて <span className={status === '' ? 'opacity-80' : 'text-slate-400'}>{all.data?.length ?? 0}</span>
        </button>
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
                <td className="px-4 py-2 text-slate-600">{c.nextHearingAt ? fmtDateTime(c.nextHearingAt) : <span className="text-slate-400">未定</span>}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{fmtRelative(c.updatedAt)}</td>
              </tr>
            ))}
            {all.data && rows.length === 0 && (
              <tr>
                <td className="px-4 py-4 text-slate-500" colSpan={7}>
                  {status ? `「${CASE_STATUS_LABEL[status as CaseStatus]}」の事件はありません。` : '事件がありません。依頼者ページから追加してください。'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
