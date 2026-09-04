import type { gmail_v1 } from 'googleapis';
import { gmailApi, isGoogleConnected } from '../integrations/google.js';
import type { ChannelAdapter, InboundMessage, SendResult } from './types.js';

type GmailMessage = gmail_v1.Schema$Message;
type Part = gmail_v1.Schema$MessagePart;

export function header(msg: GmailMessage, name: string): string | null {
  const h = msg.payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

export function parseAddress(v: string | null): { name: string | null; email: string | null } {
  if (!v) return { name: null, email: null };
  const m = v.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
  if (m) return { name: (m[1] ?? '').trim() || null, email: m[2].trim().toLowerCase() };
  return { name: null, email: v.trim().toLowerCase() };
}

function decodeBody(data?: string | null): string {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractBodyAndAttachments(msg: GmailMessage): { text: string; attachments: InboundMessage['attachments'] } {
  let plain = '';
  let html = '';
  const attachments: InboundMessage['attachments'] = [];
  const walk = (p?: Part | null) => {
    if (!p) return;
    const mime = p.mimeType ?? '';
    if (p.filename && p.body?.attachmentId) {
      attachments.push({ filename: p.filename, mime, size: p.body.size ?? null, ref: { messageId: msg.id, attachmentId: p.body.attachmentId } });
    } else if (mime === 'text/plain' && p.body?.data && !plain) {
      plain = decodeBody(p.body.data);
    } else if (mime === 'text/html' && p.body?.data && !html) {
      html = decodeBody(p.body.data);
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(msg.payload);
  const text = plain || (html ? htmlToText(html) : '') || msg.snippet || '';
  return { text: text.trim(), attachments };
}

/** 自分のアドレス（複数可）を渡し、送信か受信かを判定して正規化 */
export function normalizeGmailMessage(msg: GmailMessage, myAddresses: string[]): InboundMessage | null {
  if (!msg.id || !msg.threadId) return null;
  const labels = msg.labelIds ?? [];
  if (labels.includes('DRAFT') || labels.includes('SPAM') || labels.includes('TRASH')) return null;
  const from = parseAddress(header(msg, 'From'));
  const to = header(msg, 'To') ?? '';
  const isMine = labels.includes('SENT') || (from.email !== null && myAddresses.includes(from.email));
  const { text, attachments } = extractBodyAndAttachments(msg);
  const sentAt = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString();
  const counterpart = isMine ? parseAddress(to.split(',')[0] ?? null) : from;
  return {
    channel: 'gmail',
    externalThreadId: msg.threadId,
    externalId: msg.id,
    direction: isMine ? 'out' : 'in',
    sentAt,
    senderName: from.name,
    senderAddress: from.email,
    subject: header(msg, 'Subject'),
    body: text,
    attachments,
    identity: { channel: 'gmail', email: counterpart.email, displayName: counterpart.name },
    raw: { labelIds: labels, messageId: header(msg, 'Message-ID'), to, cc: header(msg, 'Cc') },
    threadMeta: { counterpartEmail: counterpart.email, counterpartName: counterpart.name },
  };
}

function encodeRfc2047(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

export function buildMime(opts: {
  from: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string | null;
  references?: string | null;
  files?: { filename: string; mime?: string | null; data: Buffer }[];
}): string {
  const lines: string[] = [];
  lines.push(`From: ${opts.from}`);
  lines.push(`To: ${opts.to}`);
  lines.push(`Subject: ${encodeRfc2047(opts.subject)}`);
  lines.push('MIME-Version: 1.0');
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  const textPart = ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', Buffer.from(opts.text, 'utf8').toString('base64')].join('\r\n');
  if (!opts.files?.length) {
    lines.push(textPart);
    return lines.join('\r\n');
  }
  const boundary = `----=_lcm_${Date.now().toString(36)}`;
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, textPart);
  for (const f of opts.files) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${f.mime || 'application/octet-stream'}; name="${encodeRfc2047(f.filename)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${encodeRfc2047(f.filename)}"`,
      '',
      f.data.toString('base64').replace(/(.{76})/g, '$1\r\n'),
    );
  }
  lines.push(`--${boundary}--`);
  return lines.join('\r\n');
}

export function toBase64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function fetchAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
  const res = await gmailApi().users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
  const data = res.data.data ?? '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export const gmailAdapter: ChannelAdapter = {
  channel: 'gmail',
  isConfigured: () => isGoogleConnected(),
  async fetchAttachment(att) {
    const ref = att.ref as { messageId: string; attachmentId: string };
    return fetchAttachment(ref.messageId, ref.attachmentId);
  },
  async send(opts): Promise<SendResult> {
    const gmail = gmailApi();
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const from = profile.data.emailAddress ?? '';
    if (!opts.to) throw new Error('宛先メールアドレスがありません');
    const reply = (opts.inReplyTo ?? {}) as { messageId?: string | null; references?: string | null; subject?: string | null };
    let subject = opts.subject ?? reply.subject ?? '';
    if (reply.messageId && subject && !/^re:/i.test(subject)) subject = `Re: ${subject}`;
    let text = opts.text;
    if (opts.fileLinks?.length) text += '\n\n' + opts.fileLinks.map((f) => `${f.name}\n${f.url}`).join('\n');
    const raw = buildMime({
      from,
      to: opts.to,
      subject,
      text,
      inReplyTo: reply.messageId ?? null,
      references: [reply.references, reply.messageId].filter(Boolean).join(' ') || null,
      files: opts.files,
    });
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: toBase64Url(raw), threadId: opts.externalThreadId.startsWith('new:') ? undefined : opts.externalThreadId },
    });
    return { externalId: res.data.id ?? `out_${Date.now()}`, externalThreadId: res.data.threadId ?? opts.externalThreadId, sentAt: new Date().toISOString() };
  },
};
