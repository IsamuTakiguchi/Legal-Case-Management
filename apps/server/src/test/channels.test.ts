import { describe, it, expect, beforeAll } from 'vitest';
import { createHmac } from 'node:crypto';

process.env.LINE_CHANNEL_SECRET = 'line-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'token';
process.env.CHATWORK_WEBHOOK_TOKEN = Buffer.from('chatwork-webhook-secret').toString('base64');
process.env.CHATWORK_API_TOKEN = 'cw-token';
process.env.SESSION_SECRET = 'test-session-secret';

const { verifyLineSignature, normalizeLineEvent, splitLineText } = await import('../channels/line.js');
const { verifyChatworkSignature, stripChatworkMarkup, extractDownloadIds, normalizeChatworkMessage } = await import('../channels/chatwork.js');
const { normalizeGmailMessage, buildMime, parseAddress } = await import('../channels/gmail.js');

describe('LINE', () => {
  it('署名検証', () => {
    const body = Buffer.from(JSON.stringify({ events: [] }));
    const sig = createHmac('sha256', 'line-secret').update(body).digest('base64');
    expect(verifyLineSignature(body, sig)).toBe(true);
    expect(verifyLineSignature(body, 'bad')).toBe(false);
    expect(verifyLineSignature(body, undefined)).toBe(false);
  });
  it('テキスト・ファイルイベントの正規化', () => {
    const text = normalizeLineEvent({ type: 'message', timestamp: 1700000000000, source: { type: 'user', userId: 'U1' }, replyToken: 'rt', message: { id: 'm1', type: 'text', text: 'こんにちは' } });
    expect(text?.body).toBe('こんにちは');
    expect(text?.externalThreadId).toBe('U1');
    expect(text?.identity.lineUserId).toBe('U1');
    const file = normalizeLineEvent({ type: 'message', timestamp: 1700000000000, source: { type: 'user', userId: 'U1' }, message: { id: 'm2', type: 'file', fileName: '契約書.pdf', fileSize: 1234 } });
    expect(file?.attachments[0].filename).toBe('契約書.pdf');
    expect(file?.attachments[0].ref).toEqual({ messageId: 'm2', type: 'file' });
    const img = normalizeLineEvent({ type: 'message', timestamp: 1700000000000, source: { type: 'user', userId: 'U1' }, message: { id: 'm3', type: 'image', contentProvider: { type: 'line' } } });
    expect(img?.attachments[0].filename).toBe('image_m3.jpg');
    expect(normalizeLineEvent({ type: 'follow', timestamp: 1, source: { type: 'user', userId: 'U1' } })).toBeNull();
  });
  it('長文分割', () => {
    const parts = splitLineText('a'.repeat(12000), 5000);
    expect(parts.length).toBe(3);
    expect(parts.every((p) => p.length <= 5000)).toBe(true);
  });
});

describe('Chatwork', () => {
  it('署名検証', () => {
    const body = Buffer.from('{"webhook_event_type":"message_created"}');
    const sig = createHmac('sha256', Buffer.from('chatwork-webhook-secret')).update(body).digest('base64');
    expect(verifyChatworkSignature(body, sig)).toBe(true);
    expect(verifyChatworkSignature(body, sig + 'x')).toBe(false);
  });
  it('記法の除去と添付 ID の抽出', () => {
    const body = '[To:123]山田さん\n[info][title][dtext:file_uploaded][/title][download:456]証拠写真.jpg (1.2MB)[/download][/info]よろしく';
    expect(extractDownloadIds(body)).toEqual([{ fileId: 456, filename: '証拠写真.jpg' }]);
    const stripped = stripChatworkMarkup(body);
    expect(stripped).toContain('よろしく');
    expect(stripped).not.toContain('[download');
  });
  it('自分の発言は out になる', () => {
    const m = normalizeChatworkMessage(10, { message_id: '1', account: { account_id: 99, name: '自分' }, body: 'test', send_time: 1700000000, update_time: 0 }, 99);
    expect(m.direction).toBe('out');
    const m2 = normalizeChatworkMessage(10, { message_id: '2', account: { account_id: 5, name: '依頼者' }, body: 'test', send_time: 1700000000, update_time: 0 }, 99);
    expect(m2.direction).toBe('in');
    expect(m2.identity.chatworkRoomId).toBe(10);
  });
});

describe('Gmail', () => {
  it('アドレス解析', () => {
    expect(parseAddress('山田 太郎 <Yamada@Example.com>')).toEqual({ name: '山田 太郎', email: 'yamada@example.com' });
    expect(parseAddress('plain@example.com')).toEqual({ name: null, email: 'plain@example.com' });
  });
  it('メッセージ正規化（受信・添付）', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    const msg = {
      id: 'g1',
      threadId: 't1',
      labelIds: ['INBOX'],
      internalDate: '1700000000000',
      payload: {
        headers: [
          { name: 'From', value: '依頼者 <client@example.com>' },
          { name: 'To', value: 'me@law.example' },
          { name: 'Subject', value: '資料送付' },
          { name: 'Message-ID', value: '<abc@example.com>' },
        ],
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { data: b64('本文です') } },
          { mimeType: 'application/pdf', filename: '資料.pdf', body: { attachmentId: 'att1', size: 100 } },
        ],
      },
    };
    const n = normalizeGmailMessage(msg, ['me@law.example']);
    expect(n?.direction).toBe('in');
    expect(n?.body).toBe('本文です');
    expect(n?.attachments[0]).toMatchObject({ filename: '資料.pdf', ref: { messageId: 'g1', attachmentId: 'att1' } });
    expect(n?.identity.email).toBe('client@example.com');
    const sent = normalizeGmailMessage({ ...msg, id: 'g2', labelIds: ['SENT'], payload: { ...msg.payload, headers: [{ name: 'From', value: 'me@law.example' }, { name: 'To', value: 'client@example.com' }] } }, ['me@law.example']);
    expect(sent?.direction).toBe('out');
    expect(sent?.identity.email).toBe('client@example.com');
  });
  it('MIME 組立', () => {
    const mime = buildMime({ from: 'me@law.example', to: 'c@example.com', subject: 'テスト', text: 'こんにちは', inReplyTo: '<abc@example.com>', files: [{ filename: 'a.txt', mime: 'text/plain', data: Buffer.from('hi') }] });
    expect(mime).toContain('In-Reply-To: <abc@example.com>');
    expect(mime).toContain('=?UTF-8?B?');
    expect(mime).toContain('multipart/mixed');
    expect(mime).toContain('Content-Disposition: attachment');
  });
});
