import { and, eq, desc, inArray, sql } from 'drizzle-orm';
import { extractTextInline } from './textExtract.js';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import { db, schema } from '../db/index.js';
import { storage } from '../integrations/storage.js';
import { joinPath } from '../integrations/onedrive.js';
import { getSetting, getSyncState, setSyncState } from './settings.js';
import { isMsConnected } from '../integrations/onedrive.js';
import { clientFolder, caseFolder } from './attachments.js';
import { generateText } from '../integrations/anthropic.js';
import { inferDocType, DOC_TYPE_KEYWORDS, type FormDraftRequest } from '@lcm/shared';
import { ftsQuery } from './inbox.js';
import { logger } from '../logger.js';

export type FormRow = typeof schema.formTemplates.$inferSelect;

const INDEXABLE = /\.(docx|doc|pdf|xlsx|xlsm|txt)$/i;
const MAX_TEXT = 60_000;

/** 本文を取り出す時間の上限（これを超えたら打ち切る） */
const EXTRACT_TIMEOUT_MS = 30_000;
/** 本文を取り出す別スレッドが使ってよいメモリ（MB） */
const EXTRACT_MAX_HEAP_MB = 384;
/** Excel は中身を展開すると何倍にもふくらむので、これより大きいものは読まない */
const EXTRACT_MAX_XLSX_BYTES = 3 * 1024 * 1024;
/** それ以外の形式の上限 */
const EXTRACT_MAX_BYTES = 30 * 1024 * 1024;

/**
 * ファイルの本文を取り出す。
 * 大きな Excel・PDF の読み取りでサーバー全体が固まらないよう、本番（ビルド済み）では別スレッドで動かし、
 * 時間（30 秒）とメモリに上限を付ける。開発・テストでは、その場で読む
 */
export async function extractText(name: string, data: Buffer, opts: { timeoutMs?: number } = {}): Promise<string> {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if ((ext === 'xlsx' || ext === 'xlsm') && data.length > EXTRACT_MAX_XLSX_BYTES) throw new Error('Excel が大きすぎるため本文を取り出していません');
  if (data.length > EXTRACT_MAX_BYTES) throw new Error('ファイルが大きすぎるため本文を取り出していません');
  const workerUrl = new URL('./extractWorker.js', import.meta.url);
  // TypeScript のまま動いているとき（開発・テスト）は別スレッドを起動できないので、その場で読む
  if (!import.meta.url.endsWith('.js') || process.env.EXTRACT_INLINE === '1') return extractTextInline(name, data);
  const { Worker } = await import('node:worker_threads');
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: { name, data }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: EXTRACT_MAX_HEAP_MB } });
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error('時間がかかりすぎるため本文の取り出しを打ち切りました'))), opts.timeoutMs ?? EXTRACT_TIMEOUT_MS);
    worker.once('message', (m: { ok: boolean; text?: string; error?: string }) => done(() => (m.ok ? resolve(m.text ?? '') : reject(new Error(m.error ?? '本文を取り出せませんでした')))));
    worker.once('error', (err) => done(() => reject(err)));
    worker.once('exit', (code) => done(() => reject(new Error(`本文の取り出しが途中で止まりました（${code}）`))));
  });
}

/** 文書種別の手がかり（既定の言葉に、事件類型ごとに足した言葉を加える） */
function docTypeKeywords(): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(Object.entries(DOC_TYPE_KEYWORDS).map(([k, v]) => [k, [...v]]));
  for (const ct of db().select({ kws: schema.caseTypes.docTypeKeywords }).from(schema.caseTypes).all()) {
    for (const [k, v] of Object.entries(ct.kws ?? {})) out[k] = [...new Set([...(out[k] ?? []), ...v])];
  }
  return out;
}

/** パスから事件類型を推定（書式フォルダ直下のサブフォルダ名が類型ラベルと一致すれば採用） */
function inferCaseTypeFromPath(p: string, libraryRoot: string, types: { key: string; label: string }[]): string | null {
  const rel = p.startsWith(libraryRoot) ? p.slice(libraryRoot.length) : p;
  const segs = rel.split('/').filter(Boolean);
  for (const s of segs) {
    const hit = types.find((t) => s.includes(t.label) || t.label.includes(s));
    if (hit) return hit.key;
  }
  return null;
}

