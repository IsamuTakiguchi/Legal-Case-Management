import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-inbox-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.STORAGE_BACKEND = 'local';
process.env.LOCAL_CLIENT_ROOT = path.join(tmp, 'clients');
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { setAdapter } = await import('../channels/registry.js');
const { ingestMessage, listConversations, getConversation, setMessageDirection } = await import('../services/inbox.js');
const { processAttachment, assignAttachment } = await import('../services/attachments.js');
const { linkConversationToClient } = await import('../services/identity.js');
const { createTask, checkOverdueWaitingTasks } = await import('../services/tasks.js');
const { openAlerts } = await import('../services/alerts.js');
const { addStyleSample, findSimilarSamples } = await import('../services/style.js');
const { eq } = await import('drizzle-orm');
const { setSetting } = await import('../services/settings.js');

beforeAll(() => {
  openTestDatabase();
  setAdapter('gmail', {
    channel: 'gmail',
    isConfigured: () => true,
    fetchAttachment: async () => Buffer.from('PDFDATA'),
    send: async () => ({ externalId: 'out1', externalThreadId: 't1', sentAt: new Date().toISOString() }),
  });
});
afterAll(() => closeDatabase());

describe('受信→紐付け→添付振り分け', () => {
  it('未紐付けの受信はアラートになり、添付は未振分フォルダへ', async () => {
    const r = await ingestMessage(
      {
        channel: 'gmail',
        externalThreadId: 't1',
        externalId: 'm1',
        direction: 'in',
        sentAt: '2026-09-01T01:00:00.000Z',
        senderName: '山田太郎',
        senderAddress: 'yamada@example.com',
        subject: '資料',
        body: '資料を送ります',
        attachments: [{ filename: '資料.pdf', mime: 'application/pdf', ref: { messageId: 'm1', attachmentId: 'a1' } }],
        identity: { channel: 'gmail', email: 'yamada@example.com', displayName: '山田太郎' },
      },
      { processAttachments: false },
    );
    expect(r.isNew).toBe(true);
    expect(r.conversation.clientId).toBeNull();
    expect(openAlerts('unlinked_contact').length).toBe(1);
    const att = db().select().from(schema.attachments).get()!;
    // 既定（依頼者が分かるものだけ自動保存）では依頼者不明の添付は保存せず「未保存」
    await processAttachment(att.id);
    expect(db().select().from(schema.attachments).where(eq(schema.attachments.id, att.id)).get()!.status).toBe('held');
    expect(openAlerts('unassigned_file').length).toBe(0);
    // 「すべて自動保存」なら _未振分 に保存して要確認に出す
    setSetting('attachment_policy', 'auto');
    await processAttachment(att.id);
    setSetting('attachment_policy', 'client_only');
    const after = db().select().from(schema.attachments).where(eq(schema.attachments.id, att.id)).get()!;
    expect(after.status).toBe('unassigned');
    expect(openAlerts('unassigned_file').length).toBe(1);
    expect(after.storedPath).toContain('_未振分');
    expect(after.storedPath).toContain('20260901_gmail_資料.pdf');
    expect(fs.existsSync(path.join(tmp, 'clients', after.storedPath!))).toBe(true);
  });

  it('依頼者に紐付けると識別子を学習し、添付が依頼者フォルダへ移動', async () => {
    const client = db().insert(schema.clients).values({ name: '山田 太郎', aliases: [], emails: [] }).returning().get();
    const conv = db().select().from(schema.conversations).get()!;
    linkConversationToClient(conv.id, client.id);
    const c2 = db().select().from(schema.clients).where(eq(schema.clients.id, client.id)).get()!;
    expect(c2.emails).toEqual(['yamada@example.com']);
    expect(openAlerts('unlinked_contact').length).toBe(0);
    const att = db().select().from(schema.attachments).get()!;
    await assignAttachment(att.id, client.id);
    const after = db().select().from(schema.attachments).where(eq(schema.attachments.id, att.id)).get()!;
    expect(after.status).toBe('stored');
    expect(after.storedPath).toContain('/山田 太郎/受領資料/');
    expect(openAlerts('unassigned_file').length).toBe(0);
  });

  it('同一送信者の次の受信は自動で紐付き、重複は無視される', async () => {
    const r = await ingestMessage(
      { channel: 'gmail', externalThreadId: 't2', externalId: 'm2', direction: 'in', sentAt: '2026-09-02T01:00:00.000Z', senderAddress: 'yamada@example.com', body: '追加です', attachments: [], identity: { channel: 'gmail', email: 'yamada@example.com' } },
      { processAttachments: false },
    );
    expect(r.conversation.clientId).not.toBeNull();
    const dup = await ingestMessage(
      { channel: 'gmail', externalThreadId: 't2', externalId: 'm2', direction: 'in', sentAt: '2026-09-02T01:00:00.000Z', senderAddress: 'yamada@example.com', body: '追加です', attachments: [], identity: { channel: 'gmail', email: 'yamada@example.com' } },
      { processAttachments: false },
    );
    expect(dup.isNew).toBe(false);
    const list = listConversations({});
    expect(list.length).toBe(2);
    expect(listConversations({ q: '追加です' }).length).toBe(1);
  });

  it('返信待ちタスクは受信で解除され、期限超過はアラートになる', async () => {
    const conv = listConversations({}).find((c) => c.externalThreadId === 't2')!;
    const t = await createTask({ title: '委任状の返送待ち', clientId: conv.clientId, caseId: null, conversationId: conv.id, status: 'waiting_client', followUpAt: '2020-01-01T00:00:00.000Z', note: null, syncToChatwork: false });
    expect(t.status).toBe('waiting_client');
    expect(checkOverdueWaitingTasks()).toBe(1);
    expect(openAlerts('waiting_overdue').length).toBe(1);
    await ingestMessage(
      { channel: 'gmail', externalThreadId: 't2', externalId: 'm3', direction: 'in', sentAt: '2026-09-03T01:00:00.000Z', senderAddress: 'yamada@example.com', body: '委任状を返送しました', attachments: [], identity: { channel: 'gmail', email: 'yamada@example.com' } },
      { processAttachments: false },
    );
    const t2 = db().select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()!;
    expect(t2.status).toBe('open');
    expect(openAlerts('waiting_overdue').length).toBe(0);
    expect(openAlerts('reply_received').length).toBe(1);
  });

  it('会話取得に添付とメッセージが含まれる', () => {
    const conv = listConversations({}).find((c) => c.externalThreadId === 't1')!;
    const full = getConversation(conv.id)!;
    expect(full.messages.length).toBe(1);
    expect(full.messages[0].attachments.length).toBe(1);
    expect(full.client?.name).toBe('山田 太郎');
  });
});

