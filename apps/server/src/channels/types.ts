import type { Channel } from '@lcm/shared';

/** 受信したメッセージを正規化した形 */
export interface InboundMessage {
  channel: Channel;
  externalThreadId: string;
  externalId: string;
  direction: 'in' | 'out';
  sentAt: string; // ISO
  senderName?: string | null;
  senderAddress?: string | null; // email / line userId / chatwork account id
  subject?: string | null;
  body: string;
  attachments: InboundAttachment[];
  identity: IdentityHint;
  raw?: Record<string, unknown>;
  replyToken?: string | null;
  threadMeta?: Record<string, unknown>;
}

export interface InboundAttachment {
  filename: string;
  mime?: string | null;
  size?: number | null;
  /** チャネル固有の取得情報（messageId, attachmentId, file_id など） */
  ref: Record<string, unknown>;
}

export interface IdentityHint {
  channel: Channel;
  email?: string | null;
  lineUserId?: string | null;
  chatworkRoomId?: number | null;
  chatworkAccountId?: number | null;
  displayName?: string | null;
}

export interface OutboundFile {
  filename: string;
  mime?: string | null;
  data: Buffer;
}

export interface SendResult {
  externalId: string;
  externalThreadId: string;
  sentAt: string;
  /** LINE などファイル送信不可のチャネルで、リンク化して送った／手動送付案内したファイル */
  note?: string;
}

export interface ChannelAdapter {
  channel: Channel;
  isConfigured(): boolean;
  fetchAttachment(att: { ref: Record<string, unknown> }): Promise<Buffer>;
  send(opts: {
    externalThreadId: string;
    to?: string | null;
    subject?: string | null;
    text: string;
    files?: OutboundFile[];
    fileLinks?: { name: string; url: string }[];
    inReplyTo?: Record<string, unknown> | null;
  }): Promise<SendResult>;
}
