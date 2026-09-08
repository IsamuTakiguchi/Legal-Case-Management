import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './lib/api';
import { fmtDateTime } from './lib/format';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Inbox from './pages/Inbox';
import Calendar from './pages/Calendar';
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
import Setup from './pages/Setup';

const NAV = [
  { to: '/', label: 'ダッシュボード', icon: '◎' },
  { to: '/inbox', label: '受信箱', icon: '✉' },
  { to: '/calendar', label: '予定', icon: '📅' },
  { to: '/clients', label: '依頼者', icon: '👤' },
  { to: '/cases', label: '事件', icon: '⚖' },
  { to: '/tasks', label: 'タスク・返信待ち', icon: '☑' },
  { to: '/alerts', label: '要確認', icon: '⚠' },
  { to: '/files', label: 'ファイル', icon: '📎' },
  { to: '/forms', label: '書式ライブラリ', icon: '📄' },
  { to: '/setup', label: '初期設定', icon: '🔌' },
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
      <aside className="hidden w-56 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
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
        <div className="mt-auto space-y-2 p-2">
          <RefreshButtons />
          <BackupStatus />
          <LogoutButton className="w-full justify-center" />
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-3 pb-24 md:p-6 md:pb-6">
        <PullToRefresh />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/inbox/:id" element={<Conversation />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/clients" element={<Clients />} />
          <Route path="/clients/:id" element={<ClientDetail />} />
          <Route path="/cases" element={<Cases />} />
          <Route path="/cases/:id" element={<CaseDetail />} />
          <Route path="/forms" element={<Forms />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/files" element={<Files />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <MobileTabs alertCount={alerts.data?.length ?? 0} />
    </div>
  );
}

/** 受信を取り込み直して（Gmail・Chatwork）、画面のデータをすべて読み直す */
function useRefresh() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await api.post('/sync/now').catch(() => null);
      await qc.invalidateQueries();
    } finally {
      setBusy(false);
    }
  }, [qc]);
  return { refresh, busy };
}

/**
 * スマホ用「引っ張って更新」。ページ最上部で下に引っ張り、一定以上で離すと更新する。
 * ホーム画面から起動した PWA ではブラウザ標準の引っ張り更新が効かないため、アプリ側で用意する
 */
const PULL_THRESHOLD = 72;
function PullToRefresh() {
  const { refresh, busy } = useRefresh();
  const [pull, setPull] = useState(0);
  const startY = useRef<number | null>(null);
  const pulling = useRef(false);
  useEffect(() => {
    if (!window.matchMedia('(pointer: coarse)').matches) return; // タッチ端末だけ
    const onStart = (e: TouchEvent) => {
      if (window.scrollY > 0 || busy || e.touches.length !== 1) return;
      startY.current = e.touches[0].clientY;
      pulling.current = false;
    };
    const onMove = (e: TouchEvent) => {
      if (startY.current === null) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy <= 0 || window.scrollY > 0) {
        if (pulling.current) setPull(0);
        pulling.current = false;
        return;
      }
      // 入力欄やスクロールする箱の中では邪魔をしない
      const t = e.target as HTMLElement | null;
      if (t?.closest('textarea, input, select, [data-no-pull], .overflow-y-auto')) return;
      pulling.current = true;
      setPull(Math.min(PULL_THRESHOLD * 1.6, dy * 0.5));
      if (dy > 10 && e.cancelable) e.preventDefault();
    };
    const onEnd = () => {
      if (pulling.current && pull >= PULL_THRESHOLD) void refresh();
      startY.current = null;
      pulling.current = false;
      setPull(0);
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, [pull, busy, refresh]);
  const visible = pull > 0 || busy;
  if (!visible) return null;
  const ready = pull >= PULL_THRESHOLD;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center md:hidden" style={{ transform: `translateY(${busy ? 12 : Math.min(pull, PULL_THRESHOLD) - 40}px)`, transition: pull === 0 ? 'transform 150ms' : undefined }} aria-live="polite">
      <div className={`rounded-full border px-3 py-1 text-xs shadow ${ready || busy ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-500'}`}>
        {busy ? '更新中…' : ready ? '離して更新' : '↓ 引っ張って更新'}
      </div>
    </div>
  );
}

