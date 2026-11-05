import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { normalizePhones, looksLikeCorporation, type ClientInput } from '@lcm/shared';
import { adoptClientFolderPath } from './clientFolders.js';
import { linkLineFriendToClient, assertLineFriendFree } from './lineFriends.js';
import { logger } from '../logger.js';

/**
 * 依頼者の登録・変更（依頼者の画面と AI 秘書で共通）。
 */

/** メールアドレスは前後の空白を落とし、小文字にして重複を除く（同じ相手を 2 度登録しないため） */
export function normalizeEmails(emails: string[]): string[] {
  return [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
}

export function createClientRecord(input: ClientInput) {
  if (input.lineUserId) assertLineFriendFree(input.lineUserId, null);
  // 個人・法人を選ばずに登録したら、名前から推定する（「株式会社」などが付けば法人）
  const entityType = input.entityType ?? (looksLikeCorporation(input.name) ? 'corporation' : 'individual');
  const row = db().insert(schema.clients).values({ ...input, entityType, emails: normalizeEmails(input.emails), phones: normalizePhones(input.phones) }).returning().get();
  // LINE の友だちを選んで登録したら、既存の会話を付け、友だち追加の通知を消す
  if (input.lineUserId) linkLineFriendToClient(input.lineUserId, row.id);
  return db().select().from(schema.clients).where(eq(schema.clients.id, row.id)).get()!;
}

/** 送られてきた項目だけを書き換える（送られていない一覧を空で上書きしない） */
export async function updateClientRecord(id: number, input: Partial<ClientInput>) {
  if (input.lineUserId) assertLineFriendFree(input.lineUserId, id);
  const before = db().select({ path: schema.clients.onedriveFolderPath, name: schema.clients.name, provisional: schema.clients.provisional }).from(schema.clients).where(eq(schema.clients.id, id)).get();
  if (!before) throw new Error('依頼者が見つかりません');
  // 氏名未確認の依頼者の名前を直したら、氏名が分かったものとして扱う（明示の指定があればそちら）
  if (before.provisional && input.name !== undefined && input.name.trim() !== before.name && input.provisional === undefined) input.provisional = false;
  db().update(schema.clients)
    .set({ ...input, ...(input.emails ? { emails: normalizeEmails(input.emails) } : {}), ...(input.phones ? { phones: normalizePhones(input.phones) } : {}), updatedAt: new Date().toISOString() })
    .where(eq(schema.clients.id, id))
    .run();
  if (input.lineUserId) linkLineFriendToClient(input.lineUserId, id);
  // 依頼者フォルダを指定し直したら、前のフォルダの ID を忘れて新しいフォルダを追う（前のフォルダに戻されないように）
  if ('onedriveFolderPath' in input && (input.onedriveFolderPath?.trim() ?? '') !== (before.path?.trim() ?? '')) {
    await adoptClientFolderPath(id).catch((err) => logger.warn({ err, clientId: id }, '依頼者フォルダの ID を控えられませんでした'));
  }
  return db().select().from(schema.clients).where(eq(schema.clients.id, id)).get()!;
}
