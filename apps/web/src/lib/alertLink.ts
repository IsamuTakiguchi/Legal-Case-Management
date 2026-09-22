/**
 * 要確認のお知らせから、その中身の画面への行き先。
 *
 * 要確認の一覧（/alerts）でもダッシュボードでも同じところへ飛ぶように、ここにまとめる。
 */

/**
 * 「日程調整が停滞」→ その日程調整。
 *
 * 会話から始めたものは会話画面の「日程調整」、事件から始めたものは事件ページの
 * 「日程調整（仮押さえ中）」を、その 1 件を目立たせて開く。
 * どちらも分からないもの（行き先を入れる前の古いお知らせなど）は、仮押さえが並ぶ予定ページへ。
 */
export function schedulingLink(payload: Record<string, unknown>): { to: string; label: string } {
  const sessionId = Number(payload.sessionId) || 0;
  const q = sessionId ? `?session=${sessionId}` : '';
  if (payload.conversationId) return { to: `/inbox/${Number(payload.conversationId)}${q}`, label: '日程調整を開く' };
  if (payload.caseId) return { to: `/cases/${Number(payload.caseId)}${q}`, label: '日程調整を開く' };
  return { to: '/calendar', label: '予定を見る' };
}

/** お知らせ 1 件をタップしたときの行き先。決められないものは要確認の一覧へ */
export function alertLink(a: { type: string; payload?: Record<string, unknown> | null }): string {
  const payload = a.payload ?? {};
  if (a.type === 'scheduling_stale') return schedulingLink(payload).to;
  if ((a.type === 'waiting_overdue' || a.type === 'reply_received') && payload.conversationId) return `/inbox/${Number(payload.conversationId)}`;
  if (a.type === 'creditor_overdue' && payload.caseId) return `/cases/${Number(payload.caseId)}`;
  return '/alerts';
}
