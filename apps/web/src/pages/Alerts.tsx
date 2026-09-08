import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { ClientPicker } from '../lib/ClientPicker';
import { ContactLinkForm } from '../lib/ContactLinkForm';
import { fmtDateTime, fromLocalInput, todayLocalInput } from '../lib/format';
import { ALERT_TYPE_LABEL, type AlertType } from '@lcm/shared';

interface Alert {
  id: number;
  type: string;
  title: string;
  body: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export default function Alerts() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['alerts', 'all'], queryFn: () => api.get<Alert[]>('/alerts'), refetchInterval: 60_000 });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['alerts'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const resolve = useMutation({ mutationFn: (v: { id: number; status: 'resolved' | 'dismissed' }) => api.post(`/alerts/${v.id}/resolve`, { status: v.status }), onSuccess: refresh });
  const link = useMutation({ mutationFn: (v: { conversationId: number; clientId: number }) => api.post(`/conversations/${v.conversationId}/link`, { clientId: v.clientId }), onSuccess: refresh });
  const assign = useMutation({ mutationFn: (v: { attachmentId: number; clientId: number }) => api.post(`/attachments/${v.attachmentId}/assign`, { clientId: v.clientId }), onSuccess: refresh });
  const groups = new Map<string, Alert[]>();
  for (const a of list.data ?? []) groups.set(a.type, [...(groups.get(a.type) ?? []), a]);
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">要確認</h1>
      {list.data?.length === 0 && <div className="card text-slate-500">確認事項はありません</div>}
      {[...groups.entries()].map(([type, items]) => (
        <section key={type} className="card">
          <h2 className="mb-2 font-semibold">
            {ALERT_TYPE_LABEL[type as AlertType] ?? (type === 'creditor_overdue' ? '債権者対応の期限超過' : type)} <span className="badge badge-orange">{items.length}</span>
          </h2>
          <ul className="space-y-3">
            {items.map((a) => (
              <li key={a.id} className="rounded border border-slate-100 p-3 text-sm">
                <div className="flex items-start gap-2">
                  <div className="flex-1">
                    <div className="font-medium">{a.title}</div>
                    {a.body && <div className="text-slate-600">{a.body}</div>}
                    <div className="text-xs text-slate-400">{fmtDateTime(a.createdAt)}</div>
                  </div>
                  <button className="btn btn-sm" onClick={() => resolve.mutate({ id: a.id, status: 'dismissed' })}>
                    閉じる
                  </button>
                </div>
                <div className="mt-2">
                  {type === 'unlinked_contact' && <LinkAction alert={a} onLink={(clientId) => link.mutate({ conversationId: Number(a.payload.conversationId), clientId })} onContactLinked={refresh} />}
                  {type === 'unassigned_file' && <LinkAction alert={a} label="このファイルの依頼者" onLink={(clientId) => assign.mutate({ attachmentId: Number(a.payload.attachmentId), clientId })} />}
                  {type === 'next_hearing_missing' && <NextHearing alert={a} onDone={refresh} />}
                  {(type === 'waiting_overdue' || type === 'reply_received' || type === 'scheduling_stale') && a.payload.conversationId ? (
                    <Link to={`/inbox/${a.payload.conversationId}`} className="btn btn-sm">
                      会話を開く
                    </Link>
                  ) : null}
                  {type === 'creditor_overdue' && a.payload.caseId ? (
                    <Link to={`/cases/${a.payload.caseId}`} className="btn btn-sm">
                      事件を開く
                    </Link>
                  ) : null}
                  {type === 'line_quota' && (
                    <Link to="/settings" className="btn btn-sm">
                      設定を確認
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function LinkAction({ alert, onLink, onContactLinked, label = '依頼者に紐付け' }: { alert: Alert; onLink: (clientId: number) => void; onContactLinked?: () => void; label?: string }) {
  const [id, setId] = useState('');
  const [mode, setMode] = useState<'client' | 'contact'>('client');
  const conversationId = alert.payload.conversationId ? Number(alert.payload.conversationId) : null;
  // 会話の未紐付けは「依頼者本人」か「事件の関係者（相手方・相手方代理人など）」かを選べる
  if (onContactLinked && conversationId) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1">
            <input type="radio" name={`mode-${alert.id}`} checked={mode === 'client'} onChange={() => setMode('client')} /> 依頼者本人
          </label>
          <label className="flex items-center gap-1" title="相手方・相手方代理人・裁判所・保険会社など、依頼者以外の相手">
            <input type="radio" name={`mode-${alert.id}`} checked={mode === 'contact'} onChange={() => setMode('contact')} /> 事件の関係者
          </label>
          <Link to={`/inbox/${conversationId}`} className="btn btn-sm">
            会話を開く
          </Link>
        </div>
        {mode === 'client' ? (
          <div className="flex flex-wrap items-center gap-2">
            <ClientPicker value={id} onChange={setId} emptyLabel={`${label}…`} />
            <button className="btn btn-primary btn-sm" disabled={!id} onClick={() => onLink(Number(id))}>
              紐付ける
            </button>
            <Link to={`/clients?new=${encodeURIComponent(String(alert.payload.displayName ?? ''))}`} className="btn btn-sm">
              新規依頼者を登録
            </Link>
          </div>
        ) : (
          <ContactLinkForm conversationId={conversationId} defaultName={String(alert.payload.displayName ?? '')} onDone={onContactLinked} />
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ClientPicker value={id} onChange={setId} emptyLabel={`${label}…`} />
      <button className="btn btn-primary btn-sm" disabled={!id} onClick={() => onLink(Number(id))}>
        紐付ける
      </button>
      {alert.payload.conversationId ? (
        <Link to={`/inbox/${alert.payload.conversationId}`} className="btn btn-sm">
          会話を開く
        </Link>
      ) : null}
      <Link to={`/clients?new=${encodeURIComponent(String(alert.payload.displayName ?? ''))}`} className="btn btn-sm">
        新規依頼者を登録
      </Link>
    </div>
  );
}

function NextHearing({ alert, onDone }: { alert: Alert; onDone: () => void }) {
  const [start, setStart] = useState(todayLocalInput(10));
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [err, setErr] = useState('');
  const register = useMutation({
    mutationFn: (decision: 'register' | 'undecided') => api.post('/court/next-hearing', { alertId: alert.id, decision, startAt: fromLocalInput(start), title: title || undefined, location: location || undefined }),
    onSuccess: onDone,
    onError: (e) => setErr((e as Error).message),
  });
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <label className="label">次回期日</label>
        <input type="datetime-local" className="input" value={start} onChange={(e) => setStart(e.target.value)} />
      </div>
      <div>
        <label className="label">予定名（空なら「姓 期日」）</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例: 山田 第4回弁論" />
      </div>
      <div>
        <label className="label">場所</label>
        <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="例: 奈良地裁 302号" />
      </div>
      <button className="btn btn-primary btn-sm" onClick={() => register.mutate('register')}>
        カレンダーに登録
      </button>
      <button className="btn btn-sm" onClick={() => register.mutate('undecided')}>
        次回期日は未定（追って指定）
      </button>
      {alert.payload.clientId ? (
        <Link to={`/inbox?clientId=${alert.payload.clientId}`} className="btn btn-sm">
          期日報告を送る
        </Link>
      ) : null}
      {err && <div className="text-red-600">{err}</div>}
    </div>
  );
}
