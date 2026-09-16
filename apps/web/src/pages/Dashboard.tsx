import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { channelBadge, channelLabel, fmtDateTime, fmtRelative } from '../lib/format';
import { ALERT_TYPE_LABEL, TASK_STATUS_LABEL, EVENT_KIND_LABEL, type AlertType, type TaskStatus, type EventKind } from '@lcm/shared';
import { Icon, type IconName } from '../lib/icons';
import { DeadlineEditor } from '../lib/Deadline';

interface DashboardData {
  alerts: { id: number; type: string; title: string; body: string | null; createdAt: string }[];
  alertCounts: Record<string, number>;
  waiting: { id: number; title: string; status: string; clientId: number | null; clientName: string | null; caseId: number | null; caseTitle: string | null; followUpAt: string | null; waitingSince: string | null; conversationId: number | null }[];
  needsReply: number;
  /** 未完了のタスク（対応中＋返信待ち） */
  activeTasks: number;
  /** 対応中のタスクだけ（返信待ちは別のタイルで数えるので重複させない） */
  openTasks: number;
  todaysEvents: { id: number; title: string; startAt: string; kind: string; clientName: string | null; location: string | null }[];
  /** 直前の行動（記録・送受信・タスク）。新しい順 */
  recent: RecentItem[];
  lineQuota: { used: number; limit: number } | null;
  demo?: boolean;
}

interface RecentItem {
  at: string;
  kind: 'note' | 'sent' | 'received' | 'task' | 'task_done';
  label: string;
  title: string;
  clientId: number | null;
  clientName: string | null;
  caseId: number | null;
  caseTitle: string | null;
  to: string;
}

/** 行動の種類ごとの目印。記録だけ色を付けて、事件記録を見つけやすくする */
const RECENT_MARK: Record<RecentItem['kind'], { icon: string; badge: string }> = {
  note: { icon: '📝', badge: 'badge badge-blue' },
  sent: { icon: '↗', badge: 'badge badge-gray' },
  received: { icon: '↘', badge: 'badge badge-gray' },
  task: { icon: '☑', badge: 'badge badge-gray' },
  task_done: { icon: '✓', badge: 'badge badge-gray' },
};

