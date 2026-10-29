import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EVENT_KINDS, EVENT_KIND_LABEL, parseHoldText, isAllDayRange, allDayRange, allDayLastYmd, type EventKind } from '@lcm/shared';
import { api } from './api';
import { useDraftGroup, DraftHint } from './draft';
import { ClientPicker } from './ClientPicker';
import { toLocalInput, fromLocalInput, fmtEventTime } from './format';

/** 事件ページなどから開くときに、依頼者と事件を決め打ちする */
export interface HoldFormFixed {
  clientId: number | null;
  clientName: string | null;
  caseId: number;
  caseTitle: string;
}

/** 「9/21(月) 10:00〜11:00」の形にする（終日なら「9/21(月) 終日」） */
export function fmtEventRange(startAt: string, endAt: string): string {
  if (isAllDayRange(startAt, endAt)) return fmtEventTime(startAt, endAt);
  const d = new Date(startAt);
  const day = d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short' });
  const t = (iso: string) => new Date(iso).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
  return `${day} ${t(startAt)}〜${t(endAt)}`;
}

/** 日程変更（リスケ）のとき、変更する元の予定 */
export interface RescheduleTarget {
  eventId: number;
  title: string;
  startAt: string;
  endAt: string;
  clientName?: string | null;
  caseTitle?: string | null;
  location?: string | null;
}

/** 元の予定の 1 週間後・8 日後の同じ時刻を、日程変更の既定の候補にする */
function rescheduleSlots(t: RescheduleTarget): { start: string; end: string }[] {
  const s0 = new Date(t.startAt).getTime();
  const dur = Math.max(15 * 60_000, new Date(t.endAt).getTime() - s0);
  return [7, 8].map((d) => {
    const start = new Date(s0 + d * 86400_000).toISOString();
    return { start: toLocalInput(start), end: toLocalInput(new Date(new Date(start).getTime() + dur).toISOString()) };
  });
}

/** 候補 1 行。終日なら start・end は日付（YYYY-MM-DD。end は最終日）、それ以外は日時（datetime-local の値） */
export interface SlotDraft {
  start: string;
  end: string;
  allDay?: boolean;
}

const plusMinutes = (local: string, m: number) => toLocalInput(new Date(new Date(fromLocalInput(local)).getTime() + m * 60_000).toISOString());

/** 候補の行を、サーバーに送る開始・終了にする（終日なら最終日の翌日 0:00 まで） */
function slotRange(v: SlotDraft, mins: number): { startAt: string; endAt: string } {
  if (v.allDay) return allDayRange(v.start.slice(0, 10), v.end ? v.end.slice(0, 10) : null);
  const start = new Date(fromLocalInput(v.start));
  const end = v.end ? new Date(fromLocalInput(v.end)) : new Date(start.getTime() + mins * 60_000);
  return { startAt: start.toISOString(), endAt: (end > start ? end : new Date(start.getTime() + mins * 60_000)).toISOString() };
}

/** 読み取った候補（parseHoldText の結果）を行にする */
function parsedToSlot(x: { startAt: string; endAt: string; allDay?: boolean }): SlotDraft {
  return x.allDay ? { start: x.startAt ? toLocalInput(x.startAt).slice(0, 10) : '', end: allDayLastYmd(x.endAt), allDay: true } : { start: toLocalInput(x.startAt), end: toLocalInput(x.endAt) };
}

/**
 * 候補 1 行の入力（開始〜終了、または終日）。
 * 所要時間より長い時間帯は「枠」として押さえ、確定するときにその中で時間を決められる
 */
