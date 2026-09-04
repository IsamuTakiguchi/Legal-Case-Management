import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { adapterFor } from '../channels/registry.js';
import { CHATWORK_FILE_LIMIT } from '../channels/chatwork.js';
import { storage } from '../integrations/storage.js';
import { readClientFile } from './attachments.js';
import { learnFromSent } from './style.js';
import { ingestMessage } from './inbox.js';
import { getSetting, getSettingInt } from './settings.js';
import { assertLineQuota, recordLinePush } from './lineQuota.js';
import { createTask } from './tasks.js';
import type { Channel, SendMessageInput } from '@lcm/shared';
import type { OutboundFile } from '../channels/types.js';
import { logger } from '../logger.js';

const GMAIL_ATTACH_LIMIT = 20 * 1024 * 1024;

export interface SendOutcome {
  messageId: number;
  note?: string;
  links: { name: string; url: string }[];
  manualFiles: string[];
}

/**
 * 会話へ返信を送信する共通処理。
 * - ファイルはチャネル制約に応じて添付／共有リンク／手動送付案内に振り分ける
 * - 送信文を会話に保存し、文体サンプルとして学習する
 */
export async function sendToConversation(conversationId: number, input: SendMessageInput): Promise<SendOutcome> {
  const d = db();
  const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get();
  if (!conv) throw new Error('会話が見つかりません');
  const channel = conv.channel as Channel;
  const adapter = adapterFor(channel);
  if (!adapter.isConfigured()) throw new Error(`${channel} が未設定です`);
  const client = conv.clientId ? d.select().from(schema.clients).where(eq(schema.clients.id, conv.clientId)).get() : null;

  // ファイルの収集
  const files: OutboundFile[] = [];
  for (const id of input.attachmentIds) {
    const a = d.select().from(schema.attachments).where(eq(schema.attachments.id, id)).get();
    if (!a || !a.storedPath) continue;
    const data = await storage().get({ itemId: a.driveItemId, path: a.storedPath });
    files.push({ filename: a.filename, mime: a.mime, data });
  }
  for (const f of input.driveFiles) {
    if (!client) throw new Error('依頼者が未紐付けのためフォルダのファイルを送れません');
    const data = await readClientFile(client, { itemId: f.itemId, path: f.path ?? null, name: f.name });
    files.push({ filename: f.name, data, mime: null });
  }

  const limit = channel === 'chatwork' ? CHATWORK_FILE_LIMIT : channel === 'gmail' ? GMAIL_ATTACH_LIMIT : 0;
  const direct: OutboundFile[] = [];
  const links: { name: string; url: string }[] = [];
  const manualFiles: string[] = [];
  for (const f of files) {
    if (limit > 0 && f.data.length <= limit) {
      direct.push(f);
      continue;
    }
    const link = await tryShareLink(f, input, client ?? null);
    if (link) links.push({ name: f.filename, url: link });
    else manualFiles.push(f.filename);
  }

  let text = input.text;
  if (manualFiles.length) text += `\n\n${getSetting('line_manual_send_note')}（${manualFiles.join('、')}）`;

  if (channel === 'line') assertLineQuota();

  const reply = (() => {
    const lastIn = d.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).orderBy(schema.messages.sentAt).all().at(-1);
    const raw = (lastIn?.raw ?? {}) as { messageId?: string; references?: string };
    return { messageId: raw.messageId ?? null, references: raw.references ?? null, subject: conv.subject ?? null };
  })();

  const result = await adapter.send({
    externalThreadId: conv.externalThreadId,
    to: channel === 'gmail' ? conv.counterpartAddress : null,
    subject: conv.subject,
    text,
    files: direct,
    fileLinks: links,
    inReplyTo: reply,
  });
  if (channel === 'line') recordLinePush(1);

  const { message } = await ingestMessage(
    {
      channel,
      externalThreadId: result.externalThreadId,
      externalId: result.externalId,
      direction: 'out',
      sentAt: result.sentAt,
      senderName: getSetting('lawyer_name') || '自分',
      subject: conv.subject,
      body: text,
      attachments: [],
      identity: { channel, email: conv.counterpartAddress, lineUserId: channel === 'line' ? conv.externalThreadId : null, chatworkRoomId: channel === 'chatwork' ? Number(conv.externalThreadId) : null },
    },
    { processAttachments: false },
  );

  // 下書きの状態更新と学習
  let generated: string | null = null;
  if (input.draftId) {
    const draft = d.select().from(schema.drafts).where(eq(schema.drafts.id, input.draftId)).get();
    if (draft) {
      generated = draft.generatedText;
      d.update(schema.drafts).set({ finalText: input.text, status: 'sent' }).where(eq(schema.drafts.id, draft.id)).run();
    }
  }
  const lastInbound = d.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).orderBy(schema.messages.sentAt).all().filter((m) => m.direction === 'in').at(-1);
  learnFromSent(channel, input.text, generated, { externalId: result.externalId, clientId: conv.clientId, contextText: lastInbound?.body.slice(0, 500) ?? null });

  d.update(schema.messages).set({ draftId: input.draftId ?? null }).where(eq(schema.messages.id, message.id)).run();

  if (input.createWaitingTask) {
    await createTask({
      title: `${client?.name ?? conv.counterpartName ?? '相手'}からの返信待ち: ${input.text.split('\n').find((l) => l.trim())?.slice(0, 40) ?? ''}`,
      clientId: conv.clientId ?? null,
      caseId: null,
      conversationId,
      status: 'waiting_client',
      followUpAt: null,
      note: null,
      syncToChatwork: false,
    });
  }
  logger.info({ conversationId, channel, files: direct.length, links: links.length }, '送信しました');
  return { messageId: message.id, note: result.note, links, manualFiles };
}

async function tryShareLink(f: OutboundFile, input: SendMessageInput, client: { name: string; onedriveFolderPath: string | null } | null): Promise<string | null> {
  const st = storage();
  if (!st.shareLink) return null;
  const days = getSettingInt('share_link_expiry_days', 30);
  const expires = new Date(Date.now() + days * 86400_000);
  // 既存の保存済みファイルなら item を再利用、それ以外は依頼者フォルダの送付用サブフォルダに置いてからリンク化
  const att = input.attachmentIds
    .map((id) => db().select().from(schema.attachments).where(eq(schema.attachments.id, id)).get())
    .find((a) => a && a.filename === f.filename);
  try {
    if (att?.storedPath) return await st.shareLink({ itemId: att.driveItemId, path: att.storedPath }, expires);
    const df = input.driveFiles.find((x) => x.name === f.filename);
    if (df) return await st.shareLink({ itemId: df.itemId, path: df.path ?? '' }, expires);
    if (client) {
      const { clientFolder } = await import('./attachments.js');
      const folder = `${clientFolder(client)}/送付ファイル`;
      const stored = await st.put(folder, f.filename, f.data);
      return await st.shareLink({ itemId: stored.itemId, path: stored.path }, expires);
    }
  } catch (err) {
    logger.warn({ err, file: f.filename }, '共有リンクの発行に失敗');
  }
  return null;
}
