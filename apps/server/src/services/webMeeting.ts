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

/**
 * 相手が発行した WEB 会議（こちらでは発行しない）。
 * 相手のメッセージに書かれた URL・ミーティング ID・パスコードをそのまま予定に入れる
 */
export interface ExternalMeeting {
  url: string;
  meetingId?: string | null;
  passcode?: string | null;
}

export type ExternalMeetingProvider = 'zoom' | 'meet' | 'teams' | 'webex' | 'other';

export const EXTERNAL_PROVIDER_LABEL: Record<ExternalMeetingProvider, string> = {
  zoom: 'Zoom',
  meet: 'Google Meet',
  teams: 'Microsoft Teams',
  webex: 'Webex',
  other: 'WEB会議',
};

/** 相手が URL を後で送ってくるときに、予定の説明欄に入れておく一文（URL が届いたら置き換える） */
export const EXTERNAL_PENDING_LINE = 'WEB 会議（相手方が URL を発行。届いたら追加）';

export function externalProviderOf(url: string): ExternalMeetingProvider {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  if (/(^|\.)zoom\.(us|com)$|(^|\.)zoomgov\.com$/.test(host)) return 'zoom';
  if (host === 'meet.google.com') return 'meet';
  if (/(^|\.)teams\.(microsoft|live)\.com$/.test(host)) return 'teams';
  if (/(^|\.)webex\.com$/.test(host)) return 'webex';
  return 'other';
}

const URL_RE = /https?:\/\/[^\s<>"'「」『』（）()、。]+/g;

/**
 * 本文から WEB 会議の URL を探す（Zoom・Google Meet・Teams・Webex）。
 * ミーティング ID・パスコードが書かれていれば一緒に取り出す
 */
export function findMeetingInText(text: string): ExternalMeeting | null {
  const urls = [...text.matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:!?]+$/, ''));
  const url = urls.find((u) => externalProviderOf(u) !== 'other');
  if (!url) return null;
  const id = /(?:ミーティング\s*ID|ミーティングＩＤ|会議\s*ID|Meeting\s*ID)\s*[:：]?\s*([0-9][0-9 　]{7,14}[0-9])/i.exec(text)?.[1]?.replace(/[\s　]+/g, ' ').trim() ?? null;
  const passcode = /(?:パスコード|パスワード|Passcode|Password)\s*[:：]?\s*([^\s　]+)/i.exec(text)?.[1] ?? null;
  return { url, meetingId: id, passcode };
}

/** 予定の説明欄・返信文に入れる案内文（相手が発行したもの） */
export function externalMeetingText(m: ExternalMeeting | null): string {
  if (!m?.url) return '';
  const label = EXTERNAL_PROVIDER_LABEL[externalProviderOf(m.url)];
  return [`${label}（相手方発行）: ${m.url}`, m.meetingId ? `ミーティング ID: ${m.meetingId}` : '', m.passcode ? `パスコード: ${m.passcode}` : ''].filter(Boolean).join('\n');
}

/** 場所の既定値（相手が発行した WEB 会議。場所が空なら「Zoom（相手方発行）」など） */
export function externalLocation(m: ExternalMeeting | null, location?: string | null): string {
  const l = (location ?? '').trim();
  if (l) return l;
  return m?.url ? `${EXTERNAL_PROVIDER_LABEL[externalProviderOf(m.url)]}（相手方発行）` : 'WEB会議（相手方発行）';
}

/**
 * 予定の説明欄に、相手が発行した会議の案内を入れる。
 * 「URL は後で」の一文や、前に入れた相手方発行の案内があれば置き換える
 */
export function withExternalMeeting(description: string | null | undefined, m: ExternalMeeting | null): string {
  const lines = (description ?? '').split('\n');
  const kept: string[] = [];
  let skipping = false;
  for (const l of lines) {
    if (l === EXTERNAL_PENDING_LINE) continue;
    if (/（相手方発行）: /.test(l)) {
      skipping = true;
      continue;
    }
    if (skipping && /^(ミーティング ID|パスコード): /.test(l)) continue;
    skipping = false;
    kept.push(l);
  }
  const head = m?.url ? externalMeetingText(m) : EXTERNAL_PENDING_LINE;
  return [head, kept.join('\n').trim()].filter(Boolean).join('\n');
}
