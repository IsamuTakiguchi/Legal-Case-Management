import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDateTime, fmtRelative } from '../lib/format';

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

export default function Cases() {
  const [status, setStatus] = useState('active');
  const list = useQuery({ queryKey: ['cases', status], queryFn: () => api.get<CaseRow[]>(`/cases?status=${status}`) });
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-bold">事件</h1>
        <select className="input ml-auto w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">進行中</option>
          <option value="closed">終了</option>
          <option value="">すべて</option>
        </select>
      </div>
      <div className="card p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2">事件名</th>
              <th className="px-4 py-2">依頼者</th>
              <th className="px-4 py-2">類型</th>
              <th className="px-4 py-2">段階</th>
              <th className="px-4 py-2">次回期日</th>
              <th className="px-4 py-2">更新</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((c) => (
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
                  <span className="badge badge-gray">{c.caseTypeLabel}</span>
                  {c.hasCreditors && <span className="badge badge-blue ml-1">債権者</span>}
                </td>
                <td className="px-4 py-2 text-slate-600">{c.stage ?? ''}</td>
                <td className="px-4 py-2 text-slate-600">{c.nextHearingAt ? fmtDateTime(c.nextHearingAt) : <span className="text-slate-400">未定</span>}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{fmtRelative(c.updatedAt)}</td>
              </tr>
            ))}
            {list.data?.length === 0 && (
              <tr>
                <td className="px-4 py-4 text-slate-500" colSpan={6}>
                  事件がありません。依頼者ページから追加してください。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
