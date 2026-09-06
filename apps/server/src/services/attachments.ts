import { eq, desc, and } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { dataDir } from '../config.js';
import { db, schema } from '../db/index.js';
import { storage } from '../integrations/storage.js';
import { joinPath } from '../integrations/onedrive.js';
import { adapterFor } from '../channels/registry.js';
import { getSetting } from './settings.js';
import { upsertAlert, resolveAlertsByKeyPrefix } from './alerts.js';
import { yyyymmdd, CHANNEL_LABEL, type Channel } from '@lcm/shared';
import { logger } from '../logger.js';
import { defaultClientFolderRel } from './clientFolders.js';

export function clientFolder(client: { id?: number; name: string; onedriveFolderPath: string | null }): string {
  const root = storage().clientRoot();
  const rel = client.onedriveFolderPath && client.onedriveFolderPath.trim() ? client.onedriveFolderPath : defaultClientFolderRel(client);
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

/**
 * 受信ファイルの扱い（設定 attachment_policy）
 *   auto        依頼者が分かれば自動保存。不明なものは _未振分 に保存して要確認に出す
 *   client_only 依頼者が分かれば自動保存。不明なものは保存せず「未保存」として置く（既定）
 *   manual      すべて「未保存」。会話画面や受信ファイル画面から保存するものだけ保存
 */
export type AttachmentPolicy = 'auto' | 'client_only' | 'manual';
export function attachmentPolicy(): AttachmentPolicy {
  const v = getSetting('attachment_policy');
  return v === 'auto' || v === 'manual' ? v : 'client_only';
}

// ---- 受信時の一時取り込み（LINE はコンテンツの保持期間が短いので、未保存でもアプリ内に控えを置く） ----

/** 受信時にアプリ内へ控えを取っておくチャネル */
const STAGE_CHANNELS: Channel[] = ['line'];

function stageDir(): string {
  return path.join(dataDir(), 'attachments');
}

function stagedFileOf(att: { id: number; channelRef: Record<string, unknown> }): string | null {
  const name = (att.channelRef as { stagedFile?: string }).stagedFile;
  if (!name) return null;
  const p = path.join(stageDir(), name);
  return fs.existsSync(p) ? p : null;
}

function removeStaged(att: { id: number; channelRef: Record<string, unknown> }) {
  const p = stagedFileOf(att);
  if (!p) return;
  try {
    fs.unlinkSync(p);
  } catch (err) {
    logger.warn({ err, attachmentId: att.id }, '控えファイルの削除に失敗');
  }
  const ref = { ...(att.channelRef as Record<string, unknown>) };
  delete ref.stagedFile;
  db().update(schema.attachments).set({ channelRef: ref }).where(eq(schema.attachments.id, att.id)).run();
}

/** チャネルから取得して DATA_DIR/attachments に控えを置く。既にあればそのまま */
async function stageAttachment(att: { id: number; channelRef: Record<string, unknown>; filename: string }, channel: Channel): Promise<void> {
  if (stagedFileOf(att)) return;
  const data = await adapterFor(channel).fetchAttachment({ ref: att.channelRef });
  fs.mkdirSync(stageDir(), { recursive: true });
  const name = `${att.id}${path.extname(att.filename).toLowerCase()}`;
  fs.writeFileSync(path.join(stageDir(), name), data);
  db()
    .update(schema.attachments)
    .set({ channelRef: { ...att.channelRef, stagedFile: name }, size: data.length })
    .where(eq(schema.attachments.id, att.id))
    .run();
}

/** 添付の中身を取得（控えがあれば控えから、なければチャネルから） */
async function attachmentBytes(att: { id: number; channelRef: Record<string, unknown> }, channel: Channel): Promise<Buffer> {
  const staged = stagedFileOf(att);
  if (staged) return fs.readFileSync(staged);
  return adapterFor(channel).fetchAttachment({ ref: att.channelRef });
}

/** 添付を取得して依頼者フォルダ（または未振分）に保存。force=true なら設定に関わらず保存する */
export async function processAttachment(attachmentId: number, opts: { force?: boolean } = {}): Promise<void> {
  const d = db();
  const att = d.select().from(schema.attachments).where(eq(schema.attachments.id, attachmentId)).get();
  if (!att || att.status === 'stored' || att.status === 'ignored') return;
  const msg = d.select().from(schema.messages).where(eq(schema.messages.id, att.messageId)).get();
  if (!msg) return;
  const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, msg.conversationId)).get();
  const clientId = att.clientId ?? conv?.clientId ?? null;
  const client = clientId ? d.select().from(schema.clients).where(eq(schema.clients.id, clientId)).get() : null;
  if (!opts.force) {
    const policy = attachmentPolicy();
    if (policy === 'manual' || (policy === 'client_only' && !client)) {
      let error: string | null = null;
      if (STAGE_CHANNELS.includes(msg.channel as Channel)) {
        try {
          await stageAttachment(att, msg.channel as Channel);
        } catch (err) {
          logger.warn({ err, attachmentId: att.id }, '受信ファイルの控えの取得に失敗');
          error = `受信時の取り込みに失敗: ${String((err as Error).message ?? err)}`;
        }
      }
      d.update(schema.attachments).set({ status: 'held', clientId: client?.id ?? null, error }).where(eq(schema.attachments.id, att.id)).run();
      return;
    }
  }
  try {
    const data = await attachmentBytes(att, msg.channel as Channel);
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
    removeStaged(att);
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
  } else if (att.status === 'failed' || att.status === 'pending' || att.status === 'held') {
    d.update(schema.attachments).set({ clientId }).where(eq(schema.attachments.id, attachmentId)).run();
    await processAttachment(attachmentId, { force: true });
  } else {
    d.update(schema.attachments).set({ clientId }).where(eq(schema.attachments.id, attachmentId)).run();
  }
  resolveAlertsByKeyPrefix(`unassigned_file:${attachmentId}`);
}

