import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { EVENT_KINDS, EVENT_KIND_LABEL, type EventKind } from '@lcm/shared';
import { api } from '../lib/api';
import { toLocalInput, fromLocalInput } from '../lib/format';

interface Ev {
  id: number;
  googleEventId: string;
  clientId: number | null;
  caseId: number | null;
  kind: string;
  title: string;
  startAt: string;
  endAt: string;
  location: string | null;
  description: string | null;
  status: string | null;
  clientName: string | null;
  caseTitle: string | null;
  local: boolean;
}

interface EvInput {
  title: string;
  startAt: string;
  endAt: string;
  kind: EventKind;
  clientId: number | null;
  caseId: number | null;
  location: string | null;
  description: string | null;
  tentative: boolean;
}

type View = 'week' | 'month' | 'list';

const JST = 9 * 3600_000;
const WD = ['日', '月', '火', '水', '木', '金', '土'];

/** ISO → JST の日付キー (YYYY-MM-DD) */
function dayKey(iso: string): string {
  return new Date(new Date(iso).getTime() + JST).toISOString().slice(0, 10);
}
function keyToDate(key: string): Date {
  return new Date(`${key}T00:00:00+09:00`);
}
function addDays(key: string, n: number): string {
  return dayKey(new Date(keyToDate(key).getTime() + n * 86400_000).toISOString());
}
function todayKey(): string {
  return dayKey(new Date().toISOString());
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
}
function fmtDayHeading(key: string): string {
  const d = keyToDate(key);
  const j = new Date(d.getTime() + JST);
  return `${j.getUTCMonth() + 1}/${j.getUTCDate()}(${WD[j.getUTCDay()]})`;
}

/** 表示範囲（JST の日付キーで [from, to) ） */
function rangeFor(view: View, anchor: string): { from: string; to: string; label: string } {
  if (view === 'week') {
    const d = keyToDate(anchor);
    const dow = new Date(d.getTime() + JST).getUTCDay();
    const from = addDays(anchor, -((dow + 6) % 7)); // 月曜始まり
    const to = addDays(from, 7);
    return { from, to, label: `${fmtDayHeading(from)} 〜 ${fmtDayHeading(addDays(to, -1))}` };
  }
  if (view === 'month') {
    const from = `${anchor.slice(0, 7)}-01`;
    const j = new Date(keyToDate(from).getTime() + JST);
    const next = new Date(Date.UTC(j.getUTCFullYear(), j.getUTCMonth() + 1, 1));
    const to = next.toISOString().slice(0, 10);
    return { from, to, label: `${j.getUTCFullYear()}年${j.getUTCMonth() + 1}月` };
  }
  const to = addDays(anchor, 28);
  return { from: anchor, to, label: `${fmtDayHeading(anchor)} から 4 週間` };
}

function shift(view: View, anchor: string, dir: 1 | -1): string {
  if (view === 'week') return addDays(anchor, 7 * dir);
  if (view === 'month') {
    const j = new Date(keyToDate(`${anchor.slice(0, 7)}-01`).getTime() + JST);
    return new Date(Date.UTC(j.getUTCFullYear(), j.getUTCMonth() + dir, 1)).toISOString().slice(0, 10);
  }
  return addDays(anchor, 28 * dir);
}

const KIND_BADGE: Record<string, string> = { hearing: 'badge-orange', meeting: 'badge-blue', consult: 'badge-line', hold: 'badge-gray', other: 'badge-gray' };

