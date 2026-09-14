import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { EVENT_KINDS, EVENT_KIND_LABEL, parseHoldText, type EventKind } from '@lcm/shared';
import { api } from './api';
import { useDraftGroup, DraftHint } from './draft';
import { ClientPicker } from './ClientPicker';
import { toLocalInput, fromLocalInput } from './format';

/** 事件ページなどから開くときに、依頼者と事件を決め打ちする */
export interface HoldFormFixed {
  clientId: number | null;
  clientName: string | null;
  caseId: number;
  caseTitle: string;
}

/**
 * 複数候補の仮押さえ。予定ページと事件ページの両方から使う。
 * fixed を渡すと依頼者・事件は選ばず、その事件の仮押さえとして登録する。
 */
export function HoldForm({ defaultDay, fixed = null, onClose, onSaved, onError }: { defaultDay: string; fixed?: HoldFormFixed | null; onClose: () => void; onSaved: (msg: string) => void; onError: (msg: string) => void }) {
  const [title, setTitle] = useState('打合せ');
  const [kind, setKind] = useState<EventKind>('meeting');
  const [clientId, setClientId] = useState(fixed?.clientId ? String(fixed.clientId) : '');
  const [caseId, setCaseId] = useState(fixed ? String(fixed.caseId) : '');
  const [counterpartName, setCounterpartName] = useState('');
  const [location, setLocation] = useState('');
  const [duration, setDuration] = useState('60');
  const [slots, setSlots] = useState<{ start: string; end: string }[]>([
    { start: `${defaultDay}T10:00`, end: `${defaultDay}T11:00` },
    { start: `${defaultDay}T14:00`, end: `${defaultDay}T15:00` },
  ]);
  const [text, setText] = useState('');
  const [textErr, setTextErr] = useState<string[]>([]);
  const mins = () => Math.max(15, Number(duration) || 60);
  const plus = (local: string, m: number) => toLocalInput(new Date(new Date(fromLocalInput(local)).getTime() + m * 60_000).toISOString());
  /** 「12/21（月）10～11：30　13～15」のような文字列を候補に変換して追加 */
  const readText = () => {
    const r = parseHoldText(text, { defaultMinutes: mins() });
    setTextErr(r.errors);
    if (r.slots.length) {
      const parsed = r.slots.map((x) => ({ start: toLocalInput(x.startAt), end: toLocalInput(x.endAt) }));
      // 既定の空行（未編集の初期値）は置き換え、入力済みなら追加
      const untouched = slots.every((x) => x.start.endsWith('T10:00') || x.start.endsWith('T14:00')) && slots.length <= 2;
      setSlots((untouched ? parsed : [...slots, ...parsed]).slice(0, 10));
      setText('');
    }
  };
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => api.get<{ id: number; name: string }[]>('/clients'), enabled: !fixed });
  const cases = useQuery({ queryKey: ['cases', 'open'], queryFn: () => api.get<{ id: number; title: string; clientId: number; clientName: string }[]>('/cases?status=open'), enabled: !fixed });
  const caseOptions = (cases.data ?? []).filter((c) => !clientId || c.clientId === Number(clientId));
  const clientName = fixed ? (fixed.clientName ?? '') : (clients.data?.find((c) => c.id === Number(clientId))?.name ?? '');
  const preview = `${clientName ? clientName.split(/[\s　]/)[0] : counterpartName || '（相手）'} ${title || '（内容）'} 仮`;

  // 仮押さえの入力途中も自動保存する
  const holdDraft = useDraftGroup(fixed ? `case:${fixed.caseId}:hold` : `calendar:hold:${defaultDay}`, {
    title: { value: title, set: setTitle, base: '打合せ' },
    counterpartName: { value: counterpartName, set: setCounterpartName },
    location: { value: location, set: setLocation },
    text: { value: text, set: setText },
  });

  const addSlot = () => {
    const last = slots[slots.length - 1];
    const start = last ? plus(last.start, 24 * 60) : `${defaultDay}T10:00`;
    setSlots([...slots, { start, end: plus(start, mins()) }]);
  };
  const save = useMutation({
    mutationFn: () => {
      const body = {
        title,
        kind,
        clientId: clientId ? Number(clientId) : null,
        caseId: caseId ? Number(caseId) : null,
        counterpartName: clientId ? null : counterpartName || null,
        location: location || null,
        slots: slots
          .filter((v) => v.start)
          .map((v) => {
            const start = new Date(fromLocalInput(v.start));
            const end = v.end ? new Date(fromLocalInput(v.end)) : new Date(start.getTime() + mins() * 60_000);
            return { startAt: start.toISOString(), endAt: (end > start ? end : new Date(start.getTime() + mins() * 60_000)).toISOString() };
          }),
      };
      return api.post<{ sessionId: number; events: unknown[] }>('/calendar/holds', body);
    },
    onSuccess: (r) => {
      holdDraft.clear();
      onSaved(`仮押さえを ${r.events.length} 件登録しました。相手の返事が来たら、その候補の「この候補で確定」を押してください`);
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
        <h2 className="font-semibold">仮押さえ（複数候補）</h2>
        <button type="button" className="btn btn-sm ml-auto" onClick={onClose}>
          閉じる
        </button>
      </div>
      <p className="text-xs text-slate-500">候補の日時をすべて「{'{姓} {内容} 仮'}」として登録します。相手が選んだ候補で「この候補で確定」を押すと、ほかの候補は自動で削除されます。</p>
      <div className="grid gap-3 md:grid-cols-2">
        {fixed ? (
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
        <div>
          <label className="label">所要時間（分）</label>
          <input type="number" className="input" min={15} step={15} value={duration} onChange={(e) => setDuration(e.target.value)} />
        </div>
        <div>
          <label className="label">場所</label>
          <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="例: 事務所 / Zoom" />
        </div>
        <div className="md:col-span-2">
          <label className="label">候補をまとめて入力（1 行に日付と時間帯。例: 12/21（月）10～11：30　13～15）</label>
          <div className="flex flex-wrap items-start gap-2">
            <textarea className="input min-h-16 flex-1 text-sm" value={text} onChange={(e) => setText(e.target.value)} placeholder={'12/21（月）10～11：30　13～15\n12/22 14～16'} />
          <DraftHint handle={holdDraft} />
            <button type="button" className="btn" onClick={readText} disabled={!text.trim()}>
              読み取って候補に追加
            </button>
          </div>
          {textErr.length > 0 && <div className="mt-1 text-xs text-red-600">{textErr.join(' / ')}</div>}
          <div className="mt-1 text-xs text-slate-500">終了時刻を書かない場合は「所要時間」の長さで終了を補います。読み取った候補は下で 1 件ずつ直せます。</div>
        </div>
        <div className="md:col-span-2">
          <label className="label">候補日時（開始 〜 終了）</label>
          <div className="space-y-2">
            {slots.map((v, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span className="w-6 text-xs text-slate-500">{i + 1}.</span>
                <input
                  type="datetime-local"
                  className="input w-auto"
                  value={v.start}
                  onChange={(e) => {
                    const start = e.target.value;
                    const prevDur = Math.max(15, (new Date(fromLocalInput(v.end)).getTime() - new Date(fromLocalInput(v.start)).getTime()) / 60_000 || mins());
                    setSlots(slots.map((x, j) => (j === i ? { start, end: start ? plus(start, prevDur) : x.end } : x)));
                  }}
                  required
                />
                <span className="text-slate-400">〜</span>
                <input type="datetime-local" className="input w-auto" value={v.end} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
                <button type="button" className="btn btn-sm" onClick={() => setSlots(slots.filter((_, j) => j !== i))} disabled={slots.length <= 1} aria-label="この候補を外す">
                  ×
                </button>
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
        <span className="text-xs text-slate-500">件名: {preview}</span>
      </div>
    </form>
  );
}