/** 書式フォルダと依頼者フォルダの提出書面を索引化 */
export async function indexForms(opts: { full?: boolean } = {}): Promise<{ scanned: number; indexed: number; errors: number }> {
  const types = db().select().from(schema.caseTypes).all();
  const kws = docTypeKeywords();
  const roots = getSetting('forms_library_paths')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const clientSub = getSetting('forms_index_client_subfolders')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const targets: { folder: string; source: 'library' | 'client_folder'; clientId: number | null; caseType: string | null }[] = [];
  for (const r of roots) targets.push({ folder: r, source: 'library', clientId: null, caseType: null });
  const clients = db().select().from(schema.clients).where(eq(schema.clients.archived, false)).all();
  for (const c of clients) {
    const cases = db().select().from(schema.cases).where(eq(schema.cases.clientId, c.id)).orderBy(desc(schema.cases.updatedAt)).all();
    const active = cases[0];
    for (const sub of clientSub) targets.push({ folder: joinPath(clientFolder(c), sub), source: 'client_folder', clientId: c.id, caseType: active?.caseType ?? null });
    // 事件ごとにフォルダがあれば、その事件のフォルダも見る（類型は事件のもの）
    for (const k of cases) {
      const base = caseFolder(c, k);
      if (base === clientFolder(c)) continue;
      for (const sub of clientSub) targets.push({ folder: joinPath(base, sub), source: 'client_folder', clientId: c.id, caseType: k.caseType });
    }
  }
  let scanned = 0;
  let indexed = 0;
  let errors = 0;
  for (const t of targets) {
    let files: Awaited<ReturnType<typeof walk>>;
    try {
      files = await walk(t.folder, 3);
    } catch (err) {
      logger.debug({ err, folder: t.folder }, '書式フォルダの走査をスキップ');
      continue;
    }
    for (const f of files) {
      if (!INDEXABLE.test(f.name)) continue;
      scanned++;
      const key = f.itemId ?? f.path;
      const existing = db().select().from(schema.formTemplates).where(eq(schema.formTemplates.driveItemId, key)).get();
      if (existing && !opts.full && existing.modifiedAt === (f.modifiedAt ?? null) && existing.extractedText) continue;
      let text: string | null = null;
      let extractError: string | null = null;
      try {
        const data = await storage().get({ itemId: f.itemId, path: f.path });
        text = (await extractText(f.name, data)).slice(0, MAX_TEXT);
      } catch (err) {
        extractError = String(err).slice(0, 300);
        errors++;
      }
      const caseType = existing?.manualOverride ? existing.caseType : t.caseType ?? inferCaseTypeFromPath(f.path, t.folder, types);
      const docType = existing?.manualOverride ? existing.docType : inferDocType(f.name, kws);
      const values = {
        driveItemId: key,
        name: f.name,
        path: f.path,
        webUrl: f.webUrl ?? null,
        ext: f.name.split('.').pop()?.toLowerCase() ?? null,
        modifiedAt: f.modifiedAt ?? null,
        size: f.size ?? null,
        caseType,
        docType,
        source: t.source,
        clientId: t.clientId,
        extractedText: text,
        extractError,
        indexedAt: new Date().toISOString(),
        // 新しいファイルとして候補に出ていたものも、書式フォルダ・提出書面にあればライブラリに入れる（対象外にしたものはそのまま）
        ...(existing?.status === 'candidate' ? { status: 'active' } : {}),
      };
      if (existing) db().update(schema.formTemplates).set(values).where(eq(schema.formTemplates.id, existing.id)).run();
      else db().insert(schema.formTemplates).values(values).run();
      indexed++;
    }
  }
  return { scanned, indexed, errors };
}

// ---- OneDrive に新しくできたファイルから、書式の候補を見つける ----

/** 書式として使えそうな形式（自分で作る書面）。PDF は文書種別が分かるものだけ候補にする */
const AUTHORED = /\.(docx|doc|xlsx|xlsm)$/i;
/** はじめて見るとき（目印が無いとき）に拾う期間（ローカルのフォルダのとき。OneDrive は初回は「いま」から見はじめる） */
const INITIAL_LOOKBACK_DAYS = 14;
/** 1 回に追加・候補にする上限（大量に移したときに一度に増えすぎない・1 回の処理が重くならないように） */
const DETECT_LIMIT = 20;
/** これより大きいファイルは本文を取り出さない（夜の索引化に任せる） */
const DETECT_MAX_BYTES = 5 * 1024 * 1024;
/** OneDrive の変更を続きから取るための目印の置き場所（sync_state） */
const DETECT_CURSOR_KEY = 'forms:detectCursor';

