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

export function lineThreadId(ev: LineEvent): string | null {
  const s = ev.source;
  if (!s) return null;
  return s.userId ?? s.groupId ?? s.roomId ?? null;
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

export interface LineSendResult extends SendResult {
  pushed: boolean;
}

export const lineAdapter: ChannelAdapter = {
  channel: 'line',
  isConfigured: () => isConfigured('line'),
  async fetchAttachment(att) {
    const ref = att.ref as { messageId?: string; type?: string; url?: string };
    if (ref.url) {
      const res = await fetch(ref.url);
      if (!res.ok) throw new Error(`外部コンテンツ取得失敗 ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    }
    if (!ref.messageId) throw new Error('LINE 添付の参照情報がありません');
    if (ref.type === 'video' || ref.type === 'audio') await waitForContent(ref.messageId);
    const res = await fetch(`${DATA_API}/message/${ref.messageId}/content`, { headers: await authHeaders() });
    if (!res.ok) throw new Error(`LINE コンテンツ取得失敗 ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },
  async send(opts) {
    // Messaging API はファイル送信不可: リンク文または手動送付案内を本文に付ける
    let text = opts.text;
    if (opts.fileLinks?.length) {
      text += '\n\n' + opts.fileLinks.map((f) => `▼${f.name}\n${f.url}`).join('\n');
    }
    const chunks = splitLineText(text);
    const messages = chunks.map((t) => ({ type: 'text', text: t }));
    const res = await fetch(`${API}/message/push`, {
      method: 'POST',
      headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'X-Line-Retry-Key': crypto.randomUUID() },
      body: JSON.stringify({ to: opts.externalThreadId, messages }),
    });
    if (!res.ok) {
      const t = await res.text();
      if (res.status === 429) throw new Error('LINE の月間メッセージ上限に達したため送信できません');
      throw new Error(`LINE 送信失敗 ${res.status}: ${t}`);
    }
    const j = (await res.json().catch(() => ({}))) as { sentMessages?: { id: string }[] };
    const id = j.sentMessages?.[0]?.id ?? `out_${Date.now()}`;
    const note = (opts.files?.length ?? 0) > 0 ? `LINE ではファイルを直接送信できないため ${opts.files!.length} 件は送信していません` : undefined;
    return { externalId: id, externalThreadId: opts.externalThreadId, sentAt: new Date().toISOString(), note };
  },
};

/** LINE のテキストは 5000 文字まで。超える場合は分割（最大 5 通） */
export function splitLineText(text: string, limit = 5000): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit && out.length < 4) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  out.push(rest.slice(0, limit));
  return out;
}

export function lineFilesUnsupported(files?: OutboundFile[]): boolean {
  return (files?.length ?? 0) > 0;
}
