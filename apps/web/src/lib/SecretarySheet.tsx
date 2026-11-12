import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { Icon } from './icons';
import { type SecretaryContext } from './Secretary';
import { SearchPanel } from '../pages/Search';

/** いま開いている画面から、秘書に渡す相手（依頼者・事件・会話）を決める */
function useScreenContext(pathname: string): { context: SecretaryContext | null; label: string | null } {
  const m = /^\/(clients|cases|inbox)\/(\d+)/.exec(pathname);
  const kind = m?.[1] ?? null;
  const id = m?.[2] ?? '';
  // それぞれの画面と同じキーで読む（開いている画面の分は読み込み済みなので、通信は増えない）
  const client = useQuery({ queryKey: ['client', id], queryFn: () => api.get<{ id: number; name: string }>(`/clients/${id}`), enabled: kind === 'clients' });
  const kase = useQuery({ queryKey: ['case', id], queryFn: () => api.get<{ id: number; title: string; client: { id: number; name: string } | null }>(`/cases/${id}`), enabled: kind === 'cases' });
  const conv = useQuery({
    queryKey: ['conversation', id],
    queryFn: () => api.get<{ id: number; counterpartName: string | null; client: { id: number; name: string } | null; contact?: { name: string } | null }>(`/conversations/${id}`),
    enabled: kind === 'inbox',
  });
  if (kind === 'clients') return { context: { clientId: Number(id) }, label: client.data ? `依頼者 ${client.data.name}` : '依頼者' };
  if (kind === 'cases') return { context: { caseId: Number(id) }, label: kase.data ? `${kase.data.client ? `${kase.data.client.name} ／ ` : ''}${kase.data.title}` : '事件' };
  if (kind === 'inbox') {
    const who = conv.data ? (conv.data.contact?.name ?? conv.data.client?.name ?? conv.data.counterpartName ?? '相手') : null;
    return { context: { conversationId: Number(id) }, label: who ? `${who} との会話` : '会話' };
  }
  return { context: null, label: null };
}

/**
 * どの画面からでも開ける AI 秘書（スマホは下から出るシート、パソコンは右から出る欄）。
 * 依頼者・事件・会話の画面で開くと、その相手のことだと秘書に伝わる（名前を言わずに頼める）
 */
export function SecretarySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const loc = useLocation();
  // 開いていた画面（シートを開いたまま画面を移っても、開いたときの画面を相手にする）
  const [path, setPath] = useState(loc.pathname);
  const [useCtx, setUseCtx] = useState(true);
  // 一度開いたら中身は残す（閉じて画面を見てから開き直しても、作ってもらった案が消えないように）
  const [ever, setEver] = useState(open);
  const [visible, setVisible] = useState(open);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (open) {
      // 別の画面で開き直したら、その画面の相手にする
      if (loc.pathname !== path) {
        setPath(loc.pathname);
        setUseCtx(true);
      }
      setEver(true);
      setVisible(true);
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const t = setTimeout(() => setVisible(false), 380);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // 登録したもののリンクを押して画面を移ったら閉じる
  useEffect(() => {
    if (open && loc.pathname !== path) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  const { context, label } = useScreenContext(path);
  if (!ever) return null;
  return (
    <div className={`sheet-backdrop fixed inset-0 z-50 ${shown ? 'is-open' : ''} ${open ? '' : 'pointer-events-none'}`} style={visible ? undefined : { display: 'none' }} onClick={onClose} aria-hidden={!open}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="AI 秘書"
        className={`absolute flex flex-col bg-[var(--bg)] shadow-[0_-8px_40px_rgba(0,0,0,0.18)] transition-transform duration-300 ease-out
          inset-x-0 bottom-0 max-h-[90dvh] rounded-t-[22px] pb-[env(safe-area-inset-bottom)] ${shown ? 'translate-y-0' : 'translate-y-full'}
          md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[520px] md:rounded-none md:rounded-l-[18px] md:pb-0 ${shown ? 'md:translate-x-0' : 'md:translate-x-full'} md:translate-y-0`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-slate-300 md:hidden" />
        <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-2 md:pt-4">
          <Icon name="sparkle" className="h-5 w-5 text-[var(--accent)]" />
          <h2 className="font-semibold">AI 秘書</h2>
          <button type="button" className="btn btn-sm ml-auto" onClick={onClose} aria-label="閉じる">
            <Icon name="close" className="h-4 w-4" />
          </button>
        </div>
        {context && label && (
          <div className="mx-4 mb-2 flex shrink-0 items-center gap-2 rounded-lg bg-[var(--accent-soft)] px-2.5 py-1.5 text-xs">
            {useCtx ? (
              <>
                <span className="text-slate-500">この画面:</span>
                <span className="min-w-0 flex-1 truncate font-medium text-[var(--accent)]">{label}</span>
                <button type="button" className="shrink-0 text-slate-500 hover:text-slate-800" onClick={() => setUseCtx(false)} title="この画面の相手に決めずに頼みます">
                  外す
                </button>
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 text-slate-500">画面の相手に決めずに頼みます</span>
                <button type="button" className="shrink-0 text-blue-700 hover:underline" onClick={() => setUseCtx(true)}>
                  「{label}」にする
                </button>
              </>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
          {/* 頼む・AI に聞く・そのまま探す を切り替えられる */}
          <SearchPanel embedded secretary={{ context: useCtx ? context : null, compact: true, autoFocus: open }} />
        </div>
      </div>
    </div>
  );
}
