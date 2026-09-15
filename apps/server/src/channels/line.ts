import { env, isConfigured } from '../config.js';
import { hmacSha256Base64, safeEqual } from '../crypto.js';
import type { ChannelAdapter, InboundMessage, OutboundFile, SendResult } from './types.js';
import { logger } from '../logger.js';
import { lineAccessToken } from '../services/lineSetup.js';

const API = 'https://api.line.me/v2/bot';
const DATA_API = 'https://api-data.line.me/v2/bot';

export interface LineEvent {
  type: string;
  timestamp: number;
  source?: { type: string; userId?: string; groupId?: string; roomId?: string };
  replyToken?: string;
  webhookEventId?: string;
  message?: {
    id: string;
    type: string;
    text?: string;
    fileName?: string;
    fileSize?: number;
    contentProvider?: { type: string; originalContentUrl?: string };
    title?: string;
    address?: string;
    latitude?: number;
    longitude?: number;
    stickerId?: string;
    packageId?: string;
    duration?: number;
  };
}

export function verifyLineSignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = env().LINE_CHANNEL_SECRET;
  if (!secret || !signature) return false;
  return safeEqual(hmacSha256Base64(secret, rawBody), signature);
}

async function authHeaders(): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await lineAccessToken()}` };
}

/**
 * その発言が属するトーク（会話）の ID。
 * グループ・複数人トークの発言には「グループ ID」と「発言した人の ID」の両方が入っているので、
 * かならずグループ（トークルーム）を優先する。個人を優先すると、グループの発言が
 * 個人トークに混ざり、返信もグループではなくその人ひとりに送られてしまう。
 */
export function lineThreadId(ev: LineEvent): string | null {
  const s = ev.source;
  if (!s) return null;
  return s.groupId ?? s.roomId ?? s.userId ?? null;
}

/** グループ（C…）・複数人トーク（R…）の ID か。個人は U… */
export function isLineGroupThread(threadId: string): boolean {
  return threadId.startsWith('C') || threadId.startsWith('R');
}

/** グループの名前（会話の表示名に使う）。取れなければ null */
export async function getLineGroupSummary(groupId: string): Promise<{ groupName: string; pictureUrl?: string } | null> {
  if (!groupId.startsWith('C')) return null; // 複数人トーク（R…）には名前が無い
  try {
    const res = await fetch(`${API}/group/${encodeURIComponent(groupId)}/summary`, { headers: await authHeaders(), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      logger.warn({ status: res.status, groupId }, 'LINE グループ情報の取得に失敗');
      return null;
    }
    return (await res.json()) as { groupName: string; pictureUrl?: string };
  } catch (err) {
    logger.warn({ err, groupId }, 'LINE グループ情報の取得に失敗');
    return null;
  }
}

/** グループ内の発言者の表示名（友だちでなくても取れる） */
export async function getLineGroupMemberProfile(threadId: string, userId: string): Promise<{ displayName: string; pictureUrl?: string } | null> {
  const kind = threadId.startsWith('C') ? 'group' : 'room';
  const path = kind === 'group' ? `${API}/group/${encodeURIComponent(threadId)}/member/${encodeURIComponent(userId)}` : `${API}/room/${encodeURIComponent(threadId)}/member/${encodeURIComponent(userId)}`;
  try {
    const res = await fetch(path, { headers: await authHeaders(), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as { displayName: string; pictureUrl?: string };
  } catch {
    return null;
  }
}

/**
 * そのグループにまだ入っているか。退出（強制退出）させられていると push しても届かない。
 * 判断できないときは 'unknown'（送信は止めない）
 */
export async function lineGroupStatus(threadId: string): Promise<'ok' | 'left' | 'unknown'> {
  const path = threadId.startsWith('C')
    ? `${API}/group/${encodeURIComponent(threadId)}/summary`
    : `${API}/room/${encodeURIComponent(threadId)}/members/count`;
  try {
    const res = await fetch(path, { headers: await authHeaders(), signal: AbortSignal.timeout(10_000) });
    if (res.ok) return 'ok';
    if (res.status === 404) return 'left';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

const MIME_BY_TYPE: Record<string, string> = { image: 'image/jpeg', video: 'video/mp4', audio: 'audio/m4a' };
const EXT_BY_TYPE: Record<string, string> = { image: 'jpg', video: 'mp4', audio: 'm4a' };

/** webhook イベントを正規化。display name は後で profile API で補う */
export function normalizeLineEvent(ev: LineEvent): InboundMessage | null {
  if (ev.type !== 'message' || !ev.message) return null;
  const threadId = lineThreadId(ev);
  if (!threadId) return null;
  const m = ev.message;
  const sentAt = new Date(ev.timestamp).toISOString();
  let body = '';
  const attachments: InboundMessage['attachments'] = [];
  switch (m.type) {
    case 'text':
      body = m.text ?? '';
      break;
    case 'image':
    case 'video':
    case 'audio': {
      const ext = EXT_BY_TYPE[m.type];
      body = `[${m.type === 'image' ? '画像' : m.type === 'video' ? '動画' : '音声'}]`;
      if (m.contentProvider?.type === 'line' || !m.contentProvider) {
        attachments.push({ filename: `${m.type}_${m.id}.${ext}`, mime: MIME_BY_TYPE[m.type], ref: { messageId: m.id, type: m.type } });
      } else if (m.contentProvider.originalContentUrl) {
        attachments.push({ filename: `${m.type}_${m.id}.${ext}`, mime: MIME_BY_TYPE[m.type], ref: { url: m.contentProvider.originalContentUrl } });
      }
      break;
    }
    case 'file':
      body = `[ファイル] ${m.fileName ?? ''}`;
      attachments.push({ filename: m.fileName ?? `file_${m.id}`, size: m.fileSize ?? null, ref: { messageId: m.id, type: 'file' } });
      break;
    case 'location':
      body = `[位置情報] ${m.title ?? ''} ${m.address ?? ''}`.trim();
      break;
    case 'sticker':
      body = '[スタンプ]';
      break;
    default:
      body = `[${m.type}]`;
  }
  return {
    channel: 'line',
    externalThreadId: threadId,
    externalId: m.id,
    direction: 'in',
    sentAt,
    senderAddress: ev.source?.userId ?? null,
    body,
    attachments,
    identity: { channel: 'line', lineUserId: ev.source?.userId ?? null },
    raw: ev as unknown as Record<string, unknown>,
    replyToken: ev.replyToken ?? null,
  };
}

/**
 * 友だち（フォロワー）のユーザー ID 一覧。LINE の仕様上、認証済アカウントまたはプレミアムアカウントでのみ使える。
 * 使えないアカウントでは ok: false と理由を返す
 */
export async function getLineFollowerIds(): Promise<{ ok: true; userIds: string[] } | { ok: false; reason: string }> {
  const userIds: string[] = [];
  let start: string | undefined;
  for (let i = 0; i < 50; i++) {
    const url = `${API}/followers/ids?limit=1000${start ? `&start=${encodeURIComponent(start)}` : ''}`;
    const res = await fetch(url, { headers: await authHeaders() });
    if (res.status === 403 || res.status === 404) {
      return { ok: false, reason: '友だち一覧の取得は、LINE の仕様で「認証済アカウント」または「プレミアムアカウント」でのみ使えます。未認証の場合は、依頼者に一度メッセージを送ってもらうか、友だち追加の通知（要確認）から紐付けてください。' };
    }
    if (!res.ok) return { ok: false, reason: `LINE API エラー ${res.status}` };
    const j = (await res.json()) as { userIds: string[]; next?: string };
    userIds.push(...(j.userIds ?? []));
    if (!j.next) break;
    start = j.next;
  }
  return { ok: true, userIds };
}

/**
 * その相手に push が届くかの目安。
 * LINE はブロック・友だち解除・退会した相手に push しても 200 を返して実際には届かないので、
 * プロフィールが引けるか（404 ならブロック等）で判断する。
 * 通信エラーなど判断できないときは 'unknown'（送信は止めない）
 */
export async function lineProfileStatus(userId: string): Promise<'ok' | 'blocked' | 'unknown'> {
  try {
    const res = await fetch(`${API}/profile/${encodeURIComponent(userId)}`, { headers: await authHeaders(), signal: AbortSignal.timeout(10_000) });
    if (res.ok) return 'ok';
    if (res.status === 404) return 'blocked';
    logger.warn({ status: res.status, userId }, 'LINE プロフィール確認が不明な応答');
    return 'unknown';
  } catch (err) {
    logger.warn({ err, userId }, 'LINE プロフィール確認に失敗');
    return 'unknown';
  }
}

export async function getLineProfile(userId: string): Promise<{ displayName: string; pictureUrl?: string } | null> {
  const res = await fetch(`${API}/profile/${encodeURIComponent(userId)}`, { headers: await authHeaders() });
  if (!res.ok) {
    logger.warn({ status: res.status, userId }, 'LINE プロフィール取得失敗');
    return null;
  }
  return (await res.json()) as { displayName: string; pictureUrl?: string };
}

async function waitForContent(messageId: string): Promise<void> {
  // 動画・音声は変換完了を待つ
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${DATA_API}/message/${messageId}/content/transcoding`, { headers: await authHeaders() });
    if (!res.ok) return;
    const j = (await res.json()) as { status: string };
    if (j.status === 'succeeded') return;
    if (j.status === 'failed') throw new Error('LINE コンテンツの変換に失敗しました');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * 画像・ファイルの中身を取得する。受信直後はまだ用意できていないことがある（404）ほか、
 * 混雑（429）や一時的なエラー（5xx）もあるので、少し待って数回まで取り直す。1 回の取得は 30 秒で打ち切る。
 */
