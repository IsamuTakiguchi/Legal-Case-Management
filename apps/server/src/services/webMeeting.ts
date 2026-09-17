import { isConfigured } from '../config.js';
import { isGoogleConnected } from '../integrations/google.js';
import { createZoomMeeting } from '../integrations/zoom.js';
import { getSetting } from './settings.js';

/** WEB 会議の提供元: zoom（設定済み）> meet（Google 接続済み）> なし */
export type WebMeetingProvider = 'zoom' | 'meet' | 'none';

export const WEB_PROVIDER_LABEL: Record<WebMeetingProvider, string> = {
  zoom: 'Zoom',
  meet: 'Google Meet',
  none: 'WEB 会議（URL なし）',
};

export function webMeetingProvider(): WebMeetingProvider {
  const pref = getSetting('web_meeting_provider'); // auto | zoom | meet
  if (pref === 'zoom') return isConfigured('zoom') ? 'zoom' : 'none';
  if (pref === 'meet') return isGoogleConnected() ? 'meet' : 'none';
  if (isConfigured('zoom')) return 'zoom';
  if (isGoogleConnected()) return 'meet';
  return 'none';
}

/** 発行した WEB 会議。meet は予定を作るとき Google 側で発行されるので、ここでは zoom だけ作る */
export interface WebMeeting {
  provider: WebMeetingProvider;
  url: string | null;
  password: string;
  /** Zoom のミーティング ID（取り消すときに使う） */
  id: string | null;
}

/** カレンダーの説明欄・返信文に入れる案内文 */
export function webMeetingText(m: WebMeeting | null): string {
  if (!m?.url) return '';
  if (m.provider === 'zoom') return `Zoom: ${m.url}${m.password ? `\nパスコード: ${m.password}` : ''}`;
  return `Google Meet: ${m.url}`;
}

/**
 * Zoom のミーティングを発行する。
 * 提供元が Google Meet のときは予定の作成時に Google が発行するので、ここでは何もしない。
 */
export async function issueZoomIfNeeded(
  provider: WebMeetingProvider,
  opts: { topic: string; startAt: Date; durationMinutes: number; agenda?: string },
): Promise<WebMeeting | null> {
  if (provider !== 'zoom') return null;
  const z = await createZoomMeeting(opts);
  return { provider: 'zoom', url: z.joinUrl, password: z.password, id: z.id };
}

/** 場所の既定値（WEB のとき、場所が空なら提供元の名前を入れる） */
export function webLocation(provider: WebMeetingProvider, location?: string | null): string {
  const l = (location ?? '').trim();
  if (l) return l;
  return provider === 'zoom' ? 'Zoom' : provider === 'meet' ? 'Google Meet' : 'WEB会議';
}