/** 依頼者・事件のフォルダ（長いものから当てる）。見つけたファイルがどの依頼者・どの類型かを決めるのに使う */
function folderOwners() {
  const out: { folder: string; clientId: number; caseType: string | null }[] = [];
  const clients = db().select().from(schema.clients).where(eq(schema.clients.archived, false)).all();
  for (const c of clients) {
    const cases = db().select().from(schema.cases).where(eq(schema.cases.clientId, c.id)).orderBy(desc(schema.cases.updatedAt)).all();
    out.push({ folder: clientFolder(c), clientId: c.id, caseType: cases[0]?.caseType ?? null });
    for (const k of cases) {
      const base = caseFolder(c, k);
      if (base !== clientFolder(c)) out.push({ folder: base, clientId: c.id, caseType: k.caseType });
    }
  }
  return out.sort((a, b) => b.folder.length - a.folder.length);
}

const under = (p: string, folder: string) => {
  const f = folder.replace(/\/+$/, '');
  return p === f || p.startsWith(`${f}/`);
};

/**
 * OneDrive（依頼者フォルダ）に新しくできた・書き直したファイルを見て、書式ライブラリの候補にする。
 * - ファイル名から文書種別（準備書面・契約書など）が分かる Word・Excel は、自動でライブラリに入れる（設定 forms_auto_add=1 のとき）
 * - それ以外の Word・Excel と、文書種別が分かる PDF は「候補」にして、画面で追加するか対象外にするかを選ぶ
 * 受け取った資料（受領資料）・送付用に置いたファイル・アプリが保存した受信ファイル・書式フォルダの分（別に索引化）は対象にしない
 */
export async function detectNewForms(opts: { now?: Date } = {}): Promise<{ checked: number; added: number; candidates: number; skipped?: string }> {
  const st = storage();
  if (!st.changedFiles) return { checked: 0, added: 0, candidates: 0, skipped: 'このファイルの置き場所では使えません' };
  if (st.kind === 'onedrive' && !(await isMsConnected().catch(() => false))) return { checked: 0, added: 0, candidates: 0, skipped: 'OneDrive が未接続です' };
  const now = opts.now ?? new Date();
  const root = st.clientRoot();
  const cursor = getSyncState(DETECT_CURSOR_KEY);
  // 書式になりうる形式だけ受け取る（写真・スキャンなどは最初から捨てる）
  const changed = await st.changedFiles(root, cursor, { accept: /\.(docx|doc|xlsx|xlsm|pdf)$/i, limit: 500 });
  const since = changed.initial ? new Date(now.getTime() - INITIAL_LOOKBACK_DAYS * 86400_000).toISOString() : null;
  // 目印は先に進めておく（途中で失敗・再起動しても、同じ重い処理を何度も繰り返さない）
  setSyncState(DETECT_CURSOR_KEY, changed.cursor);

  const libraryRoots = getSetting('forms_library_paths').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  // 受け取った資料・送付用・未振分・バックアップのフォルダは見ない
  const skipSegments = [getSetting('attachment_subfolder'), '送付ファイル', getSetting('unassigned_folder')].filter(Boolean);
  const backup = getSetting('backup_folder');
  const owners = folderOwners();
  const kws = docTypeKeywords();
  const autoAdd = getSetting('forms_auto_add') !== '0';
  const d = db();
  // アプリが保存した受信ファイル（依頼者から届いたもの）は書式ではない
  const received = new Set<string>();
  for (const a of d.select({ itemId: schema.attachments.driveItemId, path: schema.attachments.storedPath }).from(schema.attachments).all()) {
    if (a.itemId) received.add(a.itemId);
    if (a.path) received.add(a.path);
  }

  let checked = 0;
  let added = 0;
  let candidates = 0;
  // 新しいものから見る
  const files = [...changed.files].sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''));
  for (const f of files) {
    if (added + candidates >= DETECT_LIMIT) break;
    if (f.name.startsWith('~$') || f.name.startsWith('.')) continue; // Word の一時ファイルなど
    if (since && (f.modifiedAt ?? '') < since) continue;
    const isPdf = /\.pdf$/i.test(f.name);
    if (!AUTHORED.test(f.name) && !isPdf) continue;
    const segs = f.path.split('/');
    if (skipSegments.some((s) => segs.includes(s))) continue;
    if (backup && under(f.path, joinPath(backup))) continue;
    if (libraryRoots.some((r) => under(f.path, joinPath(r)))) continue;
    if ((f.itemId && received.has(f.itemId)) || received.has(f.path)) continue;
    const owner = owners.find((o) => under(f.path, o.folder));
    if (!owner) continue; // 依頼者のフォルダ以外は見ない
    checked++;
    const key = f.itemId ?? f.path;
    const existing = d.select({ id: schema.formTemplates.id }).from(schema.formTemplates).where(eq(schema.formTemplates.driveItemId, key)).get();
    if (existing) continue; // ライブラリに入っているもの・候補・対象外にしたものはそのまま（中身の更新は夜の索引化で）
    const docType = inferDocType(f.name, kws);
    if (isPdf && !docType) continue;
    let text: string | null = null;
    let extractError: string | null = null;
    if ((f.size ?? 0) <= DETECT_MAX_BYTES) {
      try {
        text = (await extractText(f.name, await st.get({ itemId: f.itemId, path: f.path }))).slice(0, MAX_TEXT);
      } catch (err) {
        extractError = String(err).slice(0, 300);
      }
    } else {
      extractError = '大きすぎるため本文を取り出していません';
    }
    const status = autoAdd && docType && !isPdf ? 'active' : 'candidate';
    d.insert(schema.formTemplates)
      .values({
        driveItemId: key,
        name: f.name,
        path: f.path,
        webUrl: f.webUrl ?? null,
        ext: f.name.split('.').pop()?.toLowerCase() ?? null,
        modifiedAt: f.modifiedAt ?? null,
        size: f.size ?? null,
        caseType: owner.caseType,
        docType,
        source: 'detected',
        status,
        detectedAt: now.toISOString(),
        clientId: owner.clientId,
        extractedText: text,
        extractError,
        indexedAt: now.toISOString(),
      })
      .run();
    if (status === 'active') added++;
    else candidates++;
  }
  if (added || candidates) logger.info({ added, candidates }, 'OneDrive の新しいファイルから書式の候補を見つけました');
  return { checked, added, candidates };
}

