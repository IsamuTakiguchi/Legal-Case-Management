import { useState } from 'react';
import { dateOnlyDeadline, isDateOnlyDeadline, jstYmd, isWaitingStatus } from '@lcm/shared';
import { fmtDate, fromLocalInput, toLocalInput } from './format';

/**
 * タスクの期限は 2 種類ある。
 * - 締切（dueAt）: そのタスク自体の締切。例: 答弁書の提出期限 10/15
 * - 返信期限（followUpAt）: 依頼者・相手方などの返事を待つ期限。過ぎたら催促のお知らせを出す。例: 答弁書案への依頼者の返事 10/10
 * 返信待ちのタスクは両方を持てる。どちらも、既定は日付だけ（時刻は決めない）
 */
export const DUE_LABEL = '締切';
export const FOLLOW_LABEL = '返信期限';
export const DUE_HINT = 'このタスクそのものの締切です（例: 答弁書の提出期限）。返信待ちにしても消えません';
export const FOLLOW_HINT = '依頼者・相手方などの返事を待つ期限です。過ぎるとダッシュボードと要確認でお知らせします（例: 答弁書案への依頼者の返事）';

/** N 日後（日付だけ。その日の終わりまで） */
function daysLater(days: number): string {
  return dateOnlyDeadline(jstYmd(new Date(Date.now() + days * 86400_000)));
}

/** 期限の表示。日付だけなら日付、時刻も決めていれば時刻も */
export function fmtDeadline(iso: string | null | undefined): string {
  if (!iso) return '';
  if (isDateOnlyDeadline(iso)) return fmtDate(iso);
  const t = new Date(iso).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
  return `${fmtDate(iso)} ${t}`;
}

export const DEADLINE_QUICK: { label: string; days: number }[] = [
  { label: '3日後', days: 3 },
  { label: '1週間後', days: 7 },
  { label: '2週間後', days: 14 },
  { label: '1か月後', days: 30 },
];

/**
 * 日付の入力。既定は日付だけで、「時刻も指定」を付けたときだけ時刻を入れる
 */
