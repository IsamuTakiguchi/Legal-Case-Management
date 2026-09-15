import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

process.env.LINE_CHANNEL_SECRET = 'line-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'token';
process.env.CHATWORK_WEBHOOK_TOKEN = Buffer.from('chatwork-webhook-secret').toString('base64');
process.env.CHATWORK_API_TOKEN = 'cw-token';
process.env.SESSION_SECRET = 'test-session-secret';

const { verifyLineSignature, normalizeLineEvent, splitLineText, splitLineMessages, pushLineMessages, lineProfileStatus, isLineGroupThread } = await import('../channels/line.js');
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

describe('LINE の送信', () => {
  const orig = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = orig;
  });

  it('1 回に送れる上限を超えた分は、落とした文字数を返す', () => {
    const r = splitLineMessages('a'.repeat(30000), 5000);
    expect(r.chunks).toHaveLength(5);
    expect(r.chunks.every((c) => c.length <= 5000)).toBe(true);
    expect(r.dropped).toBe(5000);
    expect(splitLineMessages('短い本文').dropped).toBe(0);
  });

  it('通信が切れたときは同じ再試行キーで送り直す（LINE 側で重複排除される）', async () => {
    const keys: string[] = [];
    let n = 0;
    globalThis.fetch = (async (_url: string, init: { headers: Record<string, string> }) => {
      keys.push(init.headers['X-Line-Retry-Key']!);
      if (++n === 1) throw new Error('socket hang up');
      return new Response(JSON.stringify({ sentMessages: [{ id: 'm-1' }] }), { status: 200, headers: { 'x-line-request-id': 'req-1' } });
    }) as unknown as typeof fetch;
    const r = await pushLineMessages('U1', [{ type: 'text', text: 'こんにちは' }], 2);
    expect(r).toEqual({ id: 'm-1', requestId: 'req-1' });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('すでに受理済み（409）は送信できたものとして扱う', async () => {
    globalThis.fetch = (async () => new Response('', { status: 409, headers: { 'x-line-request-id': 'req-2' } })) as unknown as typeof fetch;
    const r = await pushLineMessages('U1', [{ type: 'text', text: 'やあ' }], 2);
    expect(r.requestId).toBe('req-2');
  });

  it('月間上限（429）は送り直さずエラーにする', async () => {
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      return new Response(JSON.stringify({ message: 'You have reached your monthly limit.' }), { status: 429 });
    }) as unknown as typeof fetch;
    await expect(pushLineMessages('U1', [{ type: 'text', text: 'やあ' }], 3)).rejects.toThrow(/月間メッセージ上限/);
    expect(n).toBe(1);
  });

  it('プロフィールが 404 ならブロック（届かない相手）と判断する', async () => {
    globalThis.fetch = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    expect(await lineProfileStatus('U1')).toBe('blocked');
    globalThis.fetch = (async () => new Response(JSON.stringify({ displayName: '山田' }), { status: 200 })) as unknown as typeof fetch;
    expect(await lineProfileStatus('U1')).toBe('ok');
    globalThis.fetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    expect(await lineProfileStatus('U1')).toBe('unknown');
  });
});

describe('LINE のグループ', () => {
  it('グループの発言は、発言者ではなくグループの会話として取り込む', () => {
    const ev = {
      type: 'message',
      timestamp: 1700000000000,
      source: { type: 'group', groupId: 'C-group-1', userId: 'U-member-1' },
      message: { id: 'm-g1', type: 'text', text: 'よろしくお願いします' },
    } as const;
    const norm = normalizeLineEvent(ev as never);
    // 会話はグループ、発言者は個人として残す（返信先がグループになる）
    expect(norm?.externalThreadId).toBe('C-group-1');
    expect(norm?.senderAddress).toBe('U-member-1');
    expect(isLineGroupThread('C-group-1')).toBe(true);
    expect(isLineGroupThread('R-room-1')).toBe(true);
    expect(isLineGroupThread('U-user-1')).toBe(false);
  });

  it('複数人トークも同じくトークルームの会話にする', () => {
    const norm = normalizeLineEvent({
      type: 'message',
      timestamp: 1700000000000,
      source: { type: 'room', roomId: 'R-room-1', userId: 'U-member-2' },
      message: { id: 'm-r1', type: 'text', text: 'こんばんは' },
    } as never);
    expect(norm?.externalThreadId).toBe('R-room-1');
  });

  it('1 対 1 はこれまでどおり個人の会話', () => {
    const norm = normalizeLineEvent({
      type: 'message',
      timestamp: 1700000000000,
      source: { type: 'user', userId: 'U-alone' },
      message: { id: 'm-u1', type: 'text', text: 'こんにちは' },
    } as never);
    expect(norm?.externalThreadId).toBe('U-alone');
  });
});