describe('文体サンプル検索（FTS5 trigram）', () => {
  it('日本語の類似検索ができる', () => {
    addStyleSample({ channel: 'gmail', text: '委任状の返送ありがとうございました。内容を確認のうえ、裁判所へ提出いたします。', source: 'import', externalId: 's1' });
    addStyleSample({ channel: 'gmail', text: '期日の結果をご報告いたします。次回は来月の予定です。', source: 'import', externalId: 's2' });
    addStyleSample({ channel: 'line', text: '了解しました。明日連絡します。', source: 'import', externalId: 's3' });
    const hits = findSimilarSamples('委任状を提出', { channel: 'gmail', limit: 2 });
    expect(hits[0].text).toContain('委任状');
  });
});


describe('受信箱の表示範囲（自分の送信で終わった会話）', () => {
  it('相手が最後の会話だけを既定で出し、自分が最後のものは切り替えで見られる', async () => {
    const t = (min: number) => new Date(Date.UTC(2026, 8, 14, 1, min)).toISOString();
    // 相手の連絡で終わっている会話
    await ingestMessage({
      channel: 'gmail', externalThreadId: 'show-them', externalId: 'show-them-1', direction: 'in', sentAt: t(0),
      body: 'ご連絡お待ちしております', senderName: '見せ 太郎', senderAddress: 'show-them@example.com',
      identity: { channel: 'gmail', email: 'show-them@example.com' }, attachments: [],
    });
    // 自分の返信で終わっている会話
    await ingestMessage({
      channel: 'gmail', externalThreadId: 'show-mine', externalId: 'show-mine-1', direction: 'in', sentAt: t(1),
      body: '書面を確認しました', senderName: '見せ 花子', senderAddress: 'show-mine@example.com',
      identity: { channel: 'gmail', email: 'show-mine@example.com' }, attachments: [],
    });
    await ingestMessage({
      channel: 'gmail', externalThreadId: 'show-mine', externalId: 'show-mine-2', direction: 'out', sentAt: t(2),
      body: '承知しました。追ってご連絡します', identity: { channel: 'gmail', email: 'show-mine@example.com' }, attachments: [],
    });
    // 自分の送信だけの会話
    await ingestMessage({
      channel: 'gmail', externalThreadId: 'show-own', externalId: 'show-own-1', direction: 'out', sentAt: t(3),
      body: 'ご案内です', identity: { channel: 'gmail', email: 'show-own@example.com' }, attachments: [],
    });

    const threads = (show: 'unanswered' | 'mine-last' | 'all' | 'own') => listConversations({ show }).map((c) => c.externalThreadId);
    expect(threads('unanswered')).toContain('show-them');
    expect(threads('unanswered')).not.toContain('show-mine');
    expect(threads('unanswered')).not.toContain('show-own');
    expect(threads('mine-last')).toContain('show-mine');
    expect(threads('mine-last')).not.toContain('show-them');
    expect(threads('all')).toEqual(expect.arrayContaining(['show-them', 'show-mine']));
    expect(threads('all')).not.toContain('show-own');
    expect(threads('own')).toContain('show-own');
  });

  it('受信で入ったものを「自分の送信」に直すと、受信箱の既定から外れる', async () => {
    const r = await ingestMessage({
      channel: 'line', externalThreadId: 'U-fix-me', externalId: 'fix-me-1', direction: 'in', sentAt: new Date(Date.UTC(2026, 8, 14, 2, 0)).toISOString(),
      body: '（自分が LINE アプリから送った控え）', identity: { channel: 'line', lineUserId: 'U-fix-me' }, attachments: [],
    });
    expect(listConversations({ show: 'unanswered' }).map((c) => c.externalThreadId)).toContain('U-fix-me');

    setMessageDirection(r.message.id, 'out');
    const conv = getConversation(r.conversation.id)!;
    expect(conv.messages[0]?.direction).toBe('out');
    expect(conv.needsReply).toBe(false);
    expect(listConversations({ show: 'unanswered' }).map((c) => c.externalThreadId)).not.toContain('U-fix-me');
    expect(listConversations({ show: 'own' }).map((c) => c.externalThreadId)).toContain('U-fix-me');
  });
});
