import { env, isConfigured } from '../config.js';

let tokenCache: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (!isConfigured('zoom')) throw new Error('Zoom の Server-to-Server OAuth 設定がありません');
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const e = env();
  const basic = Buffer.from(`${e.ZOOM_CLIENT_ID}:${e.ZOOM_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(e.ZOOM_ACCOUNT_ID!)}`,
    { method: 'POST', headers: { Authorization: `Basic ${basic}` } },
  );
  if (!res.ok) throw new Error(`Zoom トークン取得失敗: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: json.access_token, expiresAt: Date.now() + Math.min(json.expires_in, 3300) * 1000 };
  return tokenCache.token;
}

export interface ZoomMeeting {
  id: string;
  joinUrl: string;
  password: string;
  startUrl?: string;
  topic: string;
}

export async function createZoomMeeting(opts: { topic: string; startAt: Date; durationMinutes: number; agenda?: string }): Promise<ZoomMeeting> {
  const token = await accessToken();
  const res = await fetch('https://api.zoom.us/v2/users/me/meetings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: opts.topic,
      type: 2,
      start_time: opts.startAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      duration: opts.durationMinutes,
      timezone: 'Asia/Tokyo',
      agenda: opts.agenda ?? '',
      settings: { waiting_room: true, join_before_host: false, mute_upon_entry: true, approval_type: 2 },
    }),
  });
  if (!res.ok) throw new Error(`Zoom ミーティング作成失敗: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { id: number; join_url: string; password?: string; start_url?: string; topic: string };
  return { id: String(j.id), joinUrl: j.join_url, password: j.password ?? '', startUrl: j.start_url, topic: j.topic };
}

export async function deleteZoomMeeting(id: string) {
  const token = await accessToken();
  const res = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok && res.status !== 404) throw new Error(`Zoom ミーティング削除失敗: ${res.status}`);
}

/** テスト用 */
export function resetZoomTokenCache() {
  tokenCache = null;
}
