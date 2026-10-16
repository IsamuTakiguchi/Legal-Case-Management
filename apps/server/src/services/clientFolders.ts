import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { storage } from '../integrations/storage.js';
import { isMsConnected, moveItem, getItem, getItemByPath, joinPath, renameItem } from '../integrations/onedrive.js';
import { getSetting, setSetting } from './settings.js';
import { logger } from '../logger.js';
import { CASE_STATUSES, CASE_STATUS_LABEL, familyName, type CaseStatus } from '@lcm/shared';
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
  const allByBare = new Map<string, string[]>(); // 先頭かなを除いた氏名 → その人のフォルダすべて（事件ごとのフォルダ）
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
      if (bare) allByBare.set(bare, [...(allByBare.get(bare) ?? []), `${parent}/${i.name}`]);
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
    allByBare.clear();
    for (const [, rel] of index) {
      const folderName = rel.split('/').pop() ?? rel;
      const bare = parseFolderName(folderName, { tightKana: true }).name.replace(/[\s　]/g, '');
      if (bare && !byBareName.has(bare)) byBareName.set(bare, rel);
      if (bare) allByBare.set(bare, [...(allByBare.get(bare) ?? []), rel]);
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
  updated += linkCaseFolders(allByBare, itemIdByRel);
  return { scanned, updated, missing };
}

// ---- 事件ごとのフォルダ ----

type ClientRow = typeof schema.clients.$inferSelect;
type CaseRow = typeof schema.cases.$inferSelect;

const relOf = (p: string | null | undefined) => p?.trim() ?? '';

/**
 * 事件の実際のフォルダ（依頼者ルートからの相対。「/」始まりは絶対）。
 * 「や 山田花子 離婚」のように事件ごとにフォルダを分けていれば事件のフォルダ、無ければ依頼者フォルダ
 */
export function caseFolderRel(kase: { onedriveFolderPath: string | null }, client: { onedriveFolderPath: string | null } | null | undefined): string {
  return relOf(kase.onedriveFolderPath) || relOf(client?.onedriveFolderPath);
}

/** 依頼者の事件を、実際のフォルダごとにまとめる（同じフォルダを使う事件は、そのフォルダの区分を一緒に決める） */
function folderGroups(client: ClientRow): { rel: string; cases: CaseRow[] }[] {
  const groups = new Map<string, CaseRow[]>();
  for (const k of db().select().from(schema.cases).where(eq(schema.cases.clientId, client.id)).all()) {
    const rel = caseFolderRel(k, client);
    if (rel) groups.set(rel, [...(groups.get(rel) ?? []), k]);
  }
  return [...groups].map(([rel, cases]) => ({ rel, cases }));
}

/** 事件の中でいちばん進んでいる区分（進行事件 > 残務処理 > 相談 > 終了事件） */
function bestStatus(cases: { status: string }[]): CaseStatus {
  return (cases.map((c) => c.status as CaseStatus).sort((a, b) => (STATUS_RANK[a] ?? 9) - (STATUS_RANK[b] ?? 9))[0] ?? 'consultation') as CaseStatus;
}

/** フォルダのパスを付け替える（そのフォルダを指している依頼者・事件の両方） */
function repointFolder(clientId: number, from: string, to: string) {
  const now = new Date().toISOString();
  db().update(schema.clients).set({ onedriveFolderPath: to, updatedAt: now }).where(and(eq(schema.clients.id, clientId), eq(schema.clients.onedriveFolderPath, from))).run();
  db().update(schema.cases).set({ onedriveFolderPath: to, updatedAt: now }).where(and(eq(schema.cases.clientId, clientId), eq(schema.cases.onedriveFolderPath, from))).run();
}

/** 事件名の先頭の依頼者名（フルネームか姓。空白の有無は問わない）を除く（「山田 離婚」→「離婚」） */
export function withoutName(title: string, name: string): string {
  const t = title.trim();
  for (const n of [name, familyName(name)].map((x) => x.replace(/[\s　]+/g, '')).filter((x) => x.length >= 1)) {
    let i = 0;
    let j = 0;
    while (i < t.length && j < n.length) {
      if (/[\s　]/.test(t[i]!)) {
        i++;
        continue;
      }
      if (t[i] !== n[j]) break;
      i++;
      j++;
    }
    if (j === n.length && t.slice(i).trim()) return t.slice(i).trim();
  }
  return t;
}

