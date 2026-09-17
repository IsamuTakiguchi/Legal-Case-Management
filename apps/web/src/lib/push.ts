/**
 * 受信があったらすぐ端末に知らせる（Web Push）。
 *
 * 使える条件:
 * - iPhone / iPad … iOS 16.4 以降で、Safari の「ホーム画面に追加」で入れたアプリのみ
 * - パソコン … Chrome / Edge / Safari（Safari は通知の許可が要る）
 * - 端末ごとに許可が要る。許可した端末にだけ届く
 */
import { api } from './api';

export type PushState = 'unsupported' | 'denied' | 'off' | 'on';

/** この端末で通知を受け取れるか */
export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
}

/** iPhone は「ホーム画面に追加」で入れたときだけ通知を受け取れる */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true;
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.ready);
  } catch {
    return null;
  }
}

/** いまの状態。on = この端末は通知を受け取る設定になっている */
export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await registration();
  if (!reg) return 'off';
  const sub = await reg.pushManager.getSubscription().catch(() => null);
  return sub ? 'on' : 'off';
}

/** サーバの公開鍵（base64url）を、購読に渡せる形に直す */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** この端末を通知の宛先として登録する。許可を求めるのでボタンから呼ぶ */
export async function enablePush(label?: string): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  const reg = await registration();
  if (!reg) return 'off';
  const { publicKey } = await api.get<{ publicKey: string }>('/push/key');
  let sub = await reg.pushManager.getSubscription().catch(() => null);
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
  }
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return 'off';
  await api.post('/push/subscribe', {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    label: label || deviceLabel(),
  });
  return 'on';
}

/** この端末への通知をやめる */
export async function disablePush(): Promise<PushState> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => undefined);
    await api.post('/push/unsubscribe', { endpoint }).catch(() => undefined);
  }
  return 'off';
}

/** 端末の見分けがつくよう、ざっくりした呼び名を付ける */
export function deviceLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'この端末';
}