export default function Calendar() {
  const qc = useQueryClient();
  const [view, setView] = useState<View>(() => {
    try {
      return (localStorage.getItem('lcm-cal-view') as View) || 'week';
    } catch {
      return 'week';
    }
  });
  const [anchor, setAnchor] = useState(todayKey());
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [editing, setEditing] = useState<Ev | 'new' | null>(null);
  const range = useMemo(() => rangeFor(view, anchor), [view, anchor]);
  const list = useQuery({
    queryKey: ['calendar', range.from, range.to],
    queryFn: () => api.get<Ev[]>(`/calendar/events?from=${encodeURIComponent(keyToDate(range.from).toISOString())}&to=${encodeURIComponent(keyToDate(range.to).toISOString())}`),
  });
  const status = useQuery({ queryKey: ['status'], queryFn: () => api.get<{ google?: { connected?: boolean } }>('/status') });
  const googleConnected = !!status.data?.google?.connected;
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['calendar'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const changeView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem('lcm-cal-view', v);
    } catch {
      /* noop */
    }
  };
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/calendar/events/${id}`),
    onSuccess: () => {
      invalidate();
      setMsg({ kind: 'ok', text: '予定を削除しました' });
    },
    onError: (e) => setMsg({ kind: 'err', text: (e as Error).message }),
  });
  const sync = useMutation({
    mutationFn: () => api.post<{ synced: number }>('/calendar/sync'),
    onSuccess: (r) => {
      invalidate();
      setMsg({ kind: 'ok', text: `Google カレンダーと同期しました（${r.synced} 件）` });
    },
    onError: (e) => setMsg({ kind: 'err', text: (e as Error).message }),
  });

  // 日付ごとにまとめる（表示範囲の全日を出す。月・4週間表示は予定のある日だけ）
  const days = useMemo(() => {
    const byDay = new Map<string, Ev[]>();
    for (const e of list.data ?? []) {
      const k = dayKey(e.startAt);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k)!.push(e);
    }
    const out: { key: string; events: Ev[] }[] = [];
    if (view === 'week') {
      for (let k = range.from; k < range.to; k = addDays(k, 1)) out.push({ key: k, events: byDay.get(k) ?? [] });
    } else {
      for (const k of [...byDay.keys()].sort()) out.push({ key: k, events: byDay.get(k)! });
    }
    return out;
  }, [list.data, view, range]);

  const today = todayKey();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">予定</h1>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <select className="input w-auto" value={view} onChange={(e) => changeView(e.target.value as View)}>
            <option value="week">週</option>
            <option value="month">月</option>
            <option value="list">4 週間の一覧</option>
          </select>
          <button className="btn" onClick={() => setAnchor(shift(view, anchor, -1))} aria-label="前へ">
            ◀
          </button>
          <button className="btn" onClick={() => setAnchor(today)}>
            今日
          </button>
          <button className="btn" onClick={() => setAnchor(shift(view, anchor, 1))} aria-label="次へ">
            ▶
          </button>
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            ＋ 予定を追加
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
        <span className="font-medium">{range.label}</span>
        {googleConnected ? (
          <button className="btn btn-sm ml-auto" onClick={() => sync.mutate()} disabled={sync.isPending}>
            {sync.isPending ? '同期中…' : 'Google カレンダーと同期'}
          </button>
        ) : (
          <span className="ml-auto text-xs text-slate-500">Google 未接続のため、ここで登録した予定はアプリ内だけに保存されます（初期設定で接続すると Google カレンダーにも登録されます）</span>
        )}
      </div>
      {msg && <div className={`rounded-md px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'}`}>{msg.text}</div>}

      {editing && (
        <EventForm
          initial={editing === 'new' ? null : editing}
          defaultDay={view === 'week' || view === 'list' ? (anchor >= range.from && anchor < range.to ? anchor : range.from) : range.from}
          onClose={() => setEditing(null)}
          onSaved={(text) => {
            setEditing(null);
            invalidate();
            setMsg({ kind: 'ok', text });
          }}
          onError={(text) => setMsg({ kind: 'err', text })}
        />
      )}

      {list.isLoading && <div className="text-sm text-slate-500">読み込み中…</div>}
      {!list.isLoading && days.length === 0 && <div className="card text-sm text-slate-500">この期間に予定はありません</div>}
      <div className="space-y-3">
        {days.map((d) => (
          <section key={d.key} className={`card ${d.events.length === 0 ? 'py-2' : ''} ${d.key === today ? 'border-blue-300' : ''}`}>
            <h2 className={`flex items-center gap-2 font-semibold ${d.events.length ? 'mb-2' : ''} ${d.key === today ? 'text-blue-700' : ''}`}>
              {fmtDayHeading(d.key)}
              {d.key === today && <span className="badge badge-blue">今日</span>}
              <button className="btn btn-sm ml-auto" onClick={() => setEditing({ ...emptyEv(d.key), id: 0 })} title="この日に予定を追加">
                ＋
              </button>
            </h2>
            {d.events.length === 0 && <div className="-mt-1 text-sm text-slate-400">予定なし</div>}
            <ul className="divide-y divide-slate-100">
              {d.events.map((e) => (
                <li key={e.id} className="py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="whitespace-nowrap text-slate-600 md:w-24">
                      {fmtTime(e.startAt)}〜{fmtTime(e.endAt)}
                    </span>
                    <span className={`badge ${KIND_BADGE[e.kind] ?? 'badge-gray'}`}>{EVENT_KIND_LABEL[e.kind as EventKind] ?? e.kind}</span>
                    <span className={`min-w-0 flex-1 font-medium ${e.status === 'tentative' ? 'text-slate-500' : ''}`}>
                      {e.title}
                      {e.status === 'tentative' && <span className="ml-1 text-xs font-normal text-slate-400">（仮）</span>}
                      {e.local && (
                        <span className="ml-1 text-xs font-normal text-slate-400" title="Google カレンダーには登録されていません">
                          アプリ内
                        </span>
                      )}
                    </span>
                    <div className="ml-auto flex gap-1">
                      <button className="btn btn-sm" onClick={() => setEditing(e)}>
                        編集
                      </button>
                      <button
                        className="btn btn-sm text-red-600"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (window.confirm(`「${e.title}」を削除しますか？${e.local ? '' : '\nGoogle カレンダーからも削除されます。'}`)) remove.mutate(e.id);
                        }}
                      >
                        削除
                      </button>
                    </div>
                  </div>
                  {(e.clientId || e.caseId || e.location) && (
                    <div className="mt-0.5 text-xs text-slate-500 md:pl-[6.5rem]">
                      {e.clientId && (
                        <Link to={`/clients/${e.clientId}`} className="text-blue-700 hover:underline">
                          {e.clientName ?? '依頼者'}
                        </Link>
                      )}
                      {e.caseId && (
                        <>
                          {e.clientId ? ' / ' : ''}
                          <Link to={`/cases/${e.caseId}`} className="text-blue-700 hover:underline">
                            {e.caseTitle ?? '事件'}
                          </Link>
                        </>
                      )}
                      {e.location && <span className="ml-2">📍 {e.location}</span>}
                    </div>
                  )}
                  {e.description && <div className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-xs text-slate-500 md:pl-[6.5rem]">{e.description}</div>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function emptyEv(day: string): Ev {
  const start = new Date(`${day}T10:00:00+09:00`);
  return {
    id: 0,
    googleEventId: '',
    clientId: null,
    caseId: null,
    kind: 'meeting',
    title: '',
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 3600_000).toISOString(),
    location: null,
    description: null,
    status: 'confirmed',
    clientName: null,
    caseTitle: null,
    local: false,
  };
}

function EventForm({ initial, defaultDay, onClose, onSaved, onError }: { initial: Ev | null; defaultDay: string; onClose: () => void; onSaved: (msg: string) => void; onError: (msg: string) => void }) {
  const base = initial ?? emptyEv(defaultDay);
  const isEdit = !!initial && initial.id > 0;
  const [title, setTitle] = useState(base.title);
  const [kind, setKind] = useState<EventKind>((base.kind as EventKind) ?? 'meeting');
  const [start, setStart] = useState(toLocalInput(base.startAt));
  const [end, setEnd] = useState(toLocalInput(base.endAt));
  const [clientId, setClientId] = useState(base.clientId ? String(base.clientId) : '');
  const [caseId, setCaseId] = useState(base.caseId ? String(base.caseId) : '');
  const [location, setLocation] = useState(base.location ?? '');
  const [description, setDescription] = useState(base.description ?? '');
  const [tentative, setTentative] = useState(base.status === 'tentative');
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => api.get<{ id: number; name: string }[]>('/clients') });
  const cases = useQuery({ queryKey: ['cases', 'open'], queryFn: () => api.get<{ id: number; title: string; clientId: number; clientName: string }[]>('/cases?status=open') });
  const caseOptions = (cases.data ?? []).filter((c) => !clientId || c.clientId === Number(clientId));

  // 開始を動かしたら終了も同じ長さで追従
  const changeStart = (v: string) => {
    const prevStart = new Date(fromLocalInput(start)).getTime();
    const prevEnd = new Date(fromLocalInput(end)).getTime();
    const dur = Number.isFinite(prevEnd - prevStart) && prevEnd > prevStart ? prevEnd - prevStart : 3600_000;
    setStart(v);
    if (v) setEnd(toLocalInput(new Date(new Date(fromLocalInput(v)).getTime() + dur).toISOString()));
  };

  const save = useMutation({
    mutationFn: () => {
      const body: EvInput = {
        title,
        kind,
        startAt: fromLocalInput(start),
        endAt: fromLocalInput(end),
        clientId: clientId ? Number(clientId) : null,
        caseId: caseId ? Number(caseId) : null,
        location: location || null,
        description: description || null,
        tentative,
      };
      return isEdit ? api.put(`/calendar/events/${initial!.id}`, body) : api.post('/calendar/events', body);
    },
    onSuccess: () => onSaved(isEdit ? '予定を更新しました' : '予定を登録しました'),
    onError: (e) => onError((e as Error).message),
  });

  return (
    <form
      className="card space-y-3 border-blue-200"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">{isEdit ? '予定を編集' : '予定を追加'}</h2>
        <button type="button" className="btn btn-sm ml-auto" onClick={onClose}>
          閉じる
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="md:col-span-2">
          <label className="label">件名</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例: 山田 第2回調停期日" required autoFocus />
        </div>
        <div>
          <label className="label">種別</label>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as EventKind)}>
            {EVENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {EVENT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-3">
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={tentative} onChange={(e) => setTentative(e.target.checked)} /> 仮押さえ（未確定）
          </label>
        </div>
        <div>
          <label className="label">開始</label>
          <input type="datetime-local" className="input" value={start} onChange={(e) => changeStart(e.target.value)} required />
        </div>
        <div>
          <label className="label">終了</label>
          <input type="datetime-local" className="input" value={end} onChange={(e) => setEnd(e.target.value)} required />
        </div>
        <div>
          <label className="label">依頼者</label>
          <select
            className="input"
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
              setCaseId('');
            }}
          >
            <option value="">（なし）</option>
            {clients.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">事件</label>
          <select className="input" value={caseId} onChange={(e) => setCaseId(e.target.value)}>
            <option value="">（なし）</option>
            {caseOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {clientId ? c.title : `${c.clientName} / ${c.title}`}
              </option>
            ))}
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="label">場所</label>
          <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="例: 奈良地方裁判所 / 事務所 / Zoom" />
        </div>
        <div className="md:col-span-2">
          <label className="label">メモ</label>
          <textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button className="btn btn-primary" disabled={save.isPending}>
          {save.isPending ? '保存中…' : isEdit ? '更新' : '登録'}
        </button>
        <span className="text-xs text-slate-500">種別を「期日」にして事件を選ぶと、事件の次回期日にも反映されます。</span>
      </div>
    </form>
  );
}