/** 新しく事件フォルダを作るときの相対パス（区分フォルダ運用なら、その事件の区分のフォルダの中） */
export function defaultCaseFolderRel(client: { name: string; kana?: string | null }, kase: { title: string; status: string }): string {
  const fmt = getSetting('client_folder_name_format');
  // フォルダ名の形式に事件名が無ければ、依頼者名のあとに事件名（依頼者名を除いた部分）を付ける
  const short = withoutName(kase.title, client.name);
  const name = fmt.includes('{case}') ? clientFolderName(client, short) : `${clientFolderName(client)}　${short}`;
  const map = statusFolderMap();
  if (!Object.keys(map).length) return name;
  const parent = map[kase.status as CaseStatus] ?? map.consultation ?? map.active;
  return parent ? `${parent}/${name}` : name;
}

const normTitle = (s: string) => s.normalize('NFKC').replace(/[\s　]+/g, '');

/**
 * 同じ人のフォルダが複数ある（「や 山田花子 離婚」「や 山田花子 婚姻費用」）とき、
 * まだフォルダの決まっていない事件を、フォルダ名の事件名と事件名で照合して事件のフォルダにする（候補が 1 つに絞れたときだけ）
 */
function linkCaseFolders(allByBare: Map<string, string[]>, itemIdByRel: Map<string, string>): number {
  let linked = 0;
  const tightKana = isTightKanaFormat();
  for (const c of db().select().from(schema.clients).all()) {
    const rels = [...new Set(allByBare.get(parseFolderName(c.name).name.replace(/[\s　]/g, '')) ?? allByBare.get(c.name.replace(/[\s　]/g, '')) ?? [])];
    if (rels.length < 2) continue;
    const cases = db().select().from(schema.cases).where(eq(schema.cases.clientId, c.id)).all();
    const used = new Set(cases.map((k) => relOf(k.onedriveFolderPath)).filter(Boolean));
    for (const k of cases) {
      if (relOf(k.onedriveFolderPath)) continue;
      const want = normTitle(withoutName(k.title, c.name));
      if (!want) continue;
      const hits = rels.filter((rel) => {
        if (used.has(rel)) return false;
        const t = normTitle(parseFolderName(splitRel(rel).name, { tightKana }).caseTitle ?? '');
        return !!t && (t.includes(want) || want.includes(t));
      });
      if (hits.length !== 1) continue;
      db().update(schema.cases).set({ onedriveFolderPath: hits[0]!, onedriveItemId: itemIdByRel.get(hits[0]!) ?? null }).where(eq(schema.cases.id, k.id)).run();
      used.add(hits[0]!);
      linked++;
    }
  }
  return linked;
}

/**
 * 事件の区分に合わせて、フォルダを区分フォルダ間で移動する（例: 1.進行事件 → 2.残務処理）。
 * 事件ごとにフォルダがあれば事件のフォルダを、無ければ依頼者フォルダを動かす（同じフォルダの事件の中でいちばん進んだ区分へ）。
 * caseId を渡すと、その事件のフォルダだけを見る。区分に対応しないフォルダ（顧問等）にある場合は動かさない。
 */
