import { eq, desc, and } from 'drizzle-orm';
import path from 'node:path';
import { db, schema } from '../db/index.js';
import { storage } from '../integrations/storage.js';
import { joinPath } from '../integrations/onedrive.js';
import { adapterFor } from '../channels/registry.js';
import { getSetting } from './settings.js';
import { upsertAlert, resolveAlertsByKeyPrefix } from './alerts.js';
import { yyyymmdd, CHANNEL_LABEL, type Channel } from '@lcm/shared';
import { logger } from '../logger.js';

export function clientFolder(client: { name: string; onedriveFolderPath: string | null }): string {
  const root = storage().clientRoot();
  const rel = client.onedriveFolderPath && client.onedriveFolderPath.trim() ? client.onedriveFolderPath : client.name;
  if (rel.startsWith('/')) return rel; // 絶対パス指定
  return joinPath(root, rel);
}

export function unassignedFolder(): string {
  return joinPath(storage().clientRoot(), getSetting('unassigned_folder'));
}

const INVALID = /[\\/:*?"<>|\x00-\x1f]/g;
export function sanitizeFilename(name: string): string {
  return name.replace(INVALID, '_').replace(/\s+/g, ' ').trim() || 'file';
}

export function storedFilename(channel: Channel, sentAt: string, original: string): string {
  return `${yyyymmdd(new Date(sentAt))}_${channel}_${sanitizeFilename(original)}`;
}

/** 添付を取得して依頼者フォルダ（または未振分）に保存 */
export async function processAttachment(attachmentId: number): Promise<void> {
  const d = db();
  const att = d.select().from(schema.attachments).where(eq(schema.attachments.id, attachmentId)).get();
  if (!att || att.status === 'stored') return;
  const msg = d.select().from(schema.messages).where(eq(schema.messages.id, att.messageId)).get();
  if (!msg) return;
  const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, msg.conversationId)).get();
  const client = conv?.clientId ? d.select().from(schema.clients).where(eq(schema.clients.id, conv.clientId)).get() : null;
  try {
    const adapter = adapterFor(msg.channel as Channel);
    const data = await adapter.fetchAttachment({ ref: att.channelRef });
    const filename = storedFilename(msg.channel as Channel, msg.sentAt, att.filename);
    const folder = client ? joinPath(clientFolder(client), getSetting('attachment_subfolder')) : unassignedFolder();
    const stored = await storage().put(folder, filename, data);
    d.update(schema.attachments)
      .set({
        status: client ? 'stored' : 'unassigned',
        storedPath: stored.path,
        driveItemId: stored.itemId ?? null,
        size: stored.size,
        clientId: client?.id ?? null,
        error: null,
      })
      .where(eq(schema.attachments.id, att.id))
      .run();
    if (!client) {
      upsertAlert({
        type: 'unassigned_file',
        dedupeKey: `unassigned_file:${att.id}`,
        title: `振り分け待ちのファイル: ${att.filename}（${CHANNEL_LABEL[msg.channel as Channel]}）`,
        body: `送信者: ${msg.senderName ?? conv?.counterpartName ?? '不明'}`,
        payload: { attachmentId: att.id, conversationId: msg.conversationId },
      });
    }
    logger.info({ attachmentId: att.id, path: stored.path }, '添付を保存しました');
  } catch (err) {
    logger.error({ err, attachmentId }, '添付の取得・保存に失敗');
    d.update(schema.attachments).set({ status: 'failed', error: String(err) }).where(eq(schema.attachments.id, att.id)).run();
  }
}

/** 未振分ファイルを依頼者フォルダへ移動 */
export async function assignAttachment(attachmentId: number, clientId: number): Promise<void> {
  const d = db();
  const att = d.select().from(schema.attachments).where(eq(schema.attachments.id, attachmentId)).get();
  if (!att) throw new Error('添付が見つかりません');
  const client = d.select().from(schema.clients).where(eq(schema.clients.id, clientId)).get();
  if (!client) throw new Error('依頼者が見つかりません');
  const target = joinPath(clientFolder(client), getSetting('attachment_subfolder'));
  if (att.status === 'unassigned' && att.storedPath) {
    const moved = await storage().move({ itemId: att.driveItemId, path: att.storedPath }, target);
    d.update(schema.attachments)
      .set({ status: 'stored', storedPath: moved.path, driveItemId: moved.itemId ?? att.driveItemId, clientId })
      .where(eq(schema.attachments.id, attachmentId))
      .run();
  } else if (att.status === 'failed' || att.status === 'pending') {
    d.update(schema.attachments).set({ clientId }).where(eq(schema.attachments.id, attachmentId)).run();
    await processAttachment(attachmentId);
  } else {
    d.update(schema.attachments).set({ clientId }).where(eq(schema.attachments.id, attachmentId)).run();
  }
  resolveAlertsByKeyPrefix(`unassigned_file:${attachmentId}`);
}

/** 会話を依頼者に紐付けた後、その会話の未振分ファイルをまとめて移動 */
export async function assignConversationAttachments(conversationId: number, clientId: number): Promise<number> {
  const d = db();
  const msgs = d.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).all();
  let n = 0;
  for (const m of msgs) {
    const atts = d.select().from(schema.attachments).where(eq(schema.attachments.messageId, m.id)).all();
    for (const a of atts) {
      if (a.status === 'unassigned' || a.status === 'failed' || a.status === 'pending') {
        await assignAttachment(a.id, clientId).catch((err) => logger.warn({ err, id: a.id }, '添付の移動に失敗'));
        n++;
      }
    }
  }
  return n;
}

export async function retryFailedAttachments(): Promise<number> {
  const rows = db().select().from(schema.attachments).where(eq(schema.attachments.status, 'failed')).all();
  let n = 0;
  for (const r of rows) {
    db().update(schema.attachments).set({ status: 'pending' }).where(eq(schema.attachments.id, r.id)).run();
    await processAttachment(r.id);
    n++;
  }
  return n;
}

export function listAttachments(filter: { status?: string; clientId?: number; limit?: number }) {
  const d = db();
  const conds = [];
  if (filter.status) conds.push(eq(schema.attachments.status, filter.status));
  if (filter.clientId) conds.push(eq(schema.attachments.clientId, filter.clientId));
  const rows = d
    .select({
      attachment: schema.attachments,
      message: {
        id: schema.messages.id,
        conversationId: schema.messages.conversationId,
        channel: schema.messages.channel,
        senderName: schema.messages.senderName,
        sentAt: schema.messages.sentAt,
        body: schema.messages.body,
      },
    })
    .from(schema.attachments)
    .innerJoin(schema.messages, eq(schema.messages.id, schema.attachments.messageId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.attachments.createdAt))
    .limit(filter.limit ?? 200)
    .all();
  return rows.map((r) => ({ ...r.attachment, message: { ...r.message, body: r.message.body.slice(0, 100) } }));
}

/** 期日報告などで送るファイルを依頼者フォルダから取得 */
export async function readClientFile(
  client: { name: string; onedriveFolderPath: string | null },
  file: { itemId?: string | null; path?: string | null; name: string },
): Promise<Buffer> {
  const p = file.path ?? joinPath(clientFolder(client), file.name);
  return storage().get({ itemId: file.itemId ?? undefined, path: p });
}

export function extOf(name: string): string {
  return path.extname(name).toLowerCase();
}
