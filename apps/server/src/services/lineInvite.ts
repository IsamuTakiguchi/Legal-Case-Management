import QRCode from 'qrcode';
import { isConfigured } from '../config.js';
import { lineAccessToken } from './lineSetup.js';
import { getSyncState, setSyncState } from './settings.js';
import { logger } from '../logger.js';

/**
 * LINE公式アカウントの「友だち追加」案内。
 *
 * LINE の仕様上、相手のユーザー ID は「相手が友だち追加するか、メッセージを送ってくる」まで
 * 取得できない（友だち一覧 API は認証済／プレミアムアカウント専用）。
 * そこでこちらから友だち追加をお願いするための URL と QR コードを作る。
 * 相手が追加した時点で follow の通知が届き、「要確認」から依頼者に紐付けられる。
 */

const KEY = 'line:botInfo';
/** ベーシック ID はめったに変わらないので 1 日キャッシュする */
const TTL_MS = 24 * 3600_000;

export interface LineInvite {
  /** LINE の資格情報が設定済みか */
  configured: boolean;
  /** @ から始まるベーシック ID（プレミアム ID を設定していればそちら） */
  basicId: string | null;
  displayName: string | null;
  /** 依頼者に送る友だち追加 URL */
  addUrl: string | null;
  /** 同じ URL の QR コード（その場で読んでもらう用） */
  qrSvg: string | null;
  /** 取得できなかった理由 */
  reason: string | null;
}

interface BotInfo {
  basicId: string | null;
  displayName: string | null;
  fetchedAt: string;
}

function cached(): BotInfo | null {
  const raw = getSyncState(KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as BotInfo;
    if (!v.fetchedAt || Date.now() - new Date(v.fetchedAt).getTime() > TTL_MS) return null;
    return v;
  } catch {
    return null;
  }
}

/** 友だち追加 URL。LINE の URL スキームは https://line.me/R/ti/p/@ベーシックID */
export function lineAddFriendUrl(basicId: string): string {
  const id = basicId.startsWith('@') ? basicId : `@${basicId}`;
  return `https://line.me/R/ti/p/${encodeURIComponent(id)}`;
}

async function fetchBotInfo(): Promise<BotInfo> {
  const token = await lineAccessToken();
  const res = await fetch('https://api.line.me/v2/bot/info', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`LINE API エラー ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { basicId?: string; premiumId?: string; displayName?: string };
  // プレミアム ID（@なしの好きな ID）を設定していればそちらが友だち追加に使われる
  const info: BotInfo = { basicId: j.premiumId || j.basicId || null, displayName: j.displayName ?? null, fetchedAt: new Date().toISOString() };
  setSyncState(KEY, JSON.stringify(info));
  return info;
}

/**
 * 友だち追加の案内（URL と QR）を返す。
 * @param opts.refresh true ならキャッシュを使わず LINE に問い合わせ直す
 */
export async function lineInvite(opts: { refresh?: boolean } = {}): Promise<LineInvite> {
  const empty: LineInvite = { configured: false, basicId: null, displayName: null, addUrl: null, qrSvg: null, reason: null };
  if (!isConfigured('line')) return { ...empty, reason: 'LINE公式アカウントが未設定です。初期設定から登録してください' };
  let info = opts.refresh ? null : cached();
  if (!info) {
    try {
      info = await fetchBotInfo();
    } catch (err) {
      logger.warn({ err }, 'LINE のボット情報を取得できませんでした');
      return { ...empty, configured: true, reason: `LINE公式アカウントの情報を取得できませんでした（${(err as Error).message}）` };
    }
  }
  if (!info.basicId) {
    return { ...empty, configured: true, displayName: info.displayName, reason: 'LINE公式アカウントの ID を取得できませんでした' };
  }
  const addUrl = lineAddFriendUrl(info.basicId);
  // 依頼者にその場で読んでもらうための QR。SVG なので拡大しても粗くならない
  const qrSvg = await QRCode.toString(addUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).catch(() => null);
  return { configured: true, basicId: info.basicId, displayName: info.displayName, addUrl, qrSvg, reason: null };
}

/** 依頼者に送る案内文。メールや Chatwork に貼って使う */
export function lineInviteMessage(clientName: string | null, addUrl: string, officeName: string): string {
  const to = clientName ? `${clientName.split(/[\s　]/)[0]}様` : 'ご依頼者様';
  return [
    `${to}`,
    '',
    `${officeName}です。`,
    'ご連絡を LINE でも承れるよう、当事務所の LINE公式アカウントをご用意しました。',
    '下記から友だち追加していただけますでしょうか。',
    '',
    addUrl,
    '',
    '追加後、こちらから確認のご連絡をいたします。',
    'よろしくお願いいたします。',
  ].join('\n');
}
