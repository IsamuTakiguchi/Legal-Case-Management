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
    const wait = rateLimitResetAt - Date.now();
    // 長い待ちは画面が固まる原因になるので、10 秒を超える場合は待たずにエラーにする（ジョブは次回に回る）
    if (wait > 10_000) throw new Error(`Chatwork API のレート制限中です（あと ${Math.ceil(wait / 1000)} 秒）`);
    await new Promise((r) => setTimeout(r, wait));
  }
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'X-ChatWorkToken': env().CHATWORK_API_TOKEN!, ...((init.headers as Record<string, string>) ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(15_000),
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

export interface ChatworkMember {
  account_id: number;
  name: string;
  role?: string;
}

export async function roomMembers(roomId: number): Promise<ChatworkMember[]> {
  return cw(`/rooms/${roomId}/members`);
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
/** 本文の [rp aid=.. to=room-msgid] から返信先のメッセージ ID を取り出す */
export function parseChatworkReplyTo(body: string): { accountId: number; messageId: string } | null {
  const m = /\[rp aid=(\d+) to=\d+-(\d+)\]/.exec(body);
  return m ? { accountId: Number(m[1]), messageId: m[2] } : null;
}

/** Chatwork の「返信」タグ（相手の名前つき） */
export function chatworkReplyPrefix(roomId: number, target: { accountId: number; messageId: string }): string {
  return `[rp aid=${target.accountId} to=${roomId}-${target.messageId}][pname:${target.accountId}]さん\n`;
}

/** Chatwork の「引用」ブロック */
export function chatworkQuoteBlock(target: { accountId: number; sendTimeUnix: number; body: string }): string {
  return `[qt][qtmeta aid=${target.accountId} time=${target.sendTimeUnix}]${target.body}[/qt]\n`;
}

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
    const fileId = Number(m[1]);
    // 引用などで同じファイルが 2 回書かれていても 1 件として扱う（二重保存の防止）
    if (out.some((x) => x.fileId === fileId)) continue;
    out.push({ fileId, filename: m[2].trim() || `file_${fileId}` });
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
    senderName: m.account.name || null,
    senderAddress: String(m.account.account_id),
    body: stripChatworkMarkup(m.body),
    attachments: files.map((f) => ({ filename: f.filename, ref: { roomId, fileId: f.fileId } })),
    identity: { channel: 'chatwork', chatworkRoomId: roomId, chatworkAccountId: m.account.account_id, displayName: m.account.name },
    raw: { ...(m as unknown as Record<string, unknown>), replyToExternalId: parseChatworkReplyTo(m.body)?.messageId ?? null },
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

/** 本文が自分宛か（[To:自分]、自分への返信 [rp aid=自分 ...]、または [toall]） */
export function isAddressedToMe(body: string, myAccountId: number | null): boolean {
  if (/\[toall\]/i.test(body)) return true;
  if (myAccountId === null) return false;
  if (new RegExp(`\\[To:${myAccountId}\\]`).test(body)) return true;
  // 返信（re）: [rp aid=12345 to=roomid-messageid]
  return new RegExp(`\\[rp aid=${myAccountId}\\b`).test(body);
}

export type ChatworkScope = 'all' | 'to_me';

/**
 * 取込範囲の判定。
 * to_me のときは、自分宛の To・自分への返信（re）・全員宛・ダイレクトチャット・自分に振られたタスクのメッセージだけ取り込む。
 * 自分の発言は、すでに取り込んでいる会話への返信として文脈が要るので、会話が存在する場合だけ取り込む。
 */
export function chatworkInScope(
  scope: ChatworkScope,
  m: { body: string; message_id: string; account: { account_id: number } },
  ctx: { myAccountId: number | null; roomType?: string | null; taskMessageIds?: Set<string>; conversationExists?: boolean },
): boolean {
  if (scope !== 'to_me') return true;
  const isMine = ctx.myAccountId !== null && m.account.account_id === ctx.myAccountId;
  if (isMine) return !!ctx.conversationExists;
  if (ctx.roomType === 'direct') return true;
  if (isAddressedToMe(m.body, ctx.myAccountId)) return true;
  if (ctx.taskMessageIds?.has(m.message_id)) return true;
  return false;
}