function SlotRow({ v, mins, onChange, onRemove, canRemove, label }: { v: SlotDraft; mins: number; onChange: (v: SlotDraft) => void; onRemove: () => void; canRemove: boolean; label: string }) {
  const lenMin = !v.allDay && v.start && v.end ? (new Date(fromLocalInput(v.end)).getTime() - new Date(fromLocalInput(v.start)).getTime()) / 60_000 : 0;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {v.allDay ? (
        <>
          <input type="date" className="input w-auto" value={v.start} onChange={(e) => onChange({ ...v, start: e.target.value, end: !v.end || v.end < e.target.value ? e.target.value : v.end })} aria-label={`${label}の日付`} required />
          <span className="text-slate-400">〜</span>
          <input type="date" className="input w-auto" value={v.end} min={v.start} onChange={(e) => onChange({ ...v, end: e.target.value })} aria-label={`${label}の最終日`} title="2 日以上押さえるときだけ変えます" />
        </>
      ) : (
        <>
          <input
            type="datetime-local"
            className="input w-auto"
            value={v.start}
            aria-label={`${label}の開始`}
            onChange={(e) => {
              const start = e.target.value;
              const prevDur = Math.max(15, (new Date(fromLocalInput(v.end)).getTime() - new Date(fromLocalInput(v.start)).getTime()) / 60_000 || mins);
              onChange({ start, end: start ? plusMinutes(start, prevDur) : v.end });
            }}
            required
          />
          <span className="text-slate-400">〜</span>
          <input type="datetime-local" className="input w-auto" value={v.end} aria-label={`${label}の終了`} onChange={(e) => onChange({ ...v, end: e.target.value })} />
        </>
      )}
      <label className="flex items-center gap-1 text-xs text-slate-600" title="時間を決めず、その日 1 日を押さえます">
        <input
          type="checkbox"
          checked={!!v.allDay}
          onChange={(e) => {
            const day = (v.start || toLocalInput(new Date().toISOString())).slice(0, 10);
            onChange(e.target.checked ? { start: day, end: day, allDay: true } : { start: `${day}T10:00`, end: plusMinutes(`${day}T10:00`, mins) });
          }}
        />
        終日
      </label>
      {lenMin > mins && <span className="badge badge-blue" title={`この時間帯の中で ${mins} 分を、確定するときに決めます`}>枠（この中で {mins} 分）</span>}
      <button type="button" className="btn btn-sm" onClick={onRemove} disabled={!canRemove} aria-label={`${label}を外す`}>
        ×
      </button>
    </div>
  );
}

/**
 * 複数候補の仮押さえ。予定ページと事件ページの両方から使う。
 * fixed を渡すと依頼者・事件は選ばず、その事件の仮押さえとして登録する。
 * reschedule を渡すと決まっている予定の日程変更になり、件名・種別・依頼者・事件は元の予定から引き継ぐ。
 */
