import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDateTime, fmtRelative } from '../lib/format';
import { CASE_STATUSES, CASE_STATUS_LABEL, type CaseStatus } from '@lcm/shared';

interface CaseRow {
  id: number;
  title: string;
  clientId: number;
  clientName: string;
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

export function CaseStatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_BADGE[status] ?? 'badge-gray'}`}>{CASE_STATUS_LABEL[status as CaseStatus] ?? status}</span>;
}

export default function Cases() {
  const [status, setStatus] = useState<string>('active');
  const all = useQuery({ queryKey: ['cases', 'all'], queryFn: () => api.get<CaseRow[]>('/cases') });
  const rows = (all.data ?? []).filter((c) => !status || c.status === status);
  const counts: Record<string, number> = {};
  for (const c of all.data ?? []) counts[c.status] = (counts[c.status] ?? 0) + 1;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">事件</h1>
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
              <th className="px-4 py-2">事件名</th>
              <th className="px-4 py-2">依頼者</th>
              <th className="px-4 py-2">区分</th>
              <th className="px-4 py-2">類型</th>
              <th className="px-4 py-2">段階</th>
              <th className="px-4 py-2">次回期日</th>
              <th className="px-4 py-2">更新</th>
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
