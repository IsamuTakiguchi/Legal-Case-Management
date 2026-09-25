/**
 * タスクの件数（ダッシュボードで「対応中」と「連絡待ち」を分けて見せる）と、期限の考え方。
 * タスク一覧の「期限切れ」とダッシュボードの数字がずれないよう、ここにまとめる。
 */

export interface TaskLike {
  status: string;
  dueAt?: string | null;
  followUpAt?: string | null;
}

/** 相手の返事を待っている状態（依頼者の返信待ち・相手方・裁判所待ち） */
export function isWaitingStatus(status: string): boolean {
  return status === 'waiting_client' || status === 'waiting_other';
}

/** 期限。連絡待ちは「いつまで待つか」、対応中は期日を優先する */
export function taskDeadline(t: TaskLike): string | null {
  return (isWaitingStatus(t.status) ? (t.followUpAt ?? t.dueAt) : (t.dueAt ?? t.followUpAt)) ?? null;
}

export interface TaskCounts {
  /** 対応中（自分がやること） */
  open: number;
  /** 連絡待ち（依頼者＋相手方・裁判所） */
  waiting: number;
  waitingClient: number;
  waitingOther: number;
  /** うち期限を過ぎたもの */
  openOverdue: number;
  waitingOverdue: number;
}

export function countTasks(tasks: TaskLike[], now = Date.now()): TaskCounts {
  const c: TaskCounts = { open: 0, waiting: 0, waitingClient: 0, waitingOther: 0, openOverdue: 0, waitingOverdue: 0 };
  for (const t of tasks) {
    const d = taskDeadline(t);
    const overdue = !!d && new Date(d).getTime() < now;
    if (t.status === 'open') {
      c.open++;
      if (overdue) c.openOverdue++;
    } else if (isWaitingStatus(t.status)) {
      c.waiting++;
      if (t.status === 'waiting_client') c.waitingClient++;
      else c.waitingOther++;
      if (overdue) c.waitingOverdue++;
    }
  }
  return c;
}