export function DeadlineInput({ value, onChange, className = '' }: { value: string | null; onChange: (iso: string | null) => void; className?: string }) {
  const [withTime, setWithTime] = useState(!!value && !isDateOnlyDeadline(value));
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${className}`}>
      {withTime ? (
        <input type="datetime-local" className="input w-auto py-0.5 text-xs" value={toLocalInput(value)} onChange={(e) => onChange(e.target.value ? fromLocalInput(e.target.value) : null)} aria-label="日時" />
      ) : (
        <input type="date" className="input w-auto py-0.5 text-xs" value={value ? toLocalInput(value).slice(0, 10) : ''} onChange={(e) => onChange(e.target.value ? dateOnlyDeadline(e.target.value) : null)} aria-label="日付" />
      )}
      <label className="flex items-center gap-1 text-xs text-slate-500" title="時刻まで決める場合だけ付けます">
        <input
          type="checkbox"
          checked={withTime}
          onChange={(e) => {
            const on = e.target.checked;
            setWithTime(on);
            if (!value) return;
            const ymd = toLocalInput(value).slice(0, 10);
            // 時刻を付けるときは 10:00 から、外すときはその日の終わりまでに戻す
            onChange(on ? fromLocalInput(`${ymd}T10:00`) : dateOnlyDeadline(ymd));
          }}
        />
        時刻も指定
      </label>
    </span>
  );
}

/**
 * 期限を表示し、押すと候補ボタンと日付入力が開く部品。compact は一覧向けの小さめ表示。
 * onClear を渡すと「外す」ボタンが出る（締切は外せる。返信期限は外さない）
 */
export function DeadlineEditor({
  value,
  onChange,
  onClear,
  compact = false,
  label = FOLLOW_LABEL,
  hint,
}: {
  value: string | null;
  onChange: (iso: string) => void;
  onClear?: () => void;
  compact?: boolean;
  label?: string;
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const over = value ? new Date(value).getTime() < Date.now() : false;
  return (
    <div className={compact ? 'text-xs' : 'text-sm'}>
      <button
        type="button"
        className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-black/[0.05] ${over ? 'font-semibold text-orange-600' : value ? 'text-slate-600' : 'text-slate-400'}`}
        onClick={() => setOpen(!open)}
        title={`${hint ? `${hint}。` : ''}押すと変えられます`}
        aria-expanded={open}
      >
        {label.replace(/:$/, '')} {value ? fmtDeadline(value) : '未設定'}
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
          <DeadlineInput value={value} onChange={(iso) => iso && onChange(iso)} />
          {onClear && value && (
            <button
              type="button"
              className="btn btn-sm text-slate-500"
              onClick={() => {
                onClear();
                setOpen(false);
              }}
            >
              外す
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * タスク 1 件の締切・返信期限。
 * 対応中は「締切」、返信待ちは「返信期限」と「締切」の両方（締切は返信待ちにしても残る）
 */
export function TaskDeadlines({
  task,
  onChange,
  compact = true,
}: {
  task: { status: string; dueAt: string | null; followUpAt: string | null };
  onChange: (patch: { dueAt?: string | null; followUpAt?: string | null }) => void;
  compact?: boolean;
}) {
  if (task.status === 'done') return task.dueAt ? <div className="text-xs text-slate-500">{DUE_LABEL} {fmtDeadline(task.dueAt)}</div> : null;
  return (
    <>
      {isWaitingStatus(task.status) && <DeadlineEditor compact={compact} label={FOLLOW_LABEL} hint={FOLLOW_HINT} value={task.followUpAt} onChange={(iso) => onChange({ followUpAt: iso })} />}
      <DeadlineEditor compact={compact} label={DUE_LABEL} hint={DUE_HINT} value={task.dueAt} onChange={(iso) => onChange({ dueAt: iso })} onClear={() => onChange({ dueAt: null })} />
    </>
  );
}

/**
 * タスクを作るときの期限の選択（締切・返信期限のどちらにも使う）。
 * 値から選択中の項目を決めるので、作ったあとに親が null に戻せば表示も戻る。
 */
export function TaskDeadlineSelect({
  value,
  onChange,
  label = FOLLOW_LABEL,
  defaultLabel = '既定（設定の営業日数）',
}: {
  value: string | null;
  onChange: (iso: string | null) => void;
  /** 選択肢の頭に出す言葉（締切 / 返信期限） */
  label?: string;
  /** 何も選んでいないときの言い方 */
  defaultLabel?: string;
}) {
  const quick = value ? DEADLINE_QUICK.find((q) => value === daysLater(q.days)) : null;
  const selected = value === null ? 'default' : quick ? String(quick.days) : 'custom';
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-sm" title={label === DUE_LABEL ? DUE_HINT : FOLLOW_HINT}>
      <select
        className="input w-auto py-0.5 text-xs"
        value={selected}
        onChange={(e) => {
          const v = e.target.value;
          // 「日付を指定」は、空欄ではなく明日を入れてから直してもらう
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
        <option value="custom">{label}: 日付を指定</option>
      </select>
      {selected === 'custom' && <DeadlineInput value={value} onChange={onChange} />}
    </span>
  );
}

/** 返信待ちタスクを作るときの「返信期限」の選択（既定は設定の営業日数） */
export function WaitDeadlineSelect({ value, onChange }: { value: string | null; onChange: (iso: string | null) => void }) {
  return <TaskDeadlineSelect value={value} onChange={onChange} />;
}

/**
 * 新しいタスクの期限欄。対応中なら「締切」だけ、返信待ちなら「返信期限」と「締切」の両方
 */
export function NewTaskDeadlines({
  waiting,
  followUp,
  onFollowUp,
  due,
  onDue,
}: {
  waiting: boolean;
  followUp: string | null;
  onFollowUp: (iso: string | null) => void;
  due: string | null;
  onDue: (iso: string | null) => void;
}) {
  return (
    <>
      {waiting && <TaskDeadlineSelect value={followUp} onChange={onFollowUp} label={FOLLOW_LABEL} defaultLabel="既定（設定の営業日数）" />}
      <TaskDeadlineSelect value={due} onChange={onDue} label={DUE_LABEL} defaultLabel="なし" />
    </>
  );
}
