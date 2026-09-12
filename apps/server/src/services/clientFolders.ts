import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { storage } from '../integrations/storage.js';
import { isMsConnected, moveItem, getItem, getItemByPath, joinPath } from '../integrations/onedrive.js';
import { getSetting, setSetting } from './settings.js';
import { logger } from '../logger.js';
import { CASE_STATUSES, CASE_STATUS_LABEL, type CaseStatus } from '@lcm/shared';
import { parseFolderName, detectFolderNameFormat, isTightKanaFormat } from './clientImport.js';

/**
 * 依頼者フォルダの区分レイアウト。
 * 依頼者ルートの直下に「0.相談 / 1.進行事件 / 2.残務処理 / 3.終了事件」のような区分フォルダがあり、
 * その中に依頼者ごとのフォルダが並ぶ運用に対応する。区分未設定なら従来どおりルート直下が依頼者フォルダ。
 */
export type StatusFolderMap = Partial<Record<CaseStatus, string>>;

const STATUS_RANK: Record<CaseStatus, number> = { active: 0, wrapup: 1, consultation: 2, closed: 3 };

export function statusFolderMap(): StatusFolderMap {
  try {
    const raw = getSetting('client_status_folders');
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    const out: StatusFolderMap = {};
    for (const s of CASE_STATUSES) if (parsed[s]) out[s] = parsed[s].replace(/^\/+|\/+$/g, '');
    return out;
  } catch {
    return {};
  }
}

