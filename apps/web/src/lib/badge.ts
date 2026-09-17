/**
 * ホーム画面・タスクバーのアイコンに、対応が要る件数を出す（Badging API）。
 *
 * 使える条件:
 * - iPhone / iPad … iOS 16.4 以降で、Safari の「ホーム画面に追加」で入れたアプリのみ。
 *   さらに通知が許可されていないと数字は出ない（呼び出しはできるが表示されない）
 * - パソコン … Chrome / Edge でインストールしたアプリ（PWA）で出る
 * - アプリを完全に閉じている間は数が更新されない（最後の数のまま残る）
 */

/** アイコンに出す数の決め方 */
export type BadgeSource = 'inbox' | 'inbox_alerts' | 'off';
export const BADGE_SOURCES: BadgeSource[] = ['inbox', 'inbox_alerts', 'off'];
export const BADGE_SOURCE_LABEL: Record<BadgeSource, string> = {
  inbox: '受信箱の未返信だけ',
  inbox_alerts: '受信箱の未返信＋要確認',
  off: '表示しない',
};

export function badgeSource(v: string | undefined | null): BadgeSource {
  return v === 'inbox_alerts' || v === 'off' ? v : 'inbox';
}

/** この端末・このブラウザでアイコンに数を出せるか */
export function badgeSupported(): boolean {
  return typeof navigator !== 'undefined' && 'setAppBadge' in navigator;
}

/** iPhone では通知が許可されていないと数字が出ないので、その状態を見る */
export function notificationPermission(): 'granted' | 'denied' | 'default' | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/** 通知の許可を求める（iPhone でアイコンに数を出すのに必要）。ボタンから呼ぶ */
export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** 件数から、アイコンに出す数を決める */
export function badgeCount(counts: { inbox: number; alerts: number }, source: BadgeSource): number {
  if (source === 'off') return 0;
  return source === 'inbox_alerts' ? counts.inbox + counts.alerts : counts.inbox;
}

/**
 * アイコンの数を更新する。0 なら消す。
 * 使えない端末や、許可されていない場合も、画面が止まらないよう黙って何もしない。
 */
export function applyAppBadge(n: number): void {
  if (!badgeSupported()) return;
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  try {
    const p = n > 0 ? nav.setAppBadge?.(n) : nav.clearAppBadge?.();
    void p?.catch(() => undefined);
  } catch {
    // 未対応・未許可のときは何もしない
  }
}
