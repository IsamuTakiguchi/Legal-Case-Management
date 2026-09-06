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
  /** 区分フォルダから推定した事件の区分（事件を同時に作る） */
  caseStatus?: CaseStatus | null;
  /** 事件名の候補（フォルダ名） */
  caseTitle?: string | null;
  /** フォルダ名から推定した事件類型 */
  caseType?: string | null;
}

/** フォルダ名から事件類型を推定する */
export function guessCaseType(name: string): string {
  const rules: [RegExp, string][] = [
    [/離婚|男女|婚姻|親権|養育費|不貞/, 'divorce'],
    [/相続|遺産|遺言|遺留分/, 'inheritance'],
    [/法人破産|会社.*破産|破産.*会社|株式会社.*破産|有限会社.*破産/, 'bankruptcy_corp'],
    [/再生|事業再生|民事再生/, 'rehabilitation'],
    [/破産|債務|任意整理|過払|借金|自己破産/, 'debt_personal'],
    [/交通事故|交通|物損|人身/, 'traffic'],
    [/労働|解雇|残業|未払賃金|労災|ハラスメント/, 'labor'],
    [/刑事|被疑|被告人|弁護人|示談|保釈/, 'criminal'],
    [/顧問|企業|会社法|株主|契約書|コンプライアンス/, 'corporate'],
  ];
  for (const [re, t] of rules) if (re.test(name)) return t;
  return 'general_civil';
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
  const statusByParent = new Map<string, CaseStatus>();
  for (const [status, folder] of Object.entries(statusFolderMap())) if (folder) statusByParent.set(folder, status as CaseStatus);
  for (const parent of parents) {
    const items = await storage().list(parent ? joinPath(root, parent) : root).catch(() => []);
    for (const i of items) {
      if (!i.isFolder || SKIP_FOLDERS.test(i.name)) continue;
      if (!parent && parents.length === 1 && [...statusByParent.keys()].includes(i.name)) continue;
      const name = guessNameFromFolder(i.name);
      const folderPath = parent ? `${parent}/${i.name}` : i.name;
      const existing = clients.find((c) => c.onedriveFolderPath === folderPath || c.onedriveFolderPath === i.name || c.name.replace(/[\s　]/g, '') === name.replace(/[\s　]/g, ''));
      const status = statusByParent.get(parent) ?? null;
      // 区分外フォルダ（顧問等）は「進行事件・企業法務」として事件を作る
      const isAdvisory = !status && /顧問/.test(parent);
      const caseStatus: CaseStatus | null = status ?? (isAdvisory ? 'active' : null);
      const caseType = isAdvisory ? 'corporate' : guessCaseType(i.name);
      const label = status ? CASE_STATUS_LABEL[status] : parent || null;
      out.push({
        source: 'onedrive',
        name,
        folderPath,
        existingClientId: existing?.id ?? null,
        note: [label, i.modifiedAt ? `更新 ${i.modifiedAt.slice(0, 10)}` : null].filter(Boolean).join(' / ') || undefined,
        caseStatus,
        caseTitle: caseStatus ? i.name : null,
        caseType: caseStatus ? caseType : null,
      });
    }
  }
  return out.sort((a, b) => (a.caseStatus ?? 'z').localeCompare(b.caseStatus ?? 'z') || a.name.localeCompare(b.name, 'ja'));
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

export function applyImport(
  rows: { name: string; folderPath?: string | null; chatworkRoomId?: number | null; existingClientId?: number | null; caseStatus?: CaseStatus | null; caseTitle?: string | null; caseType?: string | null }[],
): { created: number; updated: number; casesCreated: number } {
  let created = 0;
  let updated = 0;
  let casesCreated = 0;
  const now = new Date().toISOString();
  for (const r of rows) {
    if (!r.name.trim()) continue;
    let clientId: number;
    if (r.existingClientId) {
      const patch: Partial<typeof schema.clients.$inferInsert> = { updatedAt: now };
      if (r.folderPath) patch.onedriveFolderPath = r.folderPath;
      if (r.chatworkRoomId) patch.chatworkRoomId = r.chatworkRoomId;
      db().update(schema.clients).set(patch).where(eq(schema.clients.id, r.existingClientId)).run();
      clientId = r.existingClientId;
      updated++;
    } else {
      const row = db()
        .insert(schema.clients)
        .values({ name: r.name.trim(), aliases: [], emails: [], onedriveFolderPath: r.folderPath ?? null, chatworkRoomId: r.chatworkRoomId ?? null, preferredChannel: r.chatworkRoomId ? 'chatwork' : null })
        .returning()
        .get();
      clientId = row.id;
      created++;
    }
    // 区分フォルダから来た候補は、事件がまだ無ければ事件も作る
    if (r.caseStatus) {
      const hasCase = db().select({ id: schema.cases.id }).from(schema.cases).where(eq(schema.cases.clientId, clientId)).get();
      if (!hasCase) {
        const title = (r.caseTitle ?? '').trim() || `${r.name.trim()} の事件`;
        db().insert(schema.cases).values({ clientId, title, status: r.caseStatus, caseType: r.caseType ?? guessCaseType(title) }).run();
        casesCreated++;
      }
    }
  }
  return { created, updated, casesCreated };
}

/** 依頼者を削除する（事件・ノート・タスク・債権者も削除。会話と添付は紐付けを外す） */
export function deleteClient(id: number): boolean {
  const d = db();
  const exists = d.select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.id, id)).get();
  if (!exists) return false;
  d.transaction(() => {
    const cases = d.select({ id: schema.cases.id }).from(schema.cases).where(eq(schema.cases.clientId, id)).all();
    for (const k of cases) {
      const creditors = d.select({ id: schema.creditors.id }).from(schema.creditors).where(eq(schema.creditors.caseId, k.id)).all();
      for (const cr of creditors) d.delete(schema.creditorEvents).where(eq(schema.creditorEvents.creditorId, cr.id)).run();
      d.delete(schema.creditors).where(eq(schema.creditors.caseId, k.id)).run();
      d.delete(schema.caseNotes).where(eq(schema.caseNotes.caseId, k.id)).run();
      d.update(schema.calendarEvents).set({ caseId: null }).where(eq(schema.calendarEvents.caseId, k.id)).run();
      d.delete(schema.tasks).where(eq(schema.tasks.caseId, k.id)).run();
    }
    d.delete(schema.cases).where(eq(schema.cases.clientId, id)).run();
    d.delete(schema.tasks).where(eq(schema.tasks.clientId, id)).run();
    d.delete(schema.caseNotes).where(eq(schema.caseNotes.clientId, id)).run();
    d.update(schema.conversations).set({ clientId: null }).where(eq(schema.conversations.clientId, id)).run();
    d.update(schema.attachments).set({ clientId: null }).where(eq(schema.attachments.clientId, id)).run();
    d.update(schema.calendarEvents).set({ clientId: null }).where(eq(schema.calendarEvents.clientId, id)).run();
    d.update(schema.schedulingSessions).set({ clientId: null }).where(eq(schema.schedulingSessions.clientId, id)).run();
    d.update(schema.styleSamples).set({ clientId: null }).where(eq(schema.styleSamples.clientId, id)).run();
    d.update(schema.formTemplates).set({ clientId: null }).where(eq(schema.formTemplates.clientId, id)).run();
    d.delete(schema.clients).where(eq(schema.clients.id, id)).run();
  });
  return true;
}