export async function fetchLineContent(messageId: string, opts: { attempts?: number; waitMs?: number } = {}): Promise<Buffer> {
  const attempts = opts.attempts ?? 4;
  const waitMs = opts.waitMs ?? 1500;
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, waitMs * i));
    try {
      const res = await fetch(`${DATA_API}/message/${messageId}/content`, { headers: await authHeaders(), signal: AbortSignal.timeout(30_000) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      const retryable = res.status === 404 || res.status === 429 || res.status >= 500;
      lastErr = new Error(`LINE コンテンツ取得失敗 ${res.status}${res.status === 404 ? '（保存期間を過ぎたか、まだ用意できていません）' : res.status === 401 || res.status === 403 ? '（チャネルアクセストークンを確認してください）' : ''}`);
      if (!retryable) throw lastErr;
    } catch (err) {
      lastErr = err;
      // ネットワークエラー・タイムアウトも取り直す
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface LineSendResult extends SendResult {
  pushed: boolean;
}

/** 外部プロバイダーのコンテンツ URL は LINE 系ドメインの https のみ取得する（SSRF 対策） */
export function isAllowedContentUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return ['line-scdn.net', 'line.me', 'line-apps.com', 'line.naver.jp'].some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

export const lineAdapter: ChannelAdapter = {
  channel: 'line',
  isConfigured: () => isConfigured('line'),
  async fetchAttachment(att) {
    const ref = att.ref as { messageId?: string; type?: string; url?: string };
    if (ref.url) {
      if (!isAllowedContentUrl(ref.url)) throw new Error('許可されていない外部コンテンツ URL です');
      const res = await fetch(ref.url);
      if (!res.ok) throw new Error(`外部コンテンツ取得失敗 ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    }
    if (!ref.messageId) throw new Error('LINE 添付の参照情報がありません');
    if (ref.type === 'video' || ref.type === 'audio') await waitForContent(ref.messageId);
    return fetchLineContent(ref.messageId);
  },
  async send(opts) {
    // Messaging API はファイル送信不可: リンク文または手動送付案内を本文に付ける
    let text = opts.text;
    if (opts.fileLinks?.length) {
      text += '\n\n' + opts.fileLinks.map((f) => `▼${f.name}\n${f.url}`).join('\n');
    }
    const { chunks, dropped } = splitLineMessages(text);
    const messages = chunks.map((t) => ({ type: 'text', text: t }));
    const { id, requestId } = await pushLineMessages(opts.externalThreadId, messages);
    const notes: string[] = [];
    if ((opts.files?.length ?? 0) > 0) notes.push(`LINE ではファイルを直接送信できないため ${opts.files!.length} 件は送信していません`);
    if (dropped > 0) notes.push(`LINE の 1 回の送信上限を超えたため、末尾 ${dropped} 文字は送っていません`);
    return { externalId: id, externalThreadId: opts.externalThreadId, sentAt: new Date().toISOString(), note: notes.join('。') || undefined, requestId };
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * push を送る。ネットワークの一時的な不調・タイムアウト・LINE 側の 5xx は、
 * 同じ X-Line-Retry-Key で送り直す（LINE 側で重複排除されるので二重に届かない）。
 * すでに受理済みのときは 409 が返るので、それは成功として扱う。
 */
export async function pushLineMessages(to: string, messages: { type: string; text: string }[], attempts = 3): Promise<{ id: string; requestId: string | null }> {
  const retryKey = crypto.randomUUID();
  let lastErr: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(1000 * i);
    let res: Response;
    try {
      res = await fetch(`${API}/message/push`, {
        method: 'POST',
        headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'X-Line-Retry-Key': retryKey },
        body: JSON.stringify({ to, messages }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      // 応答が返らなかった場合、実際には届いていることがある。同じキーで送り直せば二重送信にならない
      lastErr = err instanceof Error ? err : new Error(String(err));
      logger.warn({ err, attempt: i + 1 }, 'LINE 送信の通信に失敗。送り直します');
      continue;
    }
    const requestId = res.headers.get('x-line-request-id');
    // 409 = 同じキーの送信をすでに受理済み（前回の試行が実は通っていた）
    if (res.status === 409) {
      logger.info({ requestId }, 'LINE 送信はすでに受理済みでした（再試行の重複排除）');
      return { id: `out_${Date.now()}`, requestId };
    }
    if (res.ok) {
      const j = (await res.json().catch(() => ({}))) as { sentMessages?: { id: string }[] };
      logger.info({ requestId, messages: messages.length }, 'LINE に送信しました');
      return { id: j.sentMessages?.[0]?.id ?? `out_${Date.now()}`, requestId };
    }
    const body = await res.text().catch(() => '');
    if (res.status === 429 && /monthly limit/i.test(body)) throw new Error('LINE の月間メッセージ上限に達したため送信できません');
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`LINE 送信失敗 ${res.status}: ${body}`);
      const wait = Number(res.headers.get('retry-after') ?? 0);
      logger.warn({ status: res.status, requestId, attempt: i + 1 }, 'LINE 送信が一時的に失敗。送り直します');
      if (wait > 0 && wait <= 30) await sleep(wait * 1000);
      continue;
    }
    throw new Error(`LINE 送信失敗 ${res.status}: ${body}`);
  }
  throw lastErr ?? new Error('LINE 送信に失敗しました');
}

/**
 * LINE のテキストは 5000 文字まで、1 回の送信は 5 通まで。
 * 入りきらない分は送れないので、その文字数も返す（送信後の注意書きに使う）
 */
export function splitLineMessages(text: string, limit = 5000): { chunks: string[]; dropped: number } {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit && out.length < 4) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  out.push(rest.slice(0, limit));
  return { chunks: out, dropped: Math.max(0, rest.length - limit) };
}

/** LINE のテキストは 5000 文字まで。超える場合は分割（最大 5 通） */
export function splitLineText(text: string, limit = 5000): string[] {
  return splitLineMessages(text, limit).chunks;
}

export function lineFilesUnsupported(files?: OutboundFile[]): boolean {
  return (files?.length ?? 0) > 0;
}