export function HoldForm({
  defaultDay,
  fixed = null,
  reschedule = null,
  onClose,
  onSaved,
  onError,
}: {
  defaultDay: string;
  fixed?: HoldFormFixed | null;
  reschedule?: RescheduleTarget | null;
  onClose: () => void;
  /** 登録できたら知らせる。sessionId は、そのまま候補日の打診へ進むときに使う */
  onSaved: (msg: string, sessionId?: number) => void;
  onError: (msg: string) => void;
}) {
  const [title, setTitle] = useState('打合せ');
  const [kind, setKind] = useState<EventKind>('meeting');
  const [clientId, setClientId] = useState(fixed?.clientId ? String(fixed.clientId) : '');
  const [caseId, setCaseId] = useState(fixed ? String(fixed.caseId) : '');
  const [counterpartName, setCounterpartName] = useState('');
  const [location, setLocation] = useState(reschedule?.location ?? '');
  const [note, setNote] = useState('');
  const [duration, setDuration] = useState(reschedule ? String(Math.max(15, Math.round((new Date(reschedule.endAt).getTime() - new Date(reschedule.startAt).getTime()) / 60_000))) : '60');
  const [slots, setSlots] = useState<SlotDraft[]>(
    reschedule
      ? rescheduleSlots(reschedule)
      : [
          { start: `${defaultDay}T10:00`, end: `${defaultDay}T11:00` },
          { start: `${defaultDay}T14:00`, end: `${defaultDay}T15:00` },
        ],
  );
  const [text, setText] = useState('');
  const [textErr, setTextErr] = useState<string[]>([]);
  const mins = () => Math.max(15, Number(duration) || 60);
  const plus = plusMinutes;
  /** 「12/21（月）10～11：30　13～15」のような文字列を候補に変換して追加 */
  const readText = () => {
    const r = parseHoldText(text, { defaultMinutes: mins() });
    setTextErr(r.errors);
    if (r.slots.length) {
      const parsed = r.slots.map(parsedToSlot);
      // 既定の空行（未編集の初期値）は置き換え、入力済みなら追加
      const untouched = (reschedule ? true : slots.every((x) => x.start.endsWith('T10:00') || x.start.endsWith('T14:00'))) && slots.length <= 2;
      setSlots((untouched ? parsed : [...slots, ...parsed]).slice(0, 10));
      setText('');
    }
  };
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => api.get<{ id: number; name: string }[]>('/clients'), enabled: !fixed && !reschedule });
  const cases = useQuery({ queryKey: ['cases', 'open'], queryFn: () => api.get<{ id: number; title: string; clientId: number; clientName: string }[]>('/cases?status=open'), enabled: !fixed && !reschedule });
  const caseOptions = (cases.data ?? []).filter((c) => !clientId || c.clientId === Number(clientId));
  const clientName = fixed ? (fixed.clientName ?? '') : (clients.data?.find((c) => c.id === Number(clientId))?.name ?? '');
  const preview = `${clientName ? clientName.split(/[\s　]/)[0] : counterpartName || '（相手）'} ${title || '（内容）'} 仮`;

  // 仮押さえの入力途中も自動保存する
  const holdDraft = useDraftGroup(reschedule ? `reschedule:${reschedule.eventId}` : fixed ? `case:${fixed.caseId}:hold` : `calendar:hold:${defaultDay}`, {
    title: { value: title, set: setTitle, base: '打合せ' },
    counterpartName: { value: counterpartName, set: setCounterpartName },
    location: { value: location, set: setLocation, base: reschedule?.location ?? '' },
    note: { value: note, set: setNote },
    text: { value: text, set: setText },
  });

  const addSlot = () => {
    const last = slots[slots.length - 1];
    if (last?.allDay && last.start) {
      // 終日の次は、その翌日の終日
      const next = toLocalInput(new Date(new Date(`${last.start}T00:00:00+09:00`).getTime() + 86400_000).toISOString()).slice(0, 10);
      setSlots([...slots, { start: next, end: next, allDay: true }]);
      return;
    }
    const start = last?.start ? plus(last.start, 24 * 60) : `${defaultDay}T10:00`;
    setSlots([...slots, { start, end: plus(start, mins()) }]);
  };
  const save = useMutation({
    mutationFn: () => {
      const picked = slots.filter((v) => v.start).map((v) => slotRange(v, mins()));
      if (reschedule) {
        return api.post<{ sessionId: number; events: unknown[] }>(`/calendar/events/${reschedule.eventId}/reschedule`, { slots: picked, location: location || null, note: note || null, durationMinutes: mins() });
      }
      return api.post<{ sessionId: number; events: unknown[] }>('/calendar/holds', {
        title,
        kind,
        clientId: clientId ? Number(clientId) : null,
        caseId: caseId ? Number(caseId) : null,
        counterpartName: clientId ? null : counterpartName || null,
        location: location || null,
        slots: picked,
        // 枠（所要時間より長い時間帯）で押さえた候補は、確定するときにこの長さで時間を決める
        durationMinutes: mins(),
      });
    },
    onSuccess: (r) => {
      holdDraft.clear();
      onSaved(
        reschedule
          ? `日程変更の候補を ${r.events.length} 件仮押さえしました。相手が選んだ候補で「この候補で確定」を押すと、元の予定は自動で消えます`
          : `仮押さえを ${r.events.length} 件登録しました。相手の返事が来たら、その候補の「この候補で確定」を押してください`,
        r.sessionId,
      );
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
        <h2 className="font-semibold">{reschedule ? '日程変更（リスケ）' : '仮押さえ（複数候補）'}</h2>
        <button type="button" className="btn btn-sm ml-auto" onClick={onClose}>
          閉じる
        </button>
      </div>
      {reschedule ? (
        <p className="text-xs text-slate-500">
          いまの予定はそのまま残し、変更後の候補を仮押さえします。相手が選んだ候補で「この候補で確定」を押すと、その日時に置き換わり、元の予定とほかの候補は自動で削除されます。
        </p>
      ) : (
        <p className="text-xs text-slate-500">候補の日時をすべて「{'{姓} {内容} 仮'}」として登録します。相手が選んだ候補で「この候補で確定」を押すと、ほかの候補は自動で削除されます。</p>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {reschedule && (
          <div className="md:col-span-2 rounded bg-slate-50 p-2 text-sm">
            <div className="text-xs text-slate-500">変更する予定</div>
            <div className="font-medium">
              {fmtEventRange(reschedule.startAt, reschedule.endAt)} {reschedule.title}
            </div>
            {(reschedule.clientName || reschedule.caseTitle) && (
              <div className="text-xs text-slate-500">{[reschedule.clientName, reschedule.caseTitle].filter(Boolean).join('／')}</div>
            )}
          </div>
        )}
        {reschedule ? null : fixed ? (
          <div className="md:col-span-2 text-sm text-slate-600">
            <span className="label">この事件の仮押さえ</span>
            {fixed.clientName ? `${fixed.clientName}／` : ''}
            {fixed.caseTitle}
          </div>
        ) : (
          <>
            <div>
              <label className="label">依頼者</label>
              <ClientPicker
                value={clientId}
                onChange={(v) => {
                  setClientId(v);
                  setCaseId('');
                }}
                emptyLabel="（未登録の相手）"
                selectClassName="min-w-48 flex-1"
              />
            </div>
            {clientId ? (
              <div>
                <label className="label">事件</label>
                <select className="input" value={caseId} onChange={(e) => setCaseId(e.target.value)}>
                  <option value="">（なし）</option>
                  {caseOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div>
                <label className="label">相手の名前（姓）</label>
                <input className="input" value={counterpartName} onChange={(e) => setCounterpartName(e.target.value)} placeholder="例: 田中" />
              </div>
            )}
          </>
        )}
        {!reschedule && (
          <>
            <div>
              <label className="label">内容</label>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例: 打合せ / 新規相談 / WEB相談" required />
            </div>
            <div>
              <label className="label">確定したときの種別</label>
              <select className="input" value={kind} onChange={(e) => setKind(e.target.value as EventKind)}>
                {EVENT_KINDS.filter((k) => k !== 'hold').map((k) => (
                  <option key={k} value={k}>
                    {EVENT_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
        <div>
          <label className="label" title="候補をこれより長い時間帯（例: 13:00〜17:00）にすると「枠」として押さえ、確定するときにその中でこの長さの時間を決めます">
            所要時間（分）
          </label>
          <input type="number" className="input" min={15} step={15} value={duration} onChange={(e) => setDuration(e.target.value)} />
        </div>
        <div>
          <label className="label">場所</label>
          <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="例: 事務所 / Zoom" />
        </div>
        {reschedule && (
          <div className="md:col-span-2">
            <label className="label">変更の理由・メモ（任意。予定の説明欄に残ります）</label>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例: 期日が入ったため／依頼者の都合で" />
          </div>
        )}
        <div className="md:col-span-2">
          <label className="label">候補をまとめて入力（1 行に日付と時間帯。例: 12/21（月）10～11：30　13～15 ／ 12/22 終日）</label>
          <div className="flex flex-wrap items-start gap-2">
            <textarea className="input min-h-16 flex-1 text-sm" value={text} onChange={(e) => setText(e.target.value)} placeholder={'12/21（月）10～11：30　13～15\n12/22 14～16'} />
          <DraftHint handle={holdDraft} />
            <button type="button" className="btn" onClick={readText} disabled={!text.trim()}>
              読み取って候補に追加
            </button>
          </div>
          {textErr.length > 0 && <div className="mt-1 text-xs text-red-600">{textErr.join(' / ')}</div>}
          <div className="mt-1 text-xs text-slate-500">
            終了時刻を書かない場合は「所要時間」の長さで終了を補います。所要時間より長い時間帯（例: 13～17）は「枠」として押さえ、確定するときにその中で時間を決めます。読み取った候補は下で 1 件ずつ直せます。
          </div>
        </div>
        <div className="md:col-span-2">
          <label className="label">候補日時（開始 〜 終了）</label>
          <div className="space-y-2">
            {slots.map((v, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-6 shrink-0 text-xs text-slate-500">{i + 1}.</span>
                <SlotRow v={v} mins={mins()} label={`候補 ${i + 1}`} onChange={(nv) => setSlots(slots.map((x, j) => (j === i ? nv : x)))} onRemove={() => setSlots(slots.filter((_, j) => j !== i))} canRemove={slots.length > 1} />
              </div>
            ))}
            <button type="button" className="btn btn-sm" onClick={addSlot} disabled={slots.length >= 10}>
              ＋ 候補を追加
            </button>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={save.isPending}>
          {save.isPending ? '登録中…' : `${slots.filter((v) => v.start).length} 件を仮押さえ`}
        </button>
        <span className="text-xs text-slate-500">{reschedule ? `件名: ${reschedule.title} 仮（元の予定のまま）` : `件名: ${preview}`}</span>
      </div>
    </form>
  );
}

/**
 * 仮押さえた候補の場所を、あとからまとめて入れる・直す。
 * 候補すべての予定の場所が書き換わり、確定した予定にもそのまま残る
 */
export function HoldLocationEditor({ sessionId, location, web, compact, onSaved, onError }: { sessionId: number; location: string | null; web?: boolean; compact?: boolean; onSaved: (msg: string) => void; onError: (msg: string) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(location ?? '');
  const save = useMutation({
    mutationFn: () => api.post<{ location: string | null; updated: number }>(`/calendar/holds/${sessionId}/location`, { location: value.trim() || null }),
    onSuccess: (r) => {
      setOpen(false);
      // 候補日の打診文にも場所が入るので、開いていれば作り直す
      qc.invalidateQueries({ queryKey: ['hold-proposal', sessionId] });
      onSaved(r.location ? `候補 ${r.updated} 件の場所を「${r.location}」にしました` : `候補 ${r.updated} 件の場所を外しました`);
    },
    onError: (e) => onError((e as Error).message),
  });
  if (!open) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1 text-xs text-slate-600">
        {!compact && <span className="text-slate-500">場所:</span>}
        {!compact && <span className={location ? '' : 'text-slate-400'}>{location || '未定'}</span>}
        <button
          type="button"
          className={compact ? 'btn btn-sm' : 'text-blue-700 hover:underline'}
          onClick={() => {
            setValue(location ?? '');
            setOpen(true);
          }}
          title="候補すべての場所をまとめて変えます"
        >
          {location ? '場所を変更' : '場所を入れる'}
        </button>
      </span>
    );
  }
  return (
    <form
      className="flex w-full flex-wrap items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <label className="text-xs text-slate-500" htmlFor={`hold-location-${sessionId}`}>
        場所
      </label>
      <input id={`hold-location-${sessionId}`} className="input min-w-0 flex-1 py-0.5 text-sm" value={value} onChange={(e) => setValue(e.target.value)} placeholder={web ? '空欄なら会議の種類（Zoom など）' : '例: 事務所 / 奈良地裁 / 依頼者の会社'} maxLength={200} autoFocus />
      <button type="submit" className="btn btn-sm btn-primary" disabled={save.isPending}>
        {save.isPending ? '保存中…' : '保存'}
      </button>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>
        やめる
      </button>
    </form>
  );
}

/**
 * 調整中の仮押さえに候補を足す。件名・依頼者・事件・場所は、いまある候補と同じになる。
 * after は既定の候補を置く基準（いまある候補の最後の日時）。minutes は既定の所要時間
 */
export function HoldAddCandidates({ sessionId, after, minutes, onClose, onSaved, onError }: { sessionId: number; after: string; minutes: number; onClose: () => void; onSaved: (msg: string) => void; onError: (msg: string) => void }) {
  const dur = Math.max(15, minutes || 60);
  const plus = (local: string, m: number) => toLocalInput(new Date(new Date(fromLocalInput(local)).getTime() + m * 60_000).toISOString());
  const first = toLocalInput(new Date(new Date(after).getTime() + 86400_000).toISOString());
  const [slots, setSlots] = useState<SlotDraft[]>([{ start: first, end: plus(first, dur) }]);
  const [text, setText] = useState('');
  const [textErr, setTextErr] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const readText = () => {
    const r = parseHoldText(text, { defaultMinutes: dur });
    setTextErr(r.errors);
    if (r.slots.length) {
      const parsed = r.slots.map(parsedToSlot);
      // 手を付けていない既定の 1 行は置き換える
      setSlots((touched ? [...slots, ...parsed] : parsed).slice(0, 10));
      setTouched(true);
      setText('');
    }
  };
  const save = useMutation({
    mutationFn: () =>
      api.post<{ events: unknown[]; skipped: number; total: number }>(`/calendar/holds/${sessionId}/candidates`, {
        slots: slots.filter((v) => v.start).map((v) => slotRange(v, dur)),
      }),
    onSuccess: (r) => onSaved(`候補を ${r.events.length} 件追加しました（候補は全部で ${r.total} 件）${r.skipped ? `。${r.skipped} 件はすでに候補にある日時なので追加していません` : ''}`),
    onError: (e) => onError((e as Error).message),
  });
  return (
    <form
      className="fade-in mt-1 w-full space-y-2 rounded-md border border-blue-200 bg-blue-50/40 p-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="text-xs text-slate-600">追加した候補も同じ件名で仮押さえします。依頼者・事件・場所はいまの候補と同じです。</div>
      <div className="flex flex-wrap items-start gap-2">
        <textarea className="input min-h-12 flex-1 text-sm" value={text} onChange={(e) => setText(e.target.value)} placeholder={'まとめて入力（例: 12/21（月）10～11：30　13～15）'} aria-label="追加する候補をまとめて入力" />
        <button type="button" className="btn btn-sm" onClick={readText} disabled={!text.trim()}>
          読み取る
        </button>
      </div>
      {textErr.length > 0 && <div className="text-xs text-red-600">{textErr.join(' / ')}</div>}
      <div className="space-y-1.5">
        {slots.map((v, i) => (
          <SlotRow
            key={i}
            v={v}
            mins={dur}
            label="追加する候補"
            onChange={(nv) => {
              setTouched(true);
              setSlots(slots.map((x, j) => (j === i ? nv : x)));
            }}
            onRemove={() => setSlots(slots.filter((_, j) => j !== i))}
            canRemove={slots.length > 1}
          />
        ))}
        <button
          type="button"
          className="btn btn-sm"
          disabled={slots.length >= 10}
          onClick={() => {
            const last = slots[slots.length - 1];
            const start = last?.start && !last.allDay ? plus(last.start, 24 * 60) : first;
            setTouched(true);
            setSlots([...slots, { start, end: plus(start, dur) }]);
          }}
        >
          ＋ 行を足す
        </button>
      </div>
      <div className="flex gap-2">
        <button className="btn btn-sm btn-primary" disabled={save.isPending || !slots.some((v) => v.start)}>
          {save.isPending ? '仮押さえ中…' : `${slots.filter((v) => v.start).length} 件を候補に追加`}
        </button>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          やめる
        </button>
      </div>
    </form>
  );
}

/** 枠で押さえた候補か（所要時間より長い時間帯。終日は除く） */
export function isHoldWindow(c: { startAt: string; endAt: string }, durationMinutes: number | null | undefined): boolean {
  if (!durationMinutes || isAllDayRange(c.startAt, c.endAt)) return false;
  return (new Date(c.endAt).getTime() - new Date(c.startAt).getTime()) / 60_000 > durationMinutes;
}

/**
 * 枠（例: 13:00〜17:00 の中で 60 分）で押さえた候補を確定するとき、その中の時間を決める。
 * 開始は 15 分刻みで選び、長さは所要時間が既定（変えられる）。決めた時間で確定すると、ほかの時間は空く
 */
export function WindowConfirm({
  candidate,
  durationMinutes,
  pending,
  note,
  onConfirm,
  onCancel,
}: {
  candidate: { startAt: string; endAt: string };
  durationMinutes: number;
  pending: boolean;
  /** 確定の確認文に添える一言（「ほかの候補は削除されます」など） */
  note?: string;
  onConfirm: (time: { startAt: string; endAt: string }) => void;
  onCancel?: () => void;
}) {
  const ws = new Date(candidate.startAt).getTime();
  const we = new Date(candidate.endAt).getTime();
  const [minutes, setMinutes] = useState(String(durationMinutes));
  const len = Math.max(5, Number(minutes) || durationMinutes);
  const starts: number[] = [];
  for (let t = ws; t + len * 60_000 <= we; t += 15 * 60_000) starts.push(t);
  const [start, setStart] = useState(ws);
  const startAt = starts.includes(start) ? start : (starts[0] ?? ws);
  const hm = (t: number) => new Date(t).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
  const fits = starts.length > 0;
  const time = { startAt: new Date(startAt).toISOString(), endAt: new Date(startAt + len * 60_000).toISOString() };
  return (
    <div className="fade-in flex w-full flex-wrap items-center gap-2 rounded-md bg-blue-50/60 px-2 py-1.5 text-sm">
      <span className="text-xs text-slate-600">
        {hm(ws)}〜{hm(we)} の枠の中で、確定する時間:
      </span>
      <select className="input w-auto py-0.5" value={startAt} onChange={(e) => setStart(Number(e.target.value))} aria-label="確定する開始時刻" disabled={!fits}>
        {starts.map((t) => (
          <option key={t} value={t}>
            {hm(t)}〜{hm(t + len * 60_000)}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1 text-xs text-slate-600">
        長さ
        <input type="number" className="input w-20 py-0.5" min={5} step={15} value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-label="確定する長さ（分）" />分
      </label>
      <button
        type="button"
        className="btn btn-sm btn-primary"
        disabled={pending || !fits}
        onClick={() => {
          if (window.confirm(`${fmtEventRange(time.startAt, time.endAt)} で確定しますか？${note ? `\n${note}` : ''}`)) onConfirm(time);
        }}
      >
        {pending ? '確定中…' : 'この時間で確定'}
      </button>
      {onCancel && (
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          やめる
        </button>
      )}
      {!fits && <span className="text-xs text-red-600">長さが枠より長くなっています</span>}
    </div>
  );
}