export default function Dashboard() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<DashboardData>('/dashboard'), refetchInterval: 60_000 });
  const qc = useQueryClient();
  const setDeadline = useMutation({
    mutationFn: (v: { id: number; followUpAt: string }) => api.put(`/tasks/${v.id}`, { followUpAt: v.followUpAt }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
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
      <div className="flex flex-wrap items-baseline gap-3">
        <h1>ダッシュボード</h1>
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
        <Stat label="タスク" value={d.openTasks} to="/tasks?status=open" icon="check" tone={d.openTasks ? 'green' : 'gray'} />
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
        <ScheduledSection />
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
                    <td className="py-1.5 pr-2">
                      {t.clientId ? (
                        <Link to={`/clients/${t.clientId}`} className="text-[var(--accent)] hover:underline">
                          {t.clientName}
                        </Link>
                      ) : (
                        <span className="text-slate-500">{t.clientName ?? ''}</span>
                      )}
                      {t.caseId && (
                        <Link to={`/cases/${t.caseId}`} className="ml-1 text-xs text-slate-500 hover:text-[var(--accent)] hover:underline">
                          {t.caseTitle ?? '事件'}
                        </Link>
                      )}
                    </td>
                    <td className="py-1.5 pr-2">
                      {t.conversationId ? (
                        <Link to={`/inbox/${t.conversationId}`} className="hover:underline">
                          {t.title}
                        </Link>
                      ) : t.caseId ? (
                        <Link to={`/cases/${t.caseId}`} className="hover:underline">
                          {t.title}
                        </Link>
                      ) : (
                        <Link to="/tasks" className="hover:underline">
                          {t.title}
                        </Link>
                      )}
                    </td>
                    <td className="py-1.5 pr-2 text-slate-500">{TASK_STATUS_LABEL[t.status as TaskStatus]}</td>
                    <td className="py-1.5 pr-2 text-slate-500">{t.waitingSince ? `${fmtRelative(t.waitingSince)}から` : ''}</td>
                    <td className="py-1.5">
                      <DeadlineEditor compact value={t.followUpAt} onChange={(iso) => setDeadline.mutate({ id: t.id, followUpAt: iso })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
        <section className="card md:col-span-2">
          <h2 className="mb-2 flex items-center gap-1.5 font-semibold">
            <Icon name="clock" className="h-4 w-4 text-[var(--accent)]" />
            最近の動き
            <Link to="/cases" className="ml-auto text-xs font-normal text-blue-700 hover:underline">
              事件の一覧 →
            </Link>
          </h2>
          {d.recent.length === 0 && <div className="text-sm text-slate-500">まだ記録・やり取りがありません</div>}
          <ul className="divide-y divide-slate-100 text-sm">
            {d.recent.map((r) => (
              <li key={`${r.kind}-${r.at}-${r.to}`}>
                <Link to={r.to} className="flex flex-wrap items-center gap-2 py-1.5 hover:text-[var(--accent)]">
                  <span className="w-16 shrink-0 text-xs tabular-nums text-slate-500">{fmtRelative(r.at)}</span>
                  <span className={RECENT_MARK[r.kind].badge}>
                    {RECENT_MARK[r.kind].icon} {r.label}
                  </span>
                  {(r.clientName || r.caseTitle) && (
                    <span className="font-medium">
                      {r.clientName ?? ''}
                      {r.caseTitle && <span className="ml-1 text-xs font-normal text-slate-500">{r.caseTitle}</span>}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-slate-500">{r.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

interface ScheduledItem {
  id: number;
  text: string;
  scheduledAt: string;
  status: string;
  error: string | null;
  conversation: { id: number; channel: string; subject: string | null; counterpartName: string | null; clientName: string | null };
}

/** 送信予約（未送信のもの）。予約が無ければ何も出さない */
function ScheduledSection() {
  const q = useQuery({ queryKey: ['scheduled-messages'], queryFn: () => api.get<ScheduledItem[]>('/scheduled-messages'), refetchInterval: 60_000 });
  const items = q.data ?? [];
  if (items.length === 0) return null;
  return (
    <section className="card md:col-span-2">
      <h2 className="mb-2 flex items-center gap-1.5 font-semibold">
        <Icon name="clock" className="h-4 w-4 text-[var(--accent)]" />
        送信予約
        <span className="badge badge-blue">{items.length}</span>
      </h2>
      <ul className="divide-y divide-slate-100 text-sm">
        {items.slice(0, 8).map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2 py-1.5">
            <span className={`badge ${s.status === 'failed' ? 'badge-orange' : 'badge-blue'}`}>{s.status === 'failed' ? '失敗' : '予約中'}</span>
            <span className="tabular-nums">{fmtDateTime(s.scheduledAt)}</span>
            <span className={channelBadge(s.conversation.channel)}>{channelLabel(s.conversation.channel)}</span>
            <Link to={`/inbox/${s.conversation.id}`} className="min-w-0 flex-1 truncate hover:underline">
              <span className="font-medium">{s.conversation.clientName ?? s.conversation.counterpartName ?? s.conversation.subject ?? '相手'}</span>
              <span className="ml-2 text-slate-500">{s.text.replace(/\s+/g, ' ').slice(0, 60)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {items.length > 8 && <div className="mt-1 text-xs text-slate-400">ほか {items.length - 8} 件</div>}
    </section>
  );
}

/** 数字タイルの色み。0 件のときは灰にして、目が行かないようにする */
const STAT_TONE: Record<string, { value: string; icon: string }> = {
  blue: { value: 'text-[var(--accent)]', icon: 'bg-[var(--accent-soft)] text-[var(--accent)]' },
  orange: { value: 'text-[var(--warn)]', icon: 'bg-[var(--warn-soft)] text-[var(--warn)]' },
  green: { value: 'text-[var(--ok)]', icon: 'bg-[var(--ok-soft)] text-[var(--ok)]' },
  gray: { value: 'text-[var(--text-2)]', icon: 'bg-[var(--surface-3)] text-[var(--text-3)]' },
};

function Stat({ label, value, to, icon, tone = 'blue' }: { label: string; value: number | string; to?: string; icon?: IconName; tone?: 'blue' | 'orange' | 'gray' | 'green' }) {
  const t = STAT_TONE[tone];
  const inner = (
    <div className={`card flex items-center gap-3.5 ${to ? 'card-press' : ''}`}>
      {icon && (
        <span className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] ${t.icon}`}>
          <Icon name={icon} className="h-[22px] w-[22px]" strokeWidth={1.9} />
        </span>
      )}
      <div className="min-w-0">
        <div className="eyebrow">{label}</div>
        <div className={`mt-1 text-[30px] font-semibold leading-none tabular-nums tracking-[-0.03em] ${t.value}`}>{value}</div>
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
