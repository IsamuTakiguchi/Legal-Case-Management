import { useState } from 'react';
import { fmtDate, fromLocalInput, toLocalInput } from './format';

/** 「N 日後の 10:00（JST）」を ISO で返す */
function daysLater(days: number, hour = 10): string {
  const jst = new Date(Date.now() + 9 * 3600_000);
  const d = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() + days, hour - 9, 0, 0));
  return d.toISOString();
}

export const DEADLINE_QUICK: { label: string; days: number }[] = [
  { label: '3日後', days: 3 },
  { label: '1週間後', days: 7 },
  { label: '2週間後', days: 14 },
  { label: '1か月後', days: 30 },
];

/**
 * 連絡待ちの期限（いつまで待つか）を個別に変える部品。
 * 現在の期限を表示し、押すと候補ボタンと日時入力が開く。compact は一覧向けの小さめ表示
 */
export function DeadlineEditor({ value, onChange, compact = false, label = '期限' }: { value: string | null; onChange: (iso: string) => void; compact?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  const over = value ? new Date(value).getTime() < Date.now() : false;
  return (
    <div className={compact ? 'text-xs' : 'text-sm'}>
      <button type="button" className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-black/[0.05] ${over ? 'font-semibold text-orange-600' : 'text-slate-600'}`} onClick={() => setOpen(!open)} title="押すと期限を変えられます" aria-expanded={open}>
        {label} {value ? fmtDate(value) : '未設定'}
        <span className="text-[10px] text-slate-400">▾</span>
      </button>
      {open && (
        <div className="fade-in mt-1 flex flex-wrap items-center gap-1">
          {DEADLINE_QUICK.map((q) => (
            <button
              key={q.days}
              type="button"
              className="btn btn-sm"
              onClick={() => {
                onChange(daysLater(q.days));
                setOpen(false);
              }}
            >
              {q.label}
            </button>
          ))}
          <input
            type="datetime-local"
            className="input w-auto py-0.5 text-xs"
            value={toLocalInput(value)}
            onChange={(e) => {
              if (e.target.value) onChange(fromLocalInput(e.target.value));
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * タスクを作るときの期限の選択。
 * 返信待ちなら「いつまで待つか」（既定は設定の営業日数）、対応中なら「期日」（既定はなし）に使う。
 * 値から選択中の項目を決めるので、作ったあとに親が null に戻せば表示も戻る。
 */
export function TaskDeadlineSelect({
  value,
  onChange,
  label = '期限',
  defaultLabel = '既定（設定の営業日数）',
}: {
  value: string | null;
  onChange: (iso: string | null) => void;
  /** 選択肢の頭に出す言葉（期限 / 期日） */
  label?: string;
  /** 何も選んでいないときの言い方 */
  defaultLabel?: string;
}) {
  const quick = value ? DEADLINE_QUICK.find((q) => value === daysLater(q.days)) : null;
  const selected = value === null ? 'default' : quick ? String(quick.days) : 'custom';
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-sm">
      <select
        className="input w-auto py-0.5 text-xs"
        value={selected}
        onChange={(e) => {
          const v = e.target.value;
          // 「日時を指定」は、空欄ではなく明日 10:00 を入れてから直してもらう
          onChange(v === 'default' ? null : daysLater(v === 'custom' ? 1 : Number(v)));
        }}
        aria-label={label}
      >
        <option value="default">
          {label}: {defaultLabel}
        </option>
        {DEADLINE_QUICK.map((q) => (
          <option key={q.days} value={q.days}>
            {label}: {q.label}
          </option>
        ))}
        <option value="custom">{label}: 日時を指定</option>
      </select>
      {selected === 'custom' && (
        <input type="datetime-local" className="input w-auto py-0.5 text-xs" value={toLocalInput(value)} onChange={(e) => onChange(e.target.value ? fromLocalInput(e.target.value) : null)} />
      )}
    </span>
  );
}

/** 返信待ちタスクを作るときの「いつまで待つか」の選択（既定は設定の営業日数） */
export function WaitDeadlineSelect({ value, onChange }: { value: string | null; onChange: (iso: string | null) => void }) {
  return <TaskDeadlineSelect value={value} onChange={onChange} />;
}