export async function syncClientFolderWithStatus(clientId: number, caseId?: number): Promise<{ moved: boolean; from?: string; to?: string }> {
  const map = statusFolderMap();
  if (!Object.keys(map).length) return { moved: false };
  const st = storage();
  if (st.kind !== 'onedrive') return { moved: false };
  if (!(await isMsConnected())) return { moved: false };
  let client = db().select().from(schema.clients).where(eq(schema.clients.id, clientId)).get();
  if (!client) return { moved: false };
  // 区分が未解決（フォルダ名だけ）なら先に探す
  if (folderGroups(client).some((g) => !g.rel.startsWith('/') && !g.rel.includes('/'))) {
    await resolveAllClientFolders().catch(() => undefined);
    client = db().select().from(schema.clients).where(eq(schema.clients.id, clientId)).get() ?? client;
  }
  const statusParents = new Set(Object.values(map));
  const root = st.clientRoot();
  let result: { moved: boolean; from?: string; to?: string } = { moved: false };
  for (const g of folderGroups(client)) {
    if (caseId && !g.cases.some((k) => k.id === caseId)) continue;
    if (g.rel.startsWith('/') || !g.rel.includes('/')) continue;
    const status = bestStatus(g.cases);
    const expectedParent = map[status];
    if (!expectedParent) continue;
    const { parent, name } = splitRel(g.rel);
    if (parent === expectedParent) continue;
    if (!statusParents.has(parent)) continue; // 顧問等の区分外フォルダは触らない
    const item = await getItemByPath(joinPath(root, g.rel));
    if (!item) continue;
    await moveItem(item.id, joinPath(root, expectedParent));
    const newRel = `${expectedParent}/${name}`;
    const isClientFolder = relOf(client.onedriveFolderPath) === g.rel;
    repointFolder(clientId, g.rel, newRel);
    if (caseId) {
      const now = new Date().toISOString();
      db()
        .insert(schema.caseNotes)
        .values({ caseId, clientId, kind: 'progress', occurredAt: now, rawText: '', gist: `${isClientFolder ? '依頼者フォルダ' : `事件フォルダ「${name}」`}を「${parent}」から「${expectedParent}」へ移動（${CASE_STATUS_LABEL[status]}）`, createdBy: 'system' })
        .run();
    }
    logger.info({ clientId, folder: name, from: parent, to: expectedParent }, 'フォルダを区分に合わせて移動');
    result = { moved: true, from: parent, to: expectedParent };
  }
  return result;
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

export function rememberCaseFolderId(caseId: number, itemId: string | null | undefined) {
  if (!itemId) return;
  const cur = db().select({ id: schema.cases.onedriveItemId }).from(schema.cases).where(eq(schema.cases.id, caseId)).get();
  if (cur?.id === itemId) return;
  db().update(schema.cases).set({ onedriveItemId: itemId }).where(eq(schema.cases.id, caseId)).run();
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
  /** 事件のフォルダだったとき、その事件名（同じフォルダの事件が複数なら「、」でつなぐ） */
  caseTitle?: string;
  from: string;
  to: string;
  /** 別の区分フォルダへ移されていて、事件の区分もそれに合わせたとき */
  status?: { to: CaseStatus; changed: CaseStatusChange[] };
}

// ---- OneDrive の区分フォルダ → アプリの事件の区分 ----

export interface CaseStatusChange {
  caseId: number;
  title: string;
  from: CaseStatus;
  to: CaseStatus;
}

/** 依頼者フォルダの相対パス（区分フォルダ/依頼者フォルダ）から、その区分。区分フォルダの外（顧問等・フラット）なら null */
export function statusOfFolderRel(rel: string | null | undefined): CaseStatus | null {
  const r = (rel ?? '').trim();
  if (!r || r.startsWith('/')) return null;
  const { parent } = splitRel(r);
  if (!parent) return null;
  const map = statusFolderMap();
  return (CASE_STATUSES.find((st) => map[st] === parent) as CaseStatus | undefined) ?? null;
}

/**
 * 依頼者フォルダが置かれた区分に、その依頼者の事件の区分を合わせる（フォルダの区分＝依頼者の実効区分になるようにする）。
 * - フォルダの区分より「進んだ」区分の事件（例: フォルダが終了事件なのに進行事件）は、フォルダの区分にする
 * - それでもフォルダの区分の事件が無ければ（例: 終了事件だけの依頼者のフォルダが進行事件へ戻された）、
 *   いちばん最近更新した事件をフォルダの区分にする（相談の事件があればそちらを優先。受任＝相談から進行事件）
 * フォルダは動かさない（OneDrive 側が正）。変えた事件は記録に残す
 */
export function alignCaseStatusToFolder(clientId: number, target: CaseStatus, reason: string, caseIds?: number[]): CaseStatusChange[] {
  // caseIds を渡すと、そのフォルダを使っている事件だけを合わせる（事件ごとにフォルダがあるとき）
  const cases = db()
    .select()
    .from(schema.cases)
    .where(eq(schema.cases.clientId, clientId))
    .all()
    .filter((k) => !caseIds || caseIds.includes(k.id));
  if (!cases.length) return [];
  const rank = (st: string) => STATUS_RANK[st as CaseStatus] ?? 9;
  const changes: CaseStatusChange[] = [];
  for (const k of cases) if (rank(k.status) < STATUS_RANK[target]) changes.push({ caseId: k.id, title: k.title, from: k.status as CaseStatus, to: target });
  const hasTarget = cases.some((k) => k.status === target) || changes.length > 0;
  if (!hasTarget) {
    const byRecent = [...cases].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const pick = (target === 'active' ? byRecent.find((k) => k.status === 'consultation') : undefined) ?? byRecent[0]!;
    changes.push({ caseId: pick.id, title: pick.title, from: pick.status as CaseStatus, to: target });
  }
  const now = new Date().toISOString();
  for (const ch of changes) {
    db().update(schema.cases).set({ status: ch.to, updatedAt: now }).where(eq(schema.cases.id, ch.caseId)).run();
    db()
      .insert(schema.caseNotes)
      .values({ caseId: ch.caseId, clientId, kind: 'progress', occurredAt: now, rawText: reason, gist: `区分を「${CASE_STATUS_LABEL[ch.from]}」から「${CASE_STATUS_LABEL[ch.to]}」に変更（${reason}）`, createdBy: 'system' })
      .run();
  }
  if (changes.length) logger.info({ clientId, target, changes: changes.length }, 'OneDrive のフォルダの区分に合わせて事件の区分を変えました');
  return changes;
}

/**
 * フォルダの置き場所（区分）と、アプリの事件の区分が食い違っているもの。
 * 事件ごとにフォルダがあれば事件のフォルダごと、無ければ依頼者フォルダごと（従来どおり）
 */
export function folderStatusMismatches(): {
  clientId: number;
  clientName: string;
  folder: string;
  folderStatus: CaseStatus;
  appStatus: CaseStatus;
  caseCount: number;
  caseIds: number[];
  caseTitles: string[];
}[] {
  if (!hasStatusLayout()) return [];
  const out: ReturnType<typeof folderStatusMismatches> = [];
  for (const c of db().select().from(schema.clients).all()) {
    for (const g of folderGroups(c)) {
      const folderStatus = statusOfFolderRel(g.rel);
      if (!folderStatus) continue;
      const appStatus = bestStatus(g.cases);
      if (appStatus !== folderStatus)
        out.push({ clientId: c.id, clientName: c.name, folder: g.rel, folderStatus, appStatus, caseCount: g.cases.length, caseIds: g.cases.map((k) => k.id), caseTitles: g.cases.map((k) => k.title) });
    }
  }
  return out;
}

/** 画面で選んだ依頼者について、事件の区分をフォルダの区分に合わせる */
export function applyFolderStatuses(clientIds: number[]): { clients: number; changed: CaseStatusChange[] } {
  const wanted = new Set(clientIds);
  const changed: CaseStatusChange[] = [];
  const touched = new Set<number>();
  for (const m of folderStatusMismatches()) {
    if (!wanted.has(m.clientId)) continue;
    const r = alignCaseStatusToFolder(m.clientId, m.folderStatus, `OneDrive でフォルダが「${statusFolderMap()[m.folderStatus]}」にあるため`, m.caseIds);
    if (r.length) touched.add(m.clientId);
    changed.push(...r);
  }
  return { clients: touched.size, changed };
}

/** 依頼者フォルダの OneDrive 上のパス（「/」で始まる指定は絶対パス、それ以外は依頼者ルートからの相対） */
function absClientFolder(rel: string): string {
  return rel.startsWith('/') ? rel : joinPath(storage().clientRoot(), rel);
}

/** フォルダのパスを付け替え（依頼者・事件の両方）、保存済みファイルの表示パスも直す */
function applyFolderMove(client: ClientRow, from: string, newRel: string): FolderRename {
  const group = folderGroups(client).find((g) => g.rel === from)?.cases ?? [];
  const isClientFolder = relOf(client.onedriveFolderPath) === from;
  repointFolder(client.id, from, newRel);
  if (from) {
    // 保存済みファイルの表示用パスも新しいフォルダ名に置き換える（実体は ID で追えているので移動は不要）
    const oldFolder = absClientFolder(from);
    const newFolder = absClientFolder(newRel);
    db()
      .run(sql`update attachments set stored_path = ${newFolder} || substr(stored_path, ${oldFolder.length + 1}) where stored_path like ${oldFolder + '/%'}`);
    db().run(sql`update form_templates set path = ${newFolder} || substr(path, ${oldFolder.length + 1}) where path like ${oldFolder + '/%'}`);
  }
  logger.info({ clientId: client.id, from, to: newRel }, 'OneDrive 側のフォルダ名の変更を取り込みました');
  const out: FolderRename = { clientId: client.id, clientName: client.name, from, to: newRel, ...(isClientFolder ? {} : { caseTitle: group.map((k) => k.title).join('、') }) };
  // 別の区分フォルダへ移されていたら、そのフォルダの事件の区分もフォルダに合わせる（OneDrive 側での整理をアプリに反映する）
  const before = statusOfFolderRel(from);
  const after = statusOfFolderRel(newRel);
  if (after && after !== before && group.length) {
    const changed = alignCaseStatusToFolder(client.id, after, `OneDrive で${isClientFolder ? '依頼者フォルダ' : '事件フォルダ'}が「${splitRel(newRel).parent}」へ移されたため`, group.map((k) => k.id));
    if (changed.length) out.status = { to: after, changed };
  }
  return out;
}

/**
 * 控えた ID でフォルダを追い、名前・場所が変わっていればパスを付け直す。
 * ID をまだ控えていなければ、今のパスから引いて控える（adopted）
 */
async function followFolder(client: ClientRow, rel: string, itemId: string | null, remember: (id: string) => void): Promise<{ rename: FolderRename | null; adopted: boolean; checked: boolean }> {
  const none = { rename: null, adopted: false, checked: false };
  if (!rel || rel.startsWith('/')) return none; // 絶対パス指定はそのまま
  const root = storage().clientRoot();
  if (!itemId) {
    const item = await getItemByPath(joinPath(root, rel)).catch(() => null);
    if (!item) return none;
    remember(item.id);
    return { ...none, adopted: true };
  }
  const item = await getItem(itemId).catch(() => null);
  if (!item || item.deleted) return { ...none, checked: true }; // 消された・ごみ箱送り。パスはそのまま残す
  const newRel = relPathFromItem(item, root);
  if (!newRel || newRel === rel) return { ...none, checked: true };
  return { rename: applyFolderMove(client, rel, newRel), adopted: false, checked: true };
}

/** 依頼者 1 人分（事件ごとのフォルダ → 依頼者フォルダの順に追う） */
async function followClientFolders(clientId: number): Promise<{ renames: FolderRename[]; adopted: number; checked: number }> {
  const out = { renames: [] as FolderRename[], adopted: 0, checked: 0 };
  const cases = db().select().from(schema.cases).where(eq(schema.cases.clientId, clientId)).all();
  for (const k of cases) {
    const fresh = db().select().from(schema.cases).where(eq(schema.cases.id, k.id)).get();
    const client = db().select().from(schema.clients).where(eq(schema.clients.id, clientId)).get();
    if (!fresh || !client) continue;
    const r = await followFolder(client, relOf(fresh.onedriveFolderPath), fresh.onedriveItemId, (id) => rememberCaseFolderId(k.id, id));
    if (r.rename) out.renames.push(r.rename);
    if (r.adopted) out.adopted++;
    if (r.checked) out.checked++;
  }
  const client = db().select().from(schema.clients).where(eq(schema.clients.id, clientId)).get();
  if (client) {
    const r = await followFolder(client, relOf(client.onedriveFolderPath), client.onedriveItemId, (id) => rememberClientFolderId(clientId, id));
    if (r.rename) out.renames.push(r.rename);
    if (r.adopted) out.adopted++;
    if (r.checked) out.checked++;
  }
  return out;
}

/**
 * 依頼者 1 件分（事件ごとのフォルダも）。OneDrive 側で名前・場所が変わっていたらパスを付け直す。
 * ID をまだ控えていなければ、今のパスから引いて控える（次回以降の名前変更に備える）。
 * 依頼者フォルダの変更があればそれを、無ければ最初の事件フォルダの変更を返す
 */
export async function syncClientFolderName(clientId: number): Promise<FolderRename | null> {
  const st = storage();
  if (st.kind !== 'onedrive') return null;
  if (!(await isMsConnected())) return null;
  const r = await followClientFolders(clientId);
  return r.renames.find((x) => !x.caseTitle) ?? r.renames[0] ?? null;
}

/** 全依頼者ぶん。OneDrive 側の名前変更・移動をまとめて取り込む */
export async function syncClientFolderNames(): Promise<{ checked: number; renamed: number; adopted: number; renames: FolderRename[] }> {
  const st = storage();
  if (st.kind !== 'onedrive') return { checked: 0, renamed: 0, adopted: 0, renames: [] };
  if (!(await isMsConnected())) return { checked: 0, renamed: 0, adopted: 0, renames: [] };
  const renames: FolderRename[] = [];
  let checked = 0;
  let adopted = 0;
  for (const c of db().select({ id: schema.clients.id }).from(schema.clients).all()) {
    const r = await followClientFolders(c.id);
    renames.push(...r.renames);
    checked += r.checked;
    adopted += r.adopted;
  }
  return { checked, renamed: renames.length, adopted, renames };
}

// ---- アプリから依頼者フォルダを指定し直す・名前を変える ----

/**
 * 画面で依頼者フォルダのパスを指定し直したとき。
 * 前のフォルダの ID を覚えたままだと、名前変更の追従で前のフォルダに戻されてしまうので、ID を付け直す
 * （新しいフォルダがまだ無ければ ID は空にしておき、作られたときに控える）。
 */
export async function adoptClientFolderPath(clientId: number): Promise<void> {
  db().update(schema.clients).set({ onedriveItemId: null }).where(eq(schema.clients.id, clientId)).run();
  const st = storage();
  if (st.kind !== 'onedrive' || !(await isMsConnected().catch(() => false))) return;
  const c = db().select().from(schema.clients).where(eq(schema.clients.id, clientId)).get();
  const rel = c?.onedriveFolderPath?.trim() ?? '';
  if (!c || !rel) return;
  const item = await getItemByPath(absClientFolder(rel)).catch(() => null);
  if (item) rememberClientFolderId(clientId, item.id);
}

/** OneDrive で使えない文字（" * : < > ? / \ |）と、前後の空白・末尾の「.」 */
export function validateFolderName(name: string): string {
  const n = name.trim();
  if (!n) throw new Error('フォルダ名を入力してください');
  if (/["*:<>?/\\|]/.test(n)) throw new Error('フォルダ名に " * : < > ? / \\ | は使えません');
  if (n.endsWith('.')) throw new Error('フォルダ名の最後に「.」は付けられません');
  if (n.length > 200) throw new Error('フォルダ名が長すぎます');
  return n;
}

/**
 * 依頼者フォルダそのものの名前を OneDrive 上で変える（場所は変えない）。
 * アプリ側のパスと、保存済みファイルの表示パスも新しい名前に付け替える。
 */
export async function renameClientFolder(clientId: number, newName: string): Promise<FolderRename> {
  const name = validateFolderName(newName);
  const st = storage();
  if (st.kind !== 'onedrive') throw new Error('フォルダ名の変更は OneDrive を使っているときだけできます');
  if (!(await isMsConnected())) throw new Error('OneDrive に接続していません。初期設定から接続してください');
  const c = db().select().from(schema.clients).where(eq(schema.clients.id, clientId)).get();
  if (!c) throw new Error('依頼者が見つかりません');
  const rel = c.onedriveFolderPath?.trim() || defaultClientFolderRel(c);
  const item = (c.onedriveItemId ? await getItem(c.onedriveItemId).catch(() => null) : null) ?? (await getItemByPath(absClientFolder(rel)).catch(() => null));
  if (!item || item.deleted) throw new Error('OneDrive にこの依頼者のフォルダが見つかりません。先にフォルダを作るか、別のフォルダを指定してください');
  if (item.name === name) return { clientId, clientName: c.name, from: rel, to: rel };
  try {
    await renameItem(item.id, name);
  } catch (err) {
    if (/ 409 /.test((err as Error).message)) throw new Error(`同じ場所に「${name}」というフォルダがすでにあります`);
    throw err;
  }
  rememberClientFolderId(clientId, item.id);
  // 場所は変えないので、パスの最後だけを新しい名前にする
  const newRel = rel.replace(/[^/]+\/*$/, name);
  // パス未設定（既定の場所）だった依頼者も、まず今のパスを持たせてから付け替える
  if (!relOf(c.onedriveFolderPath)) db().update(schema.clients).set({ onedriveFolderPath: rel }).where(eq(schema.clients.id, clientId)).run();
  return applyFolderMove({ ...c, onedriveFolderPath: rel }, rel, newRel);
}

/** 画面で事件フォルダを指定し直したとき（前のフォルダの ID を忘れて、新しいフォルダの ID を控える） */
export async function adoptCaseFolderPath(caseId: number): Promise<void> {
  db().update(schema.cases).set({ onedriveItemId: null }).where(eq(schema.cases.id, caseId)).run();
  const st = storage();
  if (st.kind !== 'onedrive' || !(await isMsConnected().catch(() => false))) return;
  const k = db().select().from(schema.cases).where(eq(schema.cases.id, caseId)).get();
  const rel = relOf(k?.onedriveFolderPath);
  if (!k || !rel) return;
  const item = await getItemByPath(absClientFolder(rel)).catch(() => null);
  if (item) rememberCaseFolderId(caseId, item.id);
}

/** 事件のフォルダを指定し直す（null・空なら事件のフォルダをやめて依頼者フォルダを使う） */
export async function setCaseFolder(caseId: number, path: string | null): Promise<{ path: string | null }> {
  const k = db().select().from(schema.cases).where(eq(schema.cases.id, caseId)).get();
  if (!k) throw new Error('事件が見つかりません');
  const rel = (path ?? '').trim().replace(/\/+$/g, '');
  if (rel.split('/').some((x) => x.trim() === '..')) throw new Error('フォルダの指定が正しくありません');
  db().update(schema.cases).set({ onedriveFolderPath: rel || null, updatedAt: new Date().toISOString() }).where(eq(schema.cases.id, caseId)).run();
  await adoptCaseFolderPath(caseId);
  return { path: rel || null };
}

/** 事件のフォルダを OneDrive に作る（名前を省けば「かな 氏名 事件名」の形。区分フォルダ運用なら事件の区分のフォルダの中） */
export async function createCaseFolder(caseId: number, name?: string | null): Promise<{ path: string; folder: string }> {
  const k = db().select().from(schema.cases).where(eq(schema.cases.id, caseId)).get();
  if (!k) throw new Error('事件が見つかりません');
  const client = db().select().from(schema.clients).where(eq(schema.clients.id, k.clientId)).get();
  if (!client) throw new Error('依頼者が見つかりません');
  let rel = defaultCaseFolderRel(client, k);
  if (name?.trim()) {
    const { parent } = splitRel(rel);
    rel = parent ? `${parent}/${validateFolderName(name)}` : validateFolderName(name);
  }
  const folder = absClientFolder(rel);
  await storage().ensureFolder(folder);
  db().update(schema.cases).set({ onedriveFolderPath: rel, onedriveItemId: null, updatedAt: new Date().toISOString() }).where(eq(schema.cases.id, caseId)).run();
  // 以後 OneDrive 側で名前を変えられても追えるよう、フォルダの ID を控える
  if (storage().kind === 'onedrive' && (await isMsConnected().catch(() => false))) {
    const item = await getItemByPath(folder).catch(() => null);
    if (item) rememberCaseFolderId(caseId, item.id);
  }
  // 依頼者フォルダがまだ無ければ、このフォルダを依頼者フォルダにもする（既定の保存先）
  if (!relOf(client.onedriveFolderPath)) db().update(schema.clients).set({ onedriveFolderPath: rel }).where(eq(schema.clients.id, client.id)).run();
  return { path: rel, folder };
}