/** 「更新」= 受信を取り込み直して画面のデータを読み直す。「再読み込み」= アプリ自体を読み直す（新しい版に更新されたときなど） */
function RefreshButtons() {
  const { refresh, busy } = useRefresh();
  return (
    <div className="flex gap-1">
      <button type="button" className="btn btn-sm flex-1 justify-center" onClick={refresh} disabled={busy} title="Gmail・Chatwork の受信を取り込み直し、表示を最新にします">
        {busy ? '更新中…' : '⟳ 更新'}
      </button>
      <button type="button" className="btn btn-sm text-slate-500" onClick={() => location.reload()} title="アプリを読み直します（画面がおかしいとき・新しい版に更新されたとき）">
        再読み込み
      </button>
    </div>
  );
}

/** 最終バックアップの状況（設定 → バックアップへのリンク） */
function BackupStatus() {
  const q = useQuery({ queryKey: ['backup', 'status'], queryFn: () => api.get<{ last: { at: string | null; ok: boolean | null; error: string | null } }>('/backup'), staleTime: 5 * 60_000, refetchInterval: 10 * 60_000 });
  const last = q.data?.last;
  if (!last) return null;
  const stale = !last.at || Date.now() - new Date(last.at).getTime() > 2 * 86400_000;
  const bad = last.ok === false || stale;
  return (
    <NavLink to="/settings" className={`block truncate text-center text-[11px] ${bad ? 'text-orange-600' : 'text-slate-400'} hover:underline`} title={last.error ?? 'バックアップの設定・復元は設定画面から'}>
      バックアップ: {last.at ? fmtDateTime(last.at) : '未実施'}
      {last.ok === false ? '（失敗）' : ''}
    </NavLink>
  );
}

function LogoutButton({ className = '' }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  const logout = async () => {
    if (!confirm('ログアウトしますか？')) return;
    setBusy(true);
    try {
      await api.post('/auth/logout');
    } finally {
      location.href = '/login';
    }
  };
  return (
    <button type="button" className={`btn btn-sm text-slate-600 ${className}`} onClick={logout} disabled={busy}>
      ログアウト
    </button>
  );
}

/** スマホ幅では左メニューの代わりに下部タブを出す。「その他」で残りのメニューをシートで開く */
const PRIMARY_TABS = ['/', '/inbox', '/tasks', '/alerts'];

function MobileTabs({ alertCount }: { alertCount: number }) {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const primary = NAV.filter((n) => PRIMARY_TABS.includes(n.to));
  const rest = NAV.filter((n) => !PRIMARY_TABS.includes(n.to));
  const restActive = rest.some((n) => loc.pathname.startsWith(n.to));
  const short = (label: string) => label.replace('・返信待ち', '').replace('ダッシュボード', 'ホーム');
  return (
    <>
      {open && (
        <div className="fixed inset-0 z-30 bg-slate-900/40 md:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-white p-3 pb-[calc(env(safe-area-inset-bottom)+72px)] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-300" />
            <div className="grid grid-cols-3 gap-2">
              {rest.map((n) => (
                <NavLink key={n.to} to={n.to} className={({ isActive }) => `flex flex-col items-center gap-1 rounded-lg border px-2 py-3 text-xs ${isActive ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-700'}`}>
                  <span className="text-lg">{n.icon}</span>
                  {n.label}
                </NavLink>
              ))}
            </div>
            <div className="mt-3 space-y-2">
              <RefreshButtons />
              <BackupStatus />
              <div className="flex justify-end">
                <LogoutButton />
              </div>
            </div>
          </div>
        </div>
      )}
      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="主要メニュー">
        {primary.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `relative flex flex-col items-center gap-0.5 py-2 text-[11px] ${isActive ? 'text-blue-700' : 'text-slate-600'}`}>
            <span className="text-lg leading-none">{n.icon}</span>
            {short(n.label)}
            {n.to === '/alerts' && alertCount > 0 && <span className="absolute right-3 top-1 rounded-full bg-orange-500 px-1.5 text-[10px] font-semibold text-white">{alertCount}</span>}
          </NavLink>
        ))}
        <button type="button" onClick={() => setOpen((v) => !v)} className={`flex flex-col items-center gap-0.5 py-2 text-[11px] ${open || restActive ? 'text-blue-700' : 'text-slate-600'}`} aria-expanded={open}>
          <span className="text-lg leading-none">☰</span>
          その他
        </button>
      </nav>
    </>
  );
}