/** 未保存の添付を保存する（依頼者を指定しなければ会話の依頼者へ） */
export async function saveAttachment(attachmentId: number, clientId?: number | null): Promise<void> {
  const d = db();
  const att = d.select().from(schema.attachments).where(eq(schema.attachments.id, attachmentId)).get();
  if (!att) throw new Error('添付が見つかりません');
  if (clientId) return assignAttachment(attachmentId, clientId);
  if (att.status === 'stored') return;
  d.update(schema.attachments).set({ status: 'pending' }).where(eq(schema.attachments.id, attachmentId)).run();
  await processAttachment(attachmentId, { force: true });
  const after = d.select().from(schema.attachments).where(eq(schema.attachments.id, attachmentId)).get();
  if (after?.status === 'failed') throw new Error(after.error ?? '保存に失敗しました');
}

/** 保存不要にする。_未振分 に置いてあったものは削除する */
export async function ignoreAttachment(attachmentId: number): Promise<void> {
  const d = db();
  const att = d.select().from(schema.attachments).where(eq(schema.attachments.id, attachmentId)).get();
  if (!att) throw new Error('添付が見つかりません');
  if (att.status === 'unassigned' && att.storedPath) {
    await storage()
      .remove({ itemId: att.driveItemId, path: att.storedPath })
      .catch((err) => logger.warn({ err, id: attachmentId }, '未振分ファイルの削除に失敗'));
  }
  removeStaged(att);
  d.update(schema.attachments).set({ status: 'ignored', storedPath: null, driveItemId: null, error: null }).where(eq(schema.attachments.id, attachmentId)).run();
  resolveAlertsByKeyPrefix(`unassigned_file:${attachmentId}`);
}

/** 保存前の添付をチャネルから直接取得する（未保存のまま中身を見る・ダウンロードする用） */
export async function fetchAttachmentData(attachmentId: number): Promise<{ data: Buffer; filename: string; mime: string | null }> {
  const d = db();
  const att = d.select().from(schema.attachments).where(eq(schema.attachments.id, attachmentId)).get();
  if (!att) throw new Error('添付が見つかりません');
  if (att.storedPath) return { data: await storage().get({ itemId: att.driveItemId, path: att.storedPath }), filename: att.filename, mime: att.mime };
  const msg = d.select().from(schema.messages).where(eq(schema.messages.id, att.messageId)).get();
  if (!msg) throw new Error('メッセージが見つかりません');
  const data = await attachmentBytes(att, msg.channel as Channel);
  return { data, filename: att.filename, mime: att.mime };
}

/** 会話を依頼者に紐付けた後、その会話の未振分ファイルをまとめて移動 */
export async function assignConversationAttachments(conversationId: number, clientId: number): Promise<number> {
  const d = db();
  const msgs = d.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).all();
  let n = 0;
  for (const m of msgs) {
    const atts = d.select().from(schema.attachments).where(eq(schema.attachments.messageId, m.id)).all();
    for (const a of atts) {
      if (a.status === 'unassigned' || a.status === 'failed' || a.status === 'pending' || (a.status === 'held' && attachmentPolicy() !== 'manual')) {
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

export function listAttachments(filter: { status?: string; clientId?: number; channel?: string; limit?: number }) {
  const d = db();
  const conds = [];
  if (filter.status) conds.push(eq(schema.attachments.status, filter.status));
  if (filter.channel) conds.push(eq(schema.messages.channel, filter.channel));
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