/** 確認待ちの候補（新しく見つけた順） */
export function listFormCandidates() {
  return db()
    .select({
      id: schema.formTemplates.id,
      name: schema.formTemplates.name,
      path: schema.formTemplates.path,
      webUrl: schema.formTemplates.webUrl,
      ext: schema.formTemplates.ext,
      modifiedAt: schema.formTemplates.modifiedAt,
      size: schema.formTemplates.size,
      caseType: schema.formTemplates.caseType,
      docType: schema.formTemplates.docType,
      clientId: schema.formTemplates.clientId,
      clientName: schema.clients.name,
      detectedAt: schema.formTemplates.detectedAt,
      extractError: schema.formTemplates.extractError,
      hasText: sql<number>`CASE WHEN ${schema.formTemplates.extractedText} IS NULL THEN 0 ELSE 1 END`,
      excerpt: sql<string | null>`substr(${schema.formTemplates.extractedText}, 1, 160)`,
    })
    .from(schema.formTemplates)
    .leftJoin(schema.clients, eq(schema.clients.id, schema.formTemplates.clientId))
    .where(eq(schema.formTemplates.status, 'candidate'))
    .orderBy(desc(schema.formTemplates.detectedAt), desc(schema.formTemplates.modifiedAt))
    .limit(200)
    .all();
}

/** 候補をライブラリに入れる（類型・文書種別を直してから入れてもよい）、またはライブラリから外す・対象外にする */
export function setFormStatus(id: number, status: 'active' | 'dismissed', patch: { caseType?: string | null; docType?: string | null } = {}) {
  const row = db().select({ id: schema.formTemplates.id }).from(schema.formTemplates).where(eq(schema.formTemplates.id, id)).get();
  if (!row) throw new Error('書式が見つかりません');
  const manual = patch.caseType !== undefined || patch.docType !== undefined;
  db()
    .update(schema.formTemplates)
    .set({ status, ...patch, ...(manual ? { manualOverride: true } : {}) })
    .where(eq(schema.formTemplates.id, id))
    .run();
}

async function walk(folder: string, depth: number): Promise<{ name: string; path: string; itemId?: string; modifiedAt?: string; size?: number; webUrl?: string }[]> {
  const items = await storage().list(folder);
  const out: { name: string; path: string; itemId?: string; modifiedAt?: string; size?: number; webUrl?: string }[] = [];
  for (const i of items) {
    if (i.isFolder) {
      if (depth > 0) out.push(...(await walk(i.path, depth - 1)));
    } else {
      out.push(i);
    }
  }
  return out;
}

