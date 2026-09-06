/** 依頼者の一括登録: OneDrive の依頼者フォルダ名／Chatwork ルームから候補を作る */
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { storage } from '../integrations/storage.js';
import * as cw from '../channels/chatwork.js';
import { isConfigured } from '../config.js';
import { joinPath } from '../integrations/onedrive.js';
import { clientFolderParents, statusFolderMap } from './clientFolders.js';
import { CASE_STATUS_LABEL, type CaseStatus } from '@lcm/shared';

export interface ImportCandidate {
  source: 'onedrive' | 'chatwork';
  name: string;
  folderPath?: string;
  chatworkRoomId?: number;
  existingClientId?: number | null;
  note?: string;
}

const SKIP_FOLDERS = /^(_|\.|書式|テンプレ|事務所|その他|旧|過去|archive)/i;

/** 「山田太郎_離婚」「山田 太郎（相続）」などのフォルダ名から氏名らしい部分を取り出す */
export function guessNameFromFolder(folder: string): string {
  let n = folder.trim();
  n = n.replace(/^\d{4,8}[_\-\s]?/, ''); // 先頭の日付・番号
  n = n.replace(/[（(【\[].*?[）)】\]]/g, ' '); // 括弧内
  n = n.split(/[_＿\-－／/]/)[0];
  n = n.replace(/(様|さん|殿|氏)$/, '');
  return n.trim() || folder;
}

export async function onedriveCandidates(): Promise<ImportCandidate[]> {
  const root = storage().clientRoot();
  const clients = db().select().from(schema.clients).all();
  const out: ImportCandidate[] = [];
  const parents = clientFolderParents();
  const statusByParent = new Map<string, string>();
  for (const [status, folder] of Object.entries(statusFolderMap())) if (folder) statusByParent.set(folder, CASE_STATUS_LABEL[status as CaseStatus]);
  for (const parent of parents) {
    const items = await storage().list(parent ? joinPath(root, parent) : root).catch(() => []);
    for (const i of items) {
      if (!i.isFolder || SKIP_FOLDERS.test(i.name)) continue;
      if (!parent && parents.length === 1 && [...statusByParent.keys()].includes(i.name)) continue;
      const name = guessNameFromFolder(i.name);
      const folderPath = parent ? `${parent}/${i.name}` : i.name;
      const existing = clients.find((c) => c.onedriveFolderPath === folderPath || c.onedriveFolderPath === i.name || c.name.replace(/[\s　]/g, '') === name.replace(/[\s　]/g, ''));
      const label = statusByParent.get(parent) ?? (parent || null);
      out.push({ source: 'onedrive', name, folderPath, existingClientId: existing?.id ?? null, note: [label, i.modifiedAt ? `更新 ${i.modifiedAt.slice(0, 10)}` : null].filter(Boolean).join(' / ') || undefined });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

export async function chatworkCandidates(): Promise<ImportCandidate[]> {
  if (!isConfigured('chatwork')) return [];
  const rooms = await cw.listRooms();
  const clients = db().select().from(schema.clients).all();
  const out: ImportCandidate[] = [];
  for (const r of rooms) {
    if (r.type === 'my') continue;
    const name = guessNameFromFolder(r.name);
    const existing = clients.find((c) => c.chatworkRoomId === r.room_id || c.name.replace(/[\s　]/g, '') === name.replace(/[\s　]/g, ''));
    out.push({ source: 'chatwork', name, chatworkRoomId: r.room_id, existingClientId: existing?.id ?? null, note: `${r.type === 'direct' ? 'ダイレクト' : 'グループ'}: ${r.name}` });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

export function applyImport(rows: { name: string; folderPath?: string | null; chatworkRoomId?: number | null; existingClientId?: number | null }[]): { created: number; updated: number } {
  let created = 0;
  let updated = 0;
  const now = new Date().toISOString();
  for (const r of rows) {
    if (!r.name.trim()) continue;
    if (r.existingClientId) {
      const patch: Partial<typeof schema.clients.$inferInsert> = { updatedAt: now };
      if (r.folderPath) patch.onedriveFolderPath = r.folderPath;
      if (r.chatworkRoomId) patch.chatworkRoomId = r.chatworkRoomId;
      db().update(schema.clients).set(patch).where(eq(schema.clients.id, r.existingClientId)).run();
      updated++;
    } else {
      db()
        .insert(schema.clients)
        .values({ name: r.name.trim(), aliases: [], emails: [], onedriveFolderPath: r.folderPath ?? null, chatworkRoomId: r.chatworkRoomId ?? null, preferredChannel: r.chatworkRoomId ? 'chatwork' : null })
        .run();
      created++;
    }
  }
  return { created, updated };
}
