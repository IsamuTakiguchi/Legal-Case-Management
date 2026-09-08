import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDateTime, fmtRelative } from '../lib/format';
import { ALERT_TYPE_LABEL, TASK_STATUS_LABEL, EVENT_KIND_LABEL, type AlertType, type TaskStatus, type EventKind } from '@lcm/shared';
import { Icon, type IconName } from '../lib/icons';

interface DashboardData {
  alerts: { id: number; type: string; title: string; body: string | null; createdAt: string }[];
  alertCounts: Record<string, number>;
  waiting: { id: number; title: string; status: string; clientName: string | null; followUpAt: string | null; waitingSince: string | null; conversationId: number | null }[];
  needsReply: number;
  todaysEvents: { id: number; title: string; startAt: string; kind: string; clientName: string | null; location: string | null }[];
  lineQuota: { used: number; limit: number } | null;
  demo?: boolean;
}

export default function Dashboard() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<DashboardData>('/dashboard'), refetchInterval: 60_000 });
  const status = useQuery({ queryKey: ['status'], queryFn: () => api.get<{ anthropic: { configured: boolean }; google: { connected: boolean }; microsoft: { connected: boolean } }>('/status') });
  const d = q.data;
  if (!d) return <div className="loading-text text-slate-500">読み込み中…</div>;
  const needsSetup = status.data && (!status.data.anthropic.configured || !status.data.google.connected || !status.data.microsoft.connected);
  const now = Date.now();
  const today = new Date(now + 9 * 3600_000);
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const todayLabel = `${today.getUTCMonth() + 1}月${today.getUTCDate()}日（${WD[today.getUTCDay()]}）`;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="text-xl font-bold">ダッシュボード</h1>
        <span className="text-sm text-slate-500">{todayLabel}</span>
      </div>
      {d.demo && (
        <div className="card border-orange-300 bg-orange-50 text-sm">
          デモデータを表示中です（架空の依頼者名には【デモ】が付いています）。本番運用を始める前に{' '}
          <Link to="/settings" className="font-semibold text-blue-700 hover:underline">
            設定 → デモデータ
          </Link>{' '}
          から削除してください。
        </div>
      )}
      {needsSetup && (
        <div className="card border-yellow-300 bg-yellow-50 text-sm">
          まだ接続していないサービスがあります。{' '}
          <Link to="/setup" className="font-semibold text-blue-700 hover:underline">
            初期設定
          </Link>{' '}
          からキーを貼り付けて接続テストを行ってください。
        </div>
      )}
      <div className="stagger grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        <Stat label="未返信の会話" value={d.needsReply} to="/inbox?needsReply=1" icon="mail" tone={d.needsReply ? 'blue' : 'gray'} />
        <Stat label="返信待ち" value={d.waiting.length} to="/tasks" icon="clock" tone={d.waiting.length ? 'blue' : 'gray'} />
        <Stat label="要確認" value={d.alerts.length} to="/alerts" icon="alert" tone={d.alerts.length ? 'orange' : 'gray'} />
        <Stat label="LINE 今月送信" value={d.lineQuota ? `${d.lineQuota.used} / ${d.lineQuota.limit}` : '未設定'} icon="chat" tone="green" />
      </div>
      <div className="stagger grid gap-4 md:grid-cols-2">
        <section className="card">
          <h2 className="mb-2 flex items-center font-semibold">
            今日の予定
            <Link to="/calendar" className="ml-auto text-xs font-normal text-blue-700 hover:underline">
              予定の一覧・登録 →
            </Link>
          </h2>
          {d.todaysEvents.length === 0 && <div className="text-sm text-slate-500">予定はありません</div>}
          <ul className="space-y-1 text-sm">
            {d.todaysEvents.map((e) => (
              <li key={e.id} className="flex items-center gap-2">
                <span className="w-24 text-slate-500">{fmtDateTime(e.startAt).replace(/^.*?\s/, '')}</span>
                <span className="badge badge-gray">{EVENT_KIND_LABEL[e.kind as EventKind] ?? e.kind}</span>
                <span>{e.title}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2 className="mb-2 font-semibold">要確認</h2>
          {d.alerts.length === 0 && <div className="text-sm text-slate-500">確認事項はありません</div>}
          <ul className="space-y-1 text-sm">
            {d.alerts.slice(0, 8).map((a) => (
              <li key={a.id}>
                <Link to="/alerts" className="hover:underline">
                  <span className="badge badge-orange mr-2">{ALERT_TYPE_LABEL[a.type as AlertType] ?? a.type}</span>
                  {a.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <section className="card md:col-span-2">
          <h2 className="mb-2 font-semibold">返信待ち・連絡待ち</h2>
          {d.waiting.length === 0 && <div className="text-sm text-slate-500">返信待ちはありません</div>}
          <table className="w-full text-sm">
            <tbody>
              {d.waiting.map((t) => {
                const over = t.followUpAt && new Date(t.followUpAt).getTime() < now;
                return (
                  <tr key={t.id} className="border-t border-slate-100">
                    <td className="py-1.5 pr-2">{over && <span className="badge badge-orange">期限超過</span>}</td>
                    <td className="py-1.5 pr-2 text-slate-500">{t.clientName ?? ''}</td>
                    <td className="py-1.5 pr-2">{t.conversationId ? <Link to={`/inbox/${t.conversationId}`} className="hover:underline">{t.title}</Link> : t.title}</td>
                    <td className="py-1.5 pr-2 text-slate-500">{TASK_STATUS_LABEL[t.status as TaskStatus]}</td>
                    <td className="py-1.5 text-slate-500">{t.waitingSince ? `${fmtRelative(t.waitingSince)}から` : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

// iOS のアプリアイコン風の色付き角丸に線画アイコンを載せる
const STAT_TONE: Record<string, { value: string; icon: string }> = {
  blue: { value: 'text-[var(--accent)]', icon: 'bg-[var(--accent)] text-white' },
  orange: { value: 'text-[#ff9500]', icon: 'bg-[#ff9500] text-white' },
  green: { value: 'text-[#248a3d]', icon: 'bg-[#34c759] text-white' },
  gray: { value: 'text-[var(--text-2)]', icon: 'bg-black/[0.08] text-[var(--text-2)]' },
};

function Stat({ label, value, to, icon, tone = 'blue' }: { label: string; value: number | string; to?: string; icon?: IconName; tone?: 'blue' | 'orange' | 'gray' | 'green' }) {
  const t = STAT_TONE[tone];
  const inner = (
    <div className={`card flex items-center gap-3.5 ${to ? 'card-press' : ''}`}>
      {icon && (
        <span className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] shadow-[inset_0_-1px_0_rgba(0,0,0,0.08)] ${t.icon}`}>
          <Icon name={icon} className="h-[22px] w-[22px]" strokeWidth={1.9} />
        </span>
      )}
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-slate-500">{label}</div>
        <div className={`mt-0.5 text-[26px] font-semibold leading-none tabular-nums tracking-[-0.02em] ${t.value}`}>{value}</div>
      </div>
    </div>
  );
  return to ? (
    <Link to={to} className="block">
      {inner}
    </Link>
  ) : (
    inner
  );
}
