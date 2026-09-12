import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './lib/api';
import { fmtDateTime } from './lib/format';
import { Icon, type IconName } from './lib/icons';
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

interface NavCounts {
  inbox: number;
  tasks: number;
  alerts: number;
}
const EMPTY_COUNTS: NavCounts = { inbox: 0, tasks: 0, alerts: 0 };
/** メニュー項目に出す件数と色（Chatwork のように、対応が要るものの数を出す） */
function navBadge(to: string, c: NavCounts): { n: number; tone: 'blue' | 'gray' | 'orange' } | null {
  if (to === '/inbox') return c.inbox > 0 ? { n: c.inbox, tone: 'blue' } : null;
  if (to === '/tasks') return c.tasks > 0 ? { n: c.tasks, tone: 'gray' } : null;
  if (to === '/alerts') return c.alerts > 0 ? { n: c.alerts, tone: 'orange' } : null;
  return null;
}

const NAV: { to: string; label: string; icon: IconName }[] = [
  { to: '/', label: 'ダッシュボード', icon: 'home' },
  { to: '/inbox', label: '受信箱', icon: 'inbox' },
  { to: '/calendar', label: '予定', icon: 'calendar' },
  { to: '/clients', label: '依頼者', icon: 'person' },
  { to: '/cases', label: '事件', icon: 'scale' },
  { to: '/tasks', label: 'タスク・返信待ち', icon: 'check' },
  { to: '/alerts', label: '要確認', icon: 'bell' },
  { to: '/files', label: 'ファイル', icon: 'clip' },
  { to: '/forms', label: '書式ライブラリ', icon: 'doc' },
  { to: '/setup', label: '初期設定', icon: 'plug' },
  { to: '/settings', label: '設定', icon: 'gear' },
];

export default function App() {
  const loc = useLocation();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<{ authenticated: boolean }>('/auth/me'), retry: false });
  // メニューの件数（受信箱の要返信・未完了タスク・要確認）
  const counts = useQuery({ queryKey: ['nav-counts'], queryFn: () => api.get<NavCounts>('/nav-counts'), enabled: me.data?.authenticated === true, refetchInterval: 60_000 });
  const nav = counts.data ?? EMPTY_COUNTS;
  // ブラウザのタブには「Lex — 事務所名」を出す（事務所名は設定から）
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Record<string, string>>('/settings'), enabled: me.data?.authenticated === true, staleTime: 5 * 60_000 });
  const officeName = settings.data?.office_name?.trim();
  useEffect(() => {
    document.title = officeName ? `Lex — ${officeName}` : 'Lex';
  }, [officeName]);

  if (loc.pathname === '/login') return <Login />;
  if (me.isLoading) return <div className="loading-text p-8 text-slate-500">読み込み中…</div>;
  if (!me.data?.authenticated) return <Navigate to="/login" replace />;

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col border-r border-[var(--hairline)] bg-white/60 backdrop-blur-2xl md:flex">
        <div className="flex items-center gap-3 px-4 pb-3 pt-5">
          <img src="/icon.svg?v=2" alt="" className="h-9 w-9 rounded-[10px] shadow-[0_2px_6px_rgba(0,0,0,0.12)]" />
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold tracking-[-0.02em]">Lex</div>
            <div className="truncate whitespace-nowrap text-[11px] text-slate-500">連絡・事件・期日をひとつに</div>
          </div>
        </div>
        <SideNav counts={nav} />
        <div className="mt-auto space-y-2 border-t border-[var(--hairline)] p-3">
          <RefreshButtons />
          <BackupStatus />
          <LogoutButton className="w-full" />
        </div>
      </aside>
      <main className="mx-auto w-full min-w-0 max-w-[1280px] flex-1 p-4 pb-24 md:px-8 md:py-7 md:pb-10">
        <PullToRefresh />
        <div key={loc.pathname} className="page-enter">
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
        </div>
      </main>
      <MobileTabs counts={nav} />
    </div>
  );
}

