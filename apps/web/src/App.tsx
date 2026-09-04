import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Inbox from './pages/Inbox';
import Conversation from './pages/Conversation';
import Clients from './pages/Clients';
import ClientDetail from './pages/ClientDetail';
import Cases from './pages/Cases';
import CaseDetail from './pages/CaseDetail';
import Forms from './pages/Forms';
import Tasks from './pages/Tasks';
import Alerts from './pages/Alerts';
import Files from './pages/Files';
import Settings from './pages/Settings';

const NAV = [
  { to: '/', label: 'ダッシュボード', icon: '◎' },
  { to: '/inbox', label: '受信箱', icon: '✉' },
  { to: '/clients', label: '依頼者', icon: '👤' },
  { to: '/cases', label: '事件', icon: '⚖' },
  { to: '/tasks', label: 'タスク・返信待ち', icon: '☑' },
  { to: '/alerts', label: '要確認', icon: '⚠' },
  { to: '/files', label: 'ファイル', icon: '📎' },
  { to: '/forms', label: '書式ライブラリ', icon: '📄' },
  { to: '/settings', label: '設定', icon: '⚙' },
];

export default function App() {
  const loc = useLocation();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<{ authenticated: boolean }>('/auth/me'), retry: false });
  const alerts = useQuery({ queryKey: ['alerts', 'count'], queryFn: () => api.get<unknown[]>('/alerts'), enabled: me.data?.authenticated === true, refetchInterval: 60_000 });

  if (loc.pathname === '/login') return <Login />;
  if (me.isLoading) return <div className="p-8 text-slate-500">読み込み中…</div>;
  if (!me.data?.authenticated) return <Navigate to="/login" replace />;

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-4">
          <div className="text-sm font-bold text-slate-900">統合コミュニケーション管理</div>
          <div className="text-xs text-slate-500">LINE公式・Chatwork・Gmail</div>
        </div>
        <nav className="flex flex-col gap-0.5 p-2">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) => `flex items-center justify-between rounded-md px-3 py-2 text-sm ${isActive ? 'bg-blue-50 font-semibold text-blue-700' : 'text-slate-700 hover:bg-slate-100'}`}
            >
              <span>
                <span className="mr-2 inline-block w-4 text-center">{n.icon}</span>
                {n.label}
              </span>
              {n.to === '/alerts' && (alerts.data?.length ?? 0) > 0 && <span className="badge badge-orange">{alerts.data!.length}</span>}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 flex-1 p-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/inbox/:id" element={<Conversation />} />
          <Route path="/clients" element={<Clients />} />
          <Route path="/clients/:id" element={<ClientDetail />} />
          <Route path="/cases" element={<Cases />} />
          <Route path="/cases/:id" element={<CaseDetail />} />
          <Route path="/forms" element={<Forms />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/files" element={<Files />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
