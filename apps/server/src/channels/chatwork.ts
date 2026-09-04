import { env, isConfigured } from '../config.js';
import { hmacSha256Base64, safeEqual } from '../crypto.js';
import type { ChannelAdapter, InboundMessage, SendResult } from './types.js';
import { logger } from '../logger.js';

const API = 'https://api.chatwork.com/v2';

export interface ChatworkMessage {
  message_id: string;
  account: { account_id: number; name: string; avatar_image_url?: string };
  body: string;
  send_time: number;
  update_time: number;
}

export interface ChatworkRoom {
  room_id: number;
  name: string;
  type: 'my' | 'direct' | 'group';
  role?: string;
  unread_num?: number;
  last_update_time?: number;
}

export interface ChatworkTask {
  task_id: number;
  room: { room_id: number; name: string };
  assigned_by_account: { account_id: number; name: string };
  message_id: string;
  body: string;
  limit_time: number;
  status: 'open' | 'done';
  limit_type?: 'none' | 'date' | 'time';
}

export interface ChatworkWebhookBody {
  webhook_setting_id: string;
  webhook_event_type: 'message_created' | 'message_updated' | 'mention_to_me';
  webhook_event_time: number;
  webhook_event: {
    message_id: string;
    room_id: number;
    account_id: number;
    from_account_id?: number;
    to_account_id?: number;
    body: string;
    send_time: number;
    update_time: number;
  };
}

/** X-ChatWorkWebhookSignature = base64(HMAC-SHA256(base64decode(token), rawBody)) */
export function verifyChatworkSignature(rawBody: Buffer, signature: string | undefined): boolean {
  const token = env().CHATWORK_WEBHOOK_TOKEN;
  if (!token || !signature) return false;
  const key = Buffer.from(token, 'base64');
  return safeEqual(hmacSha256Base64(key, rawBody), signature);
}

let rateLimitResetAt = 0;

async function cw<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!isConfigured('chatwork')) throw new Error('CHATWORK_API_TOKEN が設定されていません');
  if (rateLimitResetAt > Date.now()) {
    await new Promise((r) => setTimeout(r, rateLimitResetAt - Date.now()));
  }
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'X-ChatWorkToken': env().CHATWORK_API_TOKEN!, ...((init.headers as Record<string, string>) ?? {}) },
  });
  const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? '1');
  const reset = Number(res.headers.get('x-ratelimit-reset') ?? '0');
  if (remaining <= 1 && reset) rateLimitResetAt = reset * 1000;
  if (res.status === 429) {
    rateLimitResetAt = reset ? reset * 1000 : Date.now() + 60_000;
    throw new Error('Chatwork API のレート制限に達しました');
  }
  if (res.status === 204) return [] as unknown as T;
  if (!res.ok) throw new Error(`Chatwork API エラー ${res.status} ${path}: ${await res.text()}`);
  return (await res.json()) as T;
}

function form(data: Record<string, string | number | undefined>): string {
  return Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

export async function chatworkMe(): Promise<{ account_id: number; name: string }> {
  return cw('/me');
}

export async function listRooms(): Promise<ChatworkRoom[]> {
  return cw('/rooms');
}

export async function myChatRoomId(): Promise<number | null> {
  const configured = env().CHATWORK_NOTIFY_ROOM_ID;
  if (configured) return Number(configured);
  const rooms = await listRooms();
  return rooms.find((r) => r.type === 'my')?.room_id ?? null;
}

/** force=1 で直近 100 件を取得（取りこぼし防止のため常に force） */
export async function fetchRoomMessages(roomId: number): Promise<ChatworkMessage[]> {
  return cw(`/rooms/${roomId}/messages?force=1`);
}

export async function fetchMessage(roomId: number, messageId: string): Promise<ChatworkMessage> {
  return cw(`/rooms/${roomId}/messages/${messageId}`);
}

export async function postMessage(roomId: number, body: string): Promise<{ message_id: string }> {
  return cw(`/rooms/${roomId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ body }),
  });
}

export async function uploadFile(roomId: number, filename: string, data: Buffer, message?: string): Promise<{ file_id: number }> {
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(data)]), filename);
  if (message) fd.append('message', message);
  return cw(`/rooms/${roomId}/files`, { method: 'POST', body: fd });
}

export async function fileDownloadUrl(roomId: number, fileId: number): Promise<{ download_url: string; filename: string; filesize: number }> {
  return cw(`/rooms/${roomId}/files/${fileId}?create_download_url=1`);
}

export async function listRoomFiles(roomId: number): Promise<{ file_id: number; filename: string; filesize: number; upload_time: number; message_id: string }[]> {
  return cw(`/rooms/${roomId}/files`);
}

export async function createTask(roomId: number, body: string, toIds: number[], limitUnix?: number, limitType: 'none' | 'date' | 'time' = 'date'): Promise<{ task_ids: number[] }> {
  return cw(`/rooms/${roomId}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ body, to_ids: toIds.join(','), limit: limitUnix, limit_type: limitUnix ? limitType : 'none' }),
  });
}