/** 左メニュー。選択中の淡い青の枠は別の項目を選ぶと滑って移動する（macOS のサイドバー風） */
function SideNav({ counts }: { counts: NavCounts }) {
  const loc = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ top: number; height: number; anim: boolean } | null>(null);
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const active = nav.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!active) {
      setPill(null);
      return;
    }
    const top = active.getBoundingClientRect().top - nav.getBoundingClientRect().top;
    const height = active.offsetHeight;
    // 初回は動かさずに置き、2 回目以降は滑らせる
    setPill((prev) => ({ top, height, anim: prev !== null }));
  }, [loc.pathname]);
  return (
    <nav ref={navRef} className="relative flex flex-col gap-px px-3 pt-2">
      {pill && <div className={`nav-pill mx-3 ${pill.anim ? '' : 'no-anim'}`} style={{ top: pill.top, height: pill.height }} aria-hidden />}
      {NAV.map((n, i) => (
        <div key={n.to}>
          {i === NAV.length - 2 && <div className="mx-1 my-2 border-t border-[var(--hairline)]" />}
          <NavLink to={n.to} end={n.to === '/'} className={({ isActive }) => `nav-item nav-item-flat ${isActive ? 'nav-item-active' : ''}`}>
            <span className="nav-icon">
              <Icon name={n.icon} className="h-[18px] w-[18px]" />
            </span>
            <span className="min-w-0 flex-1 truncate">{n.label}</span>
            {(() => {
              const b = navBadge(n.to, counts);
              return b ? <span className={`badge badge-${b.tone} pop-in tabular-nums`}>{b.n}</span> : null;
            })()}
          </NavLink>
        </div>
      ))}
    </nav>
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
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center md:hidden" style={{ transform: `translateY(${busy ? 12 : Math.min(pull, PULL_THRESHOLD) - 40}px)`, transition: pull === 0 ? 'transform 320ms var(--ease-spring)' : undefined }} aria-live="polite">
      <div className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs shadow-[var(--shadow-float)] backdrop-blur-xl transition-colors duration-200 ${ready || busy ? 'border-[var(--accent)]/30 bg-[var(--accent-soft)] text-[var(--accent)]' : 'border-[var(--hairline)] bg-white/90 text-slate-500'}`}>
        <Icon name="refresh" className={`h-3.5 w-3.5 transition-transform duration-200 ${busy ? 'animate-spin' : ready ? 'rotate-180' : ''}`} />
        {busy ? '更新中…' : ready ? '離して更新' : '引っ張って更新'}
      </div>
    </div>
  );
}

/** 「更新」= 受信を取り込み直して画面のデータを読み直す。「再読み込み」= アプリ自体を読み直す（新しい版に更新されたときなど） */
function RefreshButtons() {
  const { refresh, busy } = useRefresh();
  return (
    <div className="flex gap-1">
      <button type="button" className="btn btn-sm flex-1" onClick={refresh} disabled={busy} title="Gmail・Chatwork の受信を取り込み直し、表示を最新にします">
        <Icon name="refresh" className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
        {busy ? '更新中…' : '更新'}
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
    <button type="button" className={`btn btn-sm ${className}`} onClick={logout} disabled={busy}>
      ログアウト
    </button>
  );
}

/** スマホ幅では左メニューの代わりに下部タブを出す。「その他」で残りのメニューをシートで開く */
const PRIMARY_TABS = ['/', '/inbox', '/tasks', '/alerts'];

/** 開閉をアニメーションさせるため、閉じた後も一定時間は描画を残す */
function useSheet(open: boolean, duration = 420) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), duration);
    return () => clearTimeout(t);
  }, [open, duration]);
  return { mounted, shown };
}

function MobileTabs({ counts }: { counts: NavCounts }) {
  const [open, setOpen] = useState(false);
  const { mounted, shown } = useSheet(open);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const primary = NAV.filter((n) => PRIMARY_TABS.includes(n.to));
  const rest = NAV.filter((n) => !PRIMARY_TABS.includes(n.to));
  const restActive = rest.some((n) => loc.pathname.startsWith(n.to));
  const short = (label: string) => label.replace('・返信待ち', '').replace('ダッシュボード', 'ホーム');
  return (
    <>
      {mounted && (
        <div className={`sheet-backdrop fixed inset-0 z-30 md:hidden ${shown ? 'is-open' : ''}`} onClick={() => setOpen(false)}>
          <div className="sheet absolute inset-x-0 bottom-0 rounded-t-[22px] bg-white/95 p-4 pb-[calc(env(safe-area-inset-bottom)+72px)] shadow-[0_-8px_40px_rgba(0,0,0,0.18)] backdrop-blur-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-300" />
            <div className="grid grid-cols-3 gap-2">
              {rest.map((n) => (
                <NavLink key={n.to} to={n.to} className={({ isActive }) => `card-press flex flex-col items-center gap-1.5 rounded-2xl px-2 py-3 text-xs ${isActive ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'bg-black/[0.04] text-slate-700'}`}>
                  <Icon name={n.icon} className="h-6 w-6" strokeWidth={1.6} />
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
      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-[var(--hairline)] bg-white/80 pb-[env(safe-area-inset-bottom)] backdrop-blur-2xl md:hidden" aria-label="主要メニュー">
        {primary.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `tab-item relative flex flex-col items-center gap-0.5 pb-1 pt-2 text-[10px] font-medium ${isActive ? 'text-[var(--accent)]' : 'text-slate-500'}`}>
            {({ isActive }) => (
              <>
                <Icon name={n.icon} className={`h-6 w-6 ${isActive ? 'tab-pop' : ''}`} strokeWidth={1.6} />
                {short(n.label)}
                {(() => {
                  const b = navBadge(n.to, counts);
                  if (!b) return null;
                  const bg = b.tone === 'orange' ? 'bg-[#ff3b30] text-white' : b.tone === 'blue' ? 'bg-[var(--accent)] text-white' : 'bg-[#8e8e93] text-white';
                  return <span className={`pop-in absolute left-1/2 top-0.5 ml-1.5 rounded-full px-1.5 text-[10px] font-semibold tabular-nums ${bg}`}>{b.n > 99 ? '99+' : b.n}</span>;
                })()}
              </>
            )}
          </NavLink>
        ))}
        <button type="button" onClick={() => setOpen((v) => !v)} className={`tab-item flex flex-col items-center gap-0.5 pb-1 pt-2 text-[10px] font-medium ${open || restActive ? 'text-[var(--accent)]' : 'text-slate-500'}`} aria-expanded={open}>
          <Icon name={open ? 'close' : 'menu'} className={`h-6 w-6 transition-transform duration-300 ${open ? 'rotate-90' : ''}`} strokeWidth={1.6} />
          その他
        </button>
      </nav>
    </>
  );
}