export function saveStatusFolderMap(map: StatusFolderMap, extras: string[]) {
  setSetting('client_status_folders', Object.keys(map).length ? JSON.stringify(map) : '');
  setSetting('client_extra_folders', extras.map((s) => s.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('\n'));
}

/** 区分に対応しないが依頼者フォルダを含むフォルダ（例: 4.その他（顧問等）） */
export function extraClientFolders(): string[] {
  return getSetting('client_extra_folders')
    .split(/\r?\n/)
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
}

export function hasStatusLayout(): boolean {
  return Object.keys(statusFolderMap()).length > 0;
}

/** 依頼者フォルダを探す親フォルダ（ルートからの相対）。フラット運用なら [''] */
export function clientFolderParents(): string[] {
  const map = statusFolderMap();
  const parents = [...new Set([...Object.values(map).filter((v): v is string => !!v), ...extraClientFolders()])];
  return parents.length ? parents : [''];
}

/** フォルダ名から区分を推定する（0.相談 → consultation など） */
export function guessStatusFolders(names: string[]): { map: StatusFolderMap; extras: string[] } {
  const rules: [CaseStatus, RegExp][] = [
    ['consultation', /相談/],
    ['active', /進行|係属|受任中/],
    ['wrapup', /残務|清算|精算|残処理/],
    ['closed', /終了|完了|既済|過去/],
  ];
  const map: StatusFolderMap = {};
  const extras: string[] = [];
  for (const n of names) {
    const hit = rules.find(([s, re]) => re.test(n) && !map[s]);
    if (hit) map[hit[0]] = n;
    else extras.push(n);
  }
  return { map, extras };
}

/** 依頼者の実効区分: 進行事件 > 残務処理 > 相談 > 終了事件。事件が無ければ相談 */
export function clientEffectiveStatus(clientId: number): CaseStatus {
  const cases = db().select({ status: schema.cases.status }).from(schema.cases).where(eq(schema.cases.clientId, clientId)).all();
  if (cases.length === 0) return 'consultation';
  return cases.map((c) => c.status as CaseStatus).sort((a, b) => (STATUS_RANK[a] ?? 9) - (STATUS_RANK[b] ?? 9))[0] ?? 'consultation';
}

/**
 * 新規フォルダの名前。設定 client_folder_name_format（例: "{kana} {name}"）に従い、
 * {kana} は読み（kana）の先頭 1 文字。読みが無ければ氏名だけにする。
 */
export function clientFolderName(client: { name: string; kana?: string | null }, caseTitle?: string | null): string {
  const fmt = getSetting('client_folder_name_format').trim();
  const head = (client.kana ?? '').trim().charAt(0);
  if (!fmt || !fmt.includes('{name}')) return client.name;
  if (fmt.includes('{kana}') && !head) return client.name;
  let out = fmt.replace('{kana}', head).replace('{name}', client.name);
  if (out.includes('{case}')) {
    // 事件名が無ければ「{case}」とその前の区切りを落とす
    out = caseTitle?.trim() ? out.replace('{case}', caseTitle.trim()) : out.replace(/[\s　_＿\-－.．]*\{case\}/, '');
  }
  return out.trim();
}

/** 依頼者の代表的な事件名（進行事件 → 残務処理 → 相談 → 終了事件 の順で最新） */
function primaryCaseTitle(clientId: number): string | null {
  const cases = db().select({ title: schema.cases.title, status: schema.cases.status, updatedAt: schema.cases.updatedAt }).from(schema.cases).where(eq(schema.cases.clientId, clientId)).all();
  if (cases.length === 0) return null;
  return cases.sort((a, b) => (STATUS_RANK[a.status as CaseStatus] ?? 9) - (STATUS_RANK[b.status as CaseStatus] ?? 9) || b.updatedAt.localeCompare(a.updatedAt))[0]?.title ?? null;
}

/** 新規に依頼者フォルダを作るときの相対パス */
export function defaultClientFolderRel(client: { id?: number; name: string; kana?: string | null }): string {
  const folderName = clientFolderName(client, client.id ? primaryCaseTitle(client.id) : null);
  const map = statusFolderMap();
  if (!Object.keys(map).length) return folderName;
  const status = client.id ? clientEffectiveStatus(client.id) : 'consultation';
  const parent = map[status] ?? map.consultation ?? map.active;
  return parent ? `${parent}/${folderName}` : folderName;
}

function splitRel(rel: string): { parent: string; name: string } {
  const parts = rel.replace(/^\/+|\/+$/g, '').split('/');
  const name = parts.pop() ?? rel;
  return { parent: parts.join('/'), name };
}

/**
 * 区分フォルダを走査し、依頼者の onedriveFolderPath を「区分/フォルダ名」に解決する。
 * まだ区分が付いていない（名前だけ・未設定）依頼者が対象。
 */
export async function resolveAllClientFolders(): Promise<{ scanned: number; updated: number; missing: string[] }> {
  const parents = clientFolderParents();
  if (parents.length === 1 && parents[0] === '') return { scanned: 0, updated: 0, missing: [] };
  const st = storage();
  if (st.kind === 'onedrive' && !(await isMsConnected())) return { scanned: 0, updated: 0, missing: [] };
  const root = st.clientRoot();
  const index = new Map<string, string>(); // フォルダ名（空白除去） → 区分/名前
  const byBareName = new Map<string, string>(); // 先頭かなを除いた氏名 → 区分/名前
  const itemIdByRel = new Map<string, string>(); // 区分/名前 → OneDrive のフォルダ ID
  const allNames: string[] = [];
  let scanned = 0;
  for (const parent of parents) {
    const items = await st.list(joinPath(root, parent)).catch(() => []);
    for (const i of items) {
      if (!i.isFolder) continue;
      scanned++;
      allNames.push(i.name);
      const key = i.name.replace(/[\s　]/g, '');
      if (i.itemId) itemIdByRel.set(`${parent}/${i.name}`, i.itemId);
      if (!index.has(key)) index.set(key, `${parent}/${i.name}`);
      const bare = parseFolderName(i.name).name.replace(/[\s　]/g, '');
      if (bare && !byBareName.has(bare)) byBareName.set(bare, `${parent}/${i.name}`);
    }
  }
  // 既存フォルダの付け方（「や 山田太郎」など）を覚えておき、新規作成時に合わせる
  if (!getSetting('client_folder_name_format')) {
    const fmt = detectFolderNameFormat(allNames);
    if (fmt) setSetting('client_folder_name_format', fmt);
  }
  // 形式が確定したら、ひらがな始まりの氏名（ひめみこ 等）も先頭 1 文字をかなとして照合し直す
  if (isTightKanaFormat()) {
    byBareName.clear();
    for (const [, rel] of index) {
      const folderName = rel.split('/').pop() ?? rel;
      const bare = parseFolderName(folderName, { tightKana: true }).name.replace(/[\s　]/g, '');
      if (bare && !byBareName.has(bare)) byBareName.set(bare, rel);
    }
  }
  let updated = 0;
  const missing: string[] = [];
  const now = new Date().toISOString();
  for (const c of db().select().from(schema.clients).all()) {
    const cur = c.onedriveFolderPath?.trim() ?? '';
    if (cur.startsWith('/')) continue; // 絶対パス指定はそのまま
    if (cur.includes('/')) {
      // すでに区分付き。実在すればそのまま、無ければ名前で探し直す
      const { name } = splitRel(cur);
      const found = index.get(name.replace(/[\s　]/g, ''));
      if (found && found !== cur) {
        db().update(schema.clients).set({ onedriveFolderPath: found, updatedAt: now }).where(eq(schema.clients.id, c.id)).run();
        updated++;
      }
      rememberClientFolderId(c.id, itemIdByRel.get(found ?? cur));
      continue;
    }
    const key = (cur || c.name).replace(/[\s　]/g, '');
    const found = index.get(key) ?? byBareName.get(key) ?? byBareName.get(parseFolderName(cur || c.name).name.replace(/[\s　]/g, ''));
    if (found) {
      db().update(schema.clients).set({ onedriveFolderPath: found, updatedAt: now }).where(eq(schema.clients.id, c.id)).run();
      rememberClientFolderId(c.id, itemIdByRel.get(found));
      updated++;
    } else {
      missing.push(c.name);
    }
  }
  return { scanned, updated, missing };
}

/**
 * 事件の区分に合わせて依頼者フォルダを区分フォルダ間で移動する（例: 1.進行事件 → 2.残務処理）。
 * 区分に対応しないフォルダ（顧問等）にある場合は動かさない。
 */
export async function syncClientFolderWithStatus(clientId: number, caseId?: number): Promise<{ moved: boolean; from?: string; to?: string }> {
  const map = statusFolderMap();
  if (!Object.keys(map).length) return { moved: false };
  const st = storage();
  if (st.kind !== 'onedrive') return { moved: false };
  if (!(await isMsConnected())) return { moved: false };
  const client = db().select().from(schema.clients).where(eq(schema.clients.id, clientId)).get();
  if (!client) return { moved: false };
  const status = clientEffectiveStatus(clientId);
  const expectedParent = map[status];
  if (!expectedParent) return { moved: false };

  let rel = client.onedriveFolderPath?.trim() ?? '';
  if (rel.startsWith('/')) return { moved: false };
  if (!rel.includes('/')) {
    // 区分が未解決なら先に探す
    await resolveAllClientFolders().catch(() => undefined);
    rel = db().select().from(schema.clients).where(eq(schema.clients.id, clientId)).get()?.onedriveFolderPath?.trim() ?? '';
    if (!rel.includes('/')) return { moved: false };
  }
  const { parent, name } = splitRel(rel);
  if (parent === expectedParent) return { moved: false };
  const statusParents = new Set(Object.values(map));
  if (!statusParents.has(parent)) return { moved: false }; // 顧問等の区分外フォルダは触らない

  const root = st.clientRoot();
  const item = await getItemByPath(joinPath(root, rel));
  if (!item) return { moved: false };
  await moveItem(item.id, joinPath(root, expectedParent));
  const newRel = `${expectedParent}/${name}`;
  const now = new Date().toISOString();
  db().update(schema.clients).set({ onedriveFolderPath: newRel, updatedAt: now }).where(eq(schema.clients.id, clientId)).run();
  if (caseId) {
    db()
      .insert(schema.caseNotes)
      .values({ caseId, clientId, kind: 'progress', occurredAt: now, rawText: '', gist: `依頼者フォルダを「${parent}」から「${expectedParent}」へ移動（${CASE_STATUS_LABEL[status]}）`, createdBy: 'system' })
      .run();
  }
  logger.info({ clientId, from: parent, to: expectedParent }, '依頼者フォルダを区分に合わせて移動');
  return { moved: true, from: parent, to: expectedParent };
}

// ---- OneDrive 側でフォルダ名を変えられたときの追従 ----

/**
 * OneDrive のフォルダは ID で追える。依頼者フォルダの ID を控えておき、
 * 名前を変えられたり別の区分フォルダに移されたりしても、アプリ側のパスを付け直す。
 */
export function rememberClientFolderId(clientId: number, itemId: string | null | undefined) {
  if (!itemId) return;
  const cur = db().select({ id: schema.clients.onedriveItemId }).from(schema.clients).where(eq(schema.clients.id, clientId)).get();
  if (cur?.id === itemId) return;
  db().update(schema.clients).set({ onedriveItemId: itemId, updatedAt: new Date().toISOString() }).where(eq(schema.clients.id, clientId)).run();
}

/** Graph の parentReference.path（/drive/root:/依頼者/1.進行事件）から、依頼者ルートからの相対パスを求める */
export function relPathFromItem(item: { name: string; parentReference?: { path?: string } }, root: string): string | null {
  const raw = item.parentReference?.path ?? '';
  const idx = raw.indexOf('root:');
  if (idx < 0) return null;
  let parent: string;
  try {
    parent = decodeURIComponent(raw.slice(idx + 'root:'.length));
  } catch {
    parent = raw.slice(idx + 'root:'.length);
  }
  const norm = (p: string) => '/' + p.replace(/^\/+|\/+$/g, '');
  const r = norm(root);
  const p = norm(parent);
  if (r !== '/' && p !== r && !p.startsWith(`${r}/`)) return null; // 依頼者ルートの外に出された
  const rel = (r === '/' ? p : p.slice(r.length)).replace(/^\/+|\/+$/g, '');
  return rel ? `${rel}/${item.name}` : item.name;
}

export interface FolderRename {
  clientId: number;
  clientName: string;
  from: string;
  to: string;
}

/** 依頼者フォルダのパスを付け替え、保存済みファイルの表示パスも直す */
function applyNewFolderPath(client: { id: number; name: string; onedriveFolderPath: string | null }, newRel: string): FolderRename {
  const from = client.onedriveFolderPath ?? '';
  const now = new Date().toISOString();
  db().update(schema.clients).set({ onedriveFolderPath: newRel, updatedAt: now }).where(eq(schema.clients.id, client.id)).run();
  if (from) {
    // 保存済みファイルの表示用パスも新しいフォルダ名に置き換える（実体は ID で追えているので移動は不要）
    const oldFolder = joinPath(storage().clientRoot(), from);
    const newFolder = joinPath(storage().clientRoot(), newRel);
    db()
      .run(sql`update attachments set stored_path = ${newFolder} || substr(stored_path, ${oldFolder.length + 1}) where stored_path like ${oldFolder + '/%'}`);
    db().run(sql`update form_templates set path = ${newFolder} || substr(path, ${oldFolder.length + 1}) where path like ${oldFolder + '/%'}`);
  }
  logger.info({ clientId: client.id, from, to: newRel }, 'OneDrive 側のフォルダ名の変更を取り込みました');
  return { clientId: client.id, clientName: client.name, from, to: newRel };
}

/**
 * 依頼者 1 件分。OneDrive 側で名前・場所が変わっていたらパスを付け直す。
 * ID をまだ控えていなければ、今のパスから引いて控える（次回以降の名前変更に備える）。
 */
export async function syncClientFolderName(clientId: number): Promise<FolderRename | null> {
  const st = storage();
  if (st.kind !== 'onedrive') return null;
  if (!(await isMsConnected())) return null;
  const c = db().select().from(schema.clients).where(eq(schema.clients.id, clientId)).get();
  if (!c) return null;
  const rel = c.onedriveFolderPath?.trim() ?? '';
  if (rel.startsWith('/')) return null; // 絶対パス指定はそのまま
  const root = st.clientRoot();
  if (!c.onedriveItemId) {
    if (!rel) return null;
    const item = await getItemByPath(joinPath(root, rel)).catch(() => null);
    if (item) rememberClientFolderId(clientId, item.id);
    return null;
  }
  const item = await getItem(c.onedriveItemId).catch(() => null);
  if (!item || item.deleted) return null; // 消された・ごみ箱送り。パスはそのまま残す
  const newRel = relPathFromItem(item, root);
  if (!newRel || newRel === rel) return null;
  return applyNewFolderPath(c, newRel);
}

/** 全依頼者ぶん。OneDrive 側の名前変更・移動をまとめて取り込む */
export async function syncClientFolderNames(): Promise<{ checked: number; renamed: number; adopted: number; renames: FolderRename[] }> {
  const st = storage();
  if (st.kind !== 'onedrive') return { checked: 0, renamed: 0, adopted: 0, renames: [] };
  if (!(await isMsConnected())) return { checked: 0, renamed: 0, adopted: 0, renames: [] };
  const root = st.clientRoot();
  const renames: FolderRename[] = [];
  let checked = 0;
  let adopted = 0;
  for (const c of db().select().from(schema.clients).all()) {
    const rel = c.onedriveFolderPath?.trim() ?? '';
    if (rel.startsWith('/')) continue;
    if (!c.onedriveItemId) {
      if (!rel) continue;
      const item = await getItemByPath(joinPath(root, rel)).catch(() => null);
      if (item) {
        rememberClientFolderId(c.id, item.id);
        adopted++;
      }
      continue;
    }
    checked++;
    const item = await getItem(c.onedriveItemId).catch(() => null);
    if (!item || item.deleted) continue;
    const newRel = relPathFromItem(item, root);
    if (!newRel || newRel === rel) continue;
    renames.push(applyNewFolderPath(c, newRel));
  }
  return { checked, renamed: renames.length, adopted, renames };
}