export function searchForms(filter: { q?: string; caseType?: string; docType?: string; source?: string; limit?: number }) {
  const d = db();
  const conds = [];
  if (filter.caseType) conds.push(eq(schema.formTemplates.caseType, filter.caseType));
  if (filter.docType) conds.push(eq(schema.formTemplates.docType, filter.docType));
  if (filter.source) conds.push(eq(schema.formTemplates.source, filter.source));
  // ライブラリに入っているものだけ（候補・対象外は出さない）
  conds.push(eq(schema.formTemplates.status, 'active'));
  let ids: number[] | null = null;
  if (filter.q && filter.q.trim()) {
    ids = d.all<{ rowid: number }>(sql`SELECT rowid FROM form_templates_fts WHERE form_templates_fts MATCH ${ftsQuery(filter.q)} ORDER BY bm25(form_templates_fts) LIMIT 200`).map((r) => r.rowid);
    if (ids.length === 0) return [];
    conds.push(inArray(schema.formTemplates.id, ids));
  }
  const rows = d
    .select({
      id: schema.formTemplates.id,
      name: schema.formTemplates.name,
      path: schema.formTemplates.path,
      webUrl: schema.formTemplates.webUrl,
      ext: schema.formTemplates.ext,
      modifiedAt: schema.formTemplates.modifiedAt,
      size: schema.formTemplates.size,
      caseType: schema.formTemplates.caseType,
      docType: schema.formTemplates.docType,
      source: schema.formTemplates.source,
      clientId: schema.formTemplates.clientId,
      detectedAt: schema.formTemplates.detectedAt,
      extractError: schema.formTemplates.extractError,
      hasText: sql<number>`CASE WHEN ${schema.formTemplates.extractedText} IS NULL THEN 0 ELSE 1 END`,
    })
    .from(schema.formTemplates)
    .where(and(...conds))
    .orderBy(desc(schema.formTemplates.modifiedAt))
    .limit(filter.limit ?? 100)
    .all();
  if (ids) {
    const rank = new Map(ids.map((id, i) => [id, i]));
    rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  }
  return rows;
}

export function updateForm(id: number, patch: { caseType?: string | null; docType?: string | null }) {
  db().update(schema.formTemplates).set({ ...patch, manualOverride: true }).where(eq(schema.formTemplates.id, id)).run();
}

export function formStats() {
  const all = db().select({ caseType: schema.formTemplates.caseType, docType: schema.formTemplates.docType, source: schema.formTemplates.source, status: schema.formTemplates.status }).from(schema.formTemplates).all();
  const rows = all.filter((r) => r.status === 'active');
  const candidates = all.filter((r) => r.status === 'candidate').length;
  const byCaseType: Record<string, number> = {};
  const byDocType: Record<string, number> = {};
  for (const r of rows) {
    byCaseType[r.caseType ?? '未分類'] = (byCaseType[r.caseType ?? '未分類'] ?? 0) + 1;
    byDocType[r.docType ?? '未分類'] = (byDocType[r.docType ?? '未分類'] ?? 0) + 1;
  }
  return { total: rows.length, byCaseType, byDocType, candidates };
}

/** 個人情報らしき箇所を伏字化（AI に渡す前処理） */
export function anonymize(text: string, names: string[] = []): string {
  let t = text;
  for (const n of names) {
    if (n.trim().length >= 2) t = t.split(n).join('○○');
  }
  t = t.replace(/〒?\d{3}-?\d{4}\s*[^\n]{0,40}(都|道|府|県)[^\n]{0,60}/g, '〒○○○-○○○○ ○○県○○市…');
  t = t.replace(/0\d{1,4}-\d{1,4}-\d{3,4}/g, '0○○-○○○○-○○○○');
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '○○@○○');
  t = t.replace(/(平成|令和|昭和)\d+年\d+月\d+日生/g, '○年○月○日生');
  return t;
}