export async function myTasks(status: 'open' | 'done' = 'open'): Promise<ChatworkTask[]> {
  return cw(`/my/tasks?status=${status}`);
}

export async function setTaskStatus(roomId: number, taskId: number, status: 'open' | 'done'): Promise<void> {
  await cw(`/rooms/${roomId}/tasks/${taskId}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ body: status }),
  });
}

/** Chatwork 記法を読みやすいテキストに（[To:] [rp] [info] [download] など） */
export function stripChatworkMarkup(body: string): string {
  return body
    .replace(/\[To:\d+\]\s*[^\n]*?(さん)?/g, (m) => m.replace(/\[To:\d+\]/, '@'))
    .replace(/\[rp aid=\d+ to=\d+-\d+\]/g, '')
    .replace(/\[qt\]\[qtmeta[^\]]*\]/g, '＞ ')
    .replace(/\[\/qt\]/g, '')
    .replace(/\[info\]\[title\]/g, '')
    .replace(/\[\/title\]/g, '\n')
    .replace(/\[\/?info\]/g, '')
    .replace(/\[dtext:file_uploaded\]/g, 'ファイルをアップロードしました')
    .replace(/\[download:\d+\]/g, '[添付] ')
    .replace(/\[\/download\]/g, '')
    .replace(/\[\/?(hr|code|preview[^\]]*|picon:\d+|piconname:\d+)\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 本文中の [download:ID]名前 (サイズ)[/download] を抽出 */
export function extractDownloadIds(body: string): { fileId: number; filename: string }[] {
  const out: { fileId: number; filename: string }[] = [];
  const re = /\[download:(\d+)\]([^\[]*?)\s*(?:\([^)]*\))?\s*\[\/download\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    out.push({ fileId: Number(m[1]), filename: m[2].trim() || `file_${m[1]}` });
  }
  return out;
}

export function normalizeChatworkMessage(roomId: number, m: ChatworkMessage, myAccountId: number | null): InboundMessage {
  const isMine = myAccountId !== null && m.account.account_id === myAccountId;
  const files = extractDownloadIds(m.body);
  return {
    channel: 'chatwork',
    externalThreadId: String(roomId),
    externalId: m.message_id,
    direction: isMine ? 'out' : 'in',
    sentAt: new Date(m.send_time * 1000).toISOString(),
    senderName: m.account.name,
    senderAddress: String(m.account.account_id),
    body: stripChatworkMarkup(m.body),
    attachments: files.map((f) => ({ filename: f.filename, ref: { roomId, fileId: f.fileId } })),
    identity: { channel: 'chatwork', chatworkRoomId: roomId, chatworkAccountId: m.account.account_id, displayName: m.account.name },
    raw: m as unknown as Record<string, unknown>,
  };
}

export const chatworkAdapter: ChannelAdapter = {
  channel: 'chatwork',
  isConfigured: () => isConfigured('chatwork'),
  async fetchAttachment(att) {
    const ref = att.ref as { roomId: number; fileId: number };
    const info = await fileDownloadUrl(ref.roomId, ref.fileId);
    const res = await fetch(info.download_url); // 30 秒以内に取得
    if (!res.ok) throw new Error(`Chatwork ファイル取得失敗 ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },
  async send(opts): Promise<SendResult> {
    const roomId = Number(opts.externalThreadId);
    let text = opts.text;
    if (opts.fileLinks?.length) text += '\n\n' + opts.fileLinks.map((f) => `${f.name}\n${f.url}`).join('\n');
    let messageId: string | null = null;
    const files = opts.files ?? [];
    if (files.length === 0) {
      const r = await postMessage(roomId, text);
      messageId = r.message_id;
    } else {
      // 1 件目のファイルにメッセージを添えて送信、残りは続けて送信（5MB 超は事前にリンク化されている想定）
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const r = await uploadFile(roomId, f.filename, f.data, i === 0 ? text : undefined);
        if (i === 0) messageId = `file_${r.file_id}`;
      }
    }
    // アップロード時は message_id が返らないため、直後の自分の投稿を引き当てる
    if (messageId?.startsWith('file_')) {
      try {
        const msgs = await fetchRoomMessages(roomId);
        const mine = msgs.filter((m) => m.body.includes('[dtext:file_uploaded]')).at(-1);
        if (mine) messageId = mine.message_id;
      } catch (err) {
        logger.warn({ err }, 'アップロード後のメッセージ ID 解決に失敗');
      }
    }
    return { externalId: messageId ?? `out_${Date.now()}`, externalThreadId: String(roomId), sentAt: new Date().toISOString() };
  },
};

export const CHATWORK_FILE_LIMIT = 5 * 1024 * 1024;
