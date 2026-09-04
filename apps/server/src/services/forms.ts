import { and, eq, desc, inArray, sql } from 'drizzle-orm';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import ExcelJS from 'exceljs';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import { db, schema } from '../db/index.js';
import { storage } from '../integrations/storage.js';
import { joinPath } from '../integrations/onedrive.js';
import { getSetting } from './settings.js';
import { clientFolder } from './attachments.js';
import { generateText } from '../integrations/anthropic.js';
import { inferDocType, type FormDraftRequest } from '@lcm/shared';
import { ftsQuery } from './inbox.js';
import { logger } from '../logger.js';

export type FormRow = typeof schema.formTemplates.$inferSelect;

const INDEXABLE = /\.(docx|doc|pdf|xlsx|xlsm|txt)$/i;
const MAX_TEXT = 60_000;

export async function extractText(name: string, data: Buffer): Promise<string> {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'docx') {
    const r = await mammoth.extractRawText({ buffer: data });
    return r.value;
  }
  if (ext === 'pdf') {
    const parser = new PDFParse({ data: new Uint8Array(data) });
    try {
      const r = await parser.getText();
      return r.text;
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }
  if (ext === 'xlsx' || ext === 'xlsm') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(data as unknown as ArrayBuffer);
    const parts: string[] = [];
    wb.eachSheet((ws) => {
      parts.push(`# ${ws.name}`);
      ws.eachRow((row) => {
        const vals = (row.values as unknown[]).slice(1).map((v) => (v === null || v === undefined ? '' : typeof v === 'object' && 'text' in (v as object) ? String((v as { text: unknown }).text) : String(v)));
        if (vals.some((v) => v)) parts.push(vals.join('\t'));
      });
    });
    return parts.join('\n');
  }
  if (ext === 'txt') return data.toString('utf8');
  throw new Error(`本文抽出に未対応の形式: ${ext}`);
}

function docTypeKeywords(): Record<string, string[]> {
  const ct = db().select().from(schema.caseTypes).get();
  return ct?.docTypeKeywords ?? {};
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
    const active = db().select().from(schema.cases).where(eq(schema.cases.clientId, c.id)).orderBy(desc(schema.cases.updatedAt)).get();
    for (const sub of clientSub) targets.push({ folder: joinPath(clientFolder(c), sub), source: 'client_folder', clientId: c.id, caseType: active?.caseType ?? null });
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
      };
      if (existing) db().update(schema.formTemplates).set(values).where(eq(schema.formTemplates.id, existing.id)).run();
      else db().insert(schema.formTemplates).values(values).run();
      indexed++;
    }
  }
  return { scanned, indexed, errors };
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
      extractError: schema.formTemplates.extractError,
      hasText: sql<number>`CASE WHEN ${schema.formTemplates.extractedText} IS NULL THEN 0 ELSE 1 END`,
    })
    .from(schema.formTemplates)
    .where(conds.length ? and(...conds) : undefined)
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
  const rows = db().select({ caseType: schema.formTemplates.caseType, docType: schema.formTemplates.docType, source: schema.formTemplates.source }).from(schema.formTemplates).all();
  const byCaseType: Record<string, number> = {};
  const byDocType: Record<string, number> = {};
  for (const r of rows) {
    byCaseType[r.caseType ?? '未分類'] = (byCaseType[r.caseType ?? '未分類'] ?? 0) + 1;
    byDocType[r.docType ?? '未分類'] = (byDocType[r.docType ?? '未分類'] ?? 0) + 1;
  }
  return { total: rows.length, byCaseType, byDocType };
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
  const text = await generateText({ system, user, effort: 'high', maxTokens: 32000, onDelta });
  const title = req.title?.trim() || `${forms[0].docType ?? '書面'}_下書き`;
  const docx = await buildDocx(title, text);
  const filename = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${title.replace(/[\\/:*?"<>|]/g, '_')}.docx`;
  let savedPath: string | undefined;
  let itemId: string | undefined;
  let webUrl: string | undefined;
  if (req.saveToClientFolder && client) {
    try {
      const folder = joinPath(clientFolder(client), getSetting('draft_subfolder'));
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