/** 書式を雛形にした新しい書面の下書き（Word）を生成 */
export async function draftFromForms(req: FormDraftRequest, onDelta?: (t: string) => void): Promise<{ text: string; filename: string; savedPath?: string; itemId?: string; webUrl?: string; docx: Buffer }> {
  const forms = db().select().from(schema.formTemplates).where(inArray(schema.formTemplates.id, req.templateIds)).all();
  if (forms.length === 0) throw new Error('書式が選択されていません');
  const kase = req.caseId ? db().select().from(schema.cases).where(eq(schema.cases.id, req.caseId)).get() : null;
  const client = kase ? db().select().from(schema.clients).where(eq(schema.clients.id, kase.clientId)).get() : null;
  const otherNames = db().select({ name: schema.clients.name }).from(schema.clients).all().map((c) => c.name).filter((n) => n !== client?.name);
  const sources = forms
    .map((f, i) => {
      let body = f.extractedText ?? '（本文未抽出: ファイル名のみ）';
      if (req.anonymizeSources) body = anonymize(body, otherNames);
      return `=== 書式${i + 1}: ${f.name}（${f.docType ?? '種別不明'}） ===\n${body.slice(0, 20000)}`;
    })
    .join('\n\n');
  const lawyer = getSetting('lawyer_name');
  const office = getSetting('office_name');
  const system = `あなたは日本の弁護士${lawyer ? `（${lawyer}）` : ''}の書面作成を補助するアシスタントです。
参考書式の構成・見出し・定型的な言い回しを踏襲しつつ、与えられた事件情報と指示に基づいて新しい書面の本文を作成します。
- 事実は与えられた情報のみを使い、不明な箇所は〔要確認: ○○〕と明記する
- 参考書式に含まれる他事件の固有名詞・金額・日付は絶対に流用しない
- 法令の条文番号や判例を挙げる場合は、確信がなければ〔要確認〕を付ける
- 出力は書面本文のみ（Markdown の見出し記号 # は使わず、書面としての見出しは行頭に「第1」「1」「(1)」などを用いる）
${office ? `- 事務所名: ${office}` : ''}`;
  const user = `【事件情報】
依頼者: ${client?.name ?? '〔要確認〕'}
事件名: ${kase?.title ?? '〔要確認〕'}
裁判所・事件番号: ${kase?.courtName ?? ''} ${kase?.caseNumber ?? ''}
方針メモ: ${kase?.policy ?? '（なし）'}

【事実関係・書きたい内容】
${req.facts || '（指示のみ）'}

【指示】
${req.instruction || '参考書式に沿って書面を作成する'}

【参考書式】
${sources}`;
  const text = await generateText({ purpose: '書面の下書き', system, user, effort: 'high', maxTokens: 32000, onDelta });
  const title = req.title?.trim() || `${forms[0].docType ?? '書面'}_下書き`;
  const docx = await buildDocx(title, text);
  const filename = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${title.replace(/[\\/:*?"<>|]/g, '_')}.docx`;
  let savedPath: string | undefined;
  let itemId: string | undefined;
  let webUrl: string | undefined;
  if (req.saveToClientFolder && client) {
    try {
      // 事件を選んでいれば、その事件のフォルダに保存する
      const folder = joinPath(caseFolder(client, kase && kase.clientId === client.id ? kase : null), getSetting('draft_subfolder'));
      const stored = await storage().put(folder, filename, docx);
      savedPath = stored.path;
      itemId = stored.itemId;
      webUrl = stored.webUrl;
    } catch (err) {
      logger.warn({ err }, '下書きの保存に失敗（ダウンロードのみ可能）');
    }
  }
  return { text, filename, savedPath, itemId, webUrl, docx };
}

export async function buildDocx(title: string, text: string): Promise<Buffer> {
  const paragraphs: Paragraph[] = [
    new Paragraph({ children: [new TextRun({ text: '【AI 下書き・要確認】', bold: true, color: 'C00000', size: 20 })], alignment: AlignmentType.RIGHT }),
    new Paragraph({ text: title, heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }),
  ];
  for (const line of text.split('\n')) {
    const t = line.replace(/\s+$/, '');
    if (/^(第\d+|[１-９0-9]+[．.]|\(\d+\)|（\d+）)/.test(t.trim())) {
      paragraphs.push(new Paragraph({ children: [new TextRun({ text: t, bold: true, font: 'MS Mincho', size: 22 })], spacing: { before: 200 } }));
    } else {
      paragraphs.push(new Paragraph({ children: [new TextRun({ text: t, font: 'MS Mincho', size: 22 })] }));
    }
  }
  const doc = new Document({ sections: [{ children: paragraphs }] });
  return Buffer.from(await Packer.toBuffer(doc));
}
