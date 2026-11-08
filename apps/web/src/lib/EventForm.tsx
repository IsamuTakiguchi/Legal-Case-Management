import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { EVENT_KINDS, EVENT_KIND_LABEL, type EventKind } from '@lcm/shared';
import { api } from './api';
import { useDraftGroup, DraftHint } from './draft';
import { ClientPicker } from './ClientPicker';
import { toLocalInput, fromLocalInput } from './format';

/** 予定のフォームに渡す予定（予定ページ・依頼者ページ・事件ページで共通） */
export interface EventFormValue {
  id: number;
  title: string;
  kind: string;
  startAt: string;
  endAt: string;
  clientId: number | null;
  caseId: number | null;
  location: string | null;
  description: string | null;
  status: string | null;
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

/** 新しく追加するときの初期値（その日の 10:00〜11:00） */
function emptyValue(day: string): EventFormValue {
  const start = new Date(`${day}T10:00:00+09:00`);
  return { id: 0, title: '', kind: 'meeting', startAt: start.toISOString(), endAt: new Date(start.getTime() + 3600_000).toISOString(), clientId: null, caseId: null, location: null, description: null, status: 'confirmed' };
}

/**
 * 予定の追加・編集。initial に予定を渡すと編集、null なら defaultDay の予定を追加する。
 * 予定ページ・依頼者ページ・事件ページから使う
 */
export function EventForm({
  initial,
  defaultDay,
  narrow = false,
  onClose,
  onSaved,
  onError,
}: {
  initial: EventFormValue | null;
  defaultDay: string;
  /** 狭い欄（事件ページの右の列など）に出すとき。項目を 1 列に並べる */
  narrow?: boolean;
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const base = initial ?? emptyValue(defaultDay);
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
  // 入力途中の内容を自動保存する（元の予定が変わっていたら戻さない）
  const draft = useDraftGroup(isEdit ? `event:${initial!.id}:edit` : `event:new:${defaultDay}`, {
    title: { value: title, set: setTitle, base: base.title },
    location: { value: location, set: setLocation, base: base.location ?? '' },
    description: { value: description, set: setDescription, base: base.description ?? '' },
  });
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
    onSuccess: () => {
      draft.clear();
      onSaved(isEdit ? '予定を更新しました' : '予定を登録しました');
    },
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
      <div className={`grid gap-3 ${narrow ? '' : 'md:grid-cols-2'}`}>
        <div className={narrow ? "" : "md:col-span-2"}>
          <label className="label">件名</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例: 山田 第2回調停期日" required autoFocus />
          <DraftHint handle={draft} />
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
          <ClientPicker
            value={clientId}
            onChange={(v) => {
              setClientId(v);
              setCaseId('');
            }}
            emptyLabel="（なし）"
            selectClassName="min-w-48 flex-1"
          />
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
        <div className={narrow ? "" : "md:col-span-2"}>
          <label className="label">場所</label>
          <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="例: 奈良地方裁判所 / 事務所 / Zoom" />
        </div>
        <div className={narrow ? "" : "md:col-span-2"}>
          <label className="label">メモ</label>
          <textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button className="btn btn-primary shrink-0 whitespace-nowrap" disabled={save.isPending}>
          {save.isPending ? '保存中…' : isEdit ? '更新' : '登録'}
        </button>
        <span className="text-xs text-slate-500">種別を「期日」にして事件を選ぶと、事件の次回期日にも反映されます。</span>
      </div>
    </form>
  );
}
