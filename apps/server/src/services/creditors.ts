import { and, eq, desc, inArray, lt, isNotNull, sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { db, schema } from '../db/index.js';
import type { InboundMessage } from '../channels/types.js';
import type { CreditorInput, CreditorEventInput } from '@lcm/shared';
import { upsertAlert, resolveAlertsByKeyPrefix } from './alerts.js';

export type CreditorRow = typeof schema.creditors.$inferSelect;

export function caseTypeOf(caseId: number) {
  const c = db().select().from(schema.cases).where(eq(schema.cases.id, caseId)).get();
  if (!c) return null;
  return db().select().from(schema.caseTypes).where(eq(schema.caseTypes.key, c.caseType)).get() ?? null;
}

export function creditorStagesFor(caseId: number): string[] {
  return caseTypeOf(caseId)?.creditorStages ?? [];
}

export function listCreditors(caseId: number) {
  const rows = db().select().from(schema.creditors).where(eq(schema.creditors.caseId, caseId)).orderBy(schema.creditors.name).all();
  const ids = rows.map((r) => r.id);
  const lastEvents = ids.length
    ? db()
        .select()
        .from(schema.creditorEvents)
        .where(inArray(schema.creditorEvents.creditorId, ids))
        .orderBy(desc(schema.creditorEvents.occurredAt))
        .all()
    : [];
  const lastBy = new Map<number, (typeof lastEvents)[number]>();
  for (const e of lastEvents) if (!lastBy.has(e.creditorId)) lastBy.set(e.creditorId, e);
  return rows.map((r) => ({ ...r, lastEvent: lastBy.get(r.id) ?? null }));
}

export function creditorDashboard(caseId: number) {
  const rows = listCreditors(caseId);
  const stages = creditorStagesFor(caseId);
  const byStage: Record<string, number> = {};
  for (const s of stages) byStage[s] = 0;
  let unstaged = 0;
  const now = Date.now();
  const overdue: typeof rows = [];
  const stale: typeof rows = [];
  let totalClaim = 0;
  for (const r of rows) {
    if (r.stage && byStage[r.stage] !== undefined) byStage[r.stage]++;
    else unstaged++;
    if (r.nextActionDue && new Date(r.nextActionDue).getTime() < now && r.stage !== stages.at(-1)) overdue.push(r);
    const last = r.lastContactAt ? new Date(r.lastContactAt).getTime() : 0;
    if (r.stage !== stages.at(-1) && now - last > 30 * 86400_000) stale.push(r);
    totalClaim += r.claimAmount ?? 0;
  }
  return { total: rows.length, byStage, unstaged, overdue, stale, totalClaim, stages };
}

export function createCreditor(input: CreditorInput): CreditorRow {
  return db()
    .insert(schema.creditors)
    .values({
      caseId: input.caseId,
      name: input.name,
      kana: input.kana ?? null,
      kind: input.kind ?? null,
      address: input.address ?? null,
      phone: input.phone ?? null,
      fax: input.fax ?? null,
      emails: input.emails.map((e) => e.trim().toLowerCase()).filter(Boolean),
      contactPerson: input.contactPerson ?? null,
      claimAmount: input.claimAmount ?? null,
      claimKind: input.claimKind ?? null,
      stage: input.stage ?? creditorStagesFor(input.caseId)[0] ?? null,
      nextAction: input.nextAction ?? null,
      nextActionDue: input.nextActionDue ?? null,
      note: input.note ?? null,
      source: 'manual',
    })
    .returning()
    .get();
}

export function updateCreditor(id: number, patch: Partial<CreditorInput>): CreditorRow {
  const cur = db().select().from(schema.creditors).where(eq(schema.creditors.id, id)).get();
  if (!cur) throw new Error('債権者が見つかりません');
  const set: Partial<typeof schema.creditors.$inferInsert> = { updatedAt: new Date().toISOString() };
  for (const k of ['name', 'kana', 'kind', 'address', 'phone', 'fax', 'contactPerson', 'claimAmount', 'claimKind', 'nextAction', 'nextActionDue', 'note'] as const) {
    if (patch[k] !== undefined) (set as Record<string, unknown>)[k] = patch[k] ?? null;
  }
  if (patch.emails !== undefined) set.emails = patch.emails.map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (patch.stage !== undefined && patch.stage !== cur.stage) {
    set.stage = patch.stage ?? null;
    db()
      .insert(schema.creditorEvents)
      .values({ creditorId: id, occurredAt: new Date().toISOString(), channel: 'stage', summary: `段階を「${patch.stage}」に変更`, stageAfter: patch.stage ?? null })
      .run();
    if (patch.stage === creditorStagesFor(cur.caseId).at(-1)) resolveAlertsByKeyPrefix(`creditor_overdue:${id}:`);
  }
  db().update(schema.creditors).set(set).where(eq(schema.creditors.id, id)).run();
  return db().select().from(schema.creditors).where(eq(schema.creditors.id, id)).get()!;
}

export function deleteCreditor(id: number) {
  db().delete(schema.creditorEvents).where(eq(schema.creditorEvents.creditorId, id)).run();
  db().delete(schema.creditors).where(eq(schema.creditors.id, id)).run();
}

export function addCreditorEvent(input: CreditorEventInput) {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const row = db()
    .insert(schema.creditorEvents)
    .values({
      creditorId: input.creditorId,
      occurredAt,
      channel: input.channel,
      direction: input.direction ?? null,
      summary: input.summary,
      attachments: input.attachments,
      stageAfter: input.stageAfter ?? null,
    })
    .returning()
    .get();
  const set: Partial<typeof schema.creditors.$inferInsert> = { lastContactAt: occurredAt, updatedAt: new Date().toISOString() };
  if (input.stageAfter) set.stage = input.stageAfter;
  db().update(schema.creditors).set(set).where(eq(schema.creditors.id, input.creditorId)).run();
  return row;
}

export function listCreditorEvents(creditorId: number) {
  return db().select().from(schema.creditorEvents).where(eq(schema.creditorEvents.creditorId, creditorId)).orderBy(desc(schema.creditorEvents.occurredAt)).all();
}

/** 一括で段階を進める／連絡を記録する */
export function bulkCreditorEvent(creditorIds: number[], ev: Omit<CreditorEventInput, 'creditorId'>) {
  let n = 0;
  for (const id of creditorIds) {
    addCreditorEvent({ ...ev, creditorId: id, attachments: ev.attachments ?? [] });
    n++;
  }
  return n;
}

/** Gmail の送受信を債権者のメールアドレスで自動紐付け */
export function linkGmailMessageToCreditor(conv: typeof schema.conversations.$inferSelect, message: typeof schema.messages.$inferSelect, m: InboundMessage) {
  const addr = (m.identity.email ?? conv.counterpartAddress ?? '').toLowerCase();
  if (!addr) return;
  const candidates = db()
    .select()
    .from(schema.creditors)
    .where(sql`instr(lower(${schema.creditors.emails}), ${JSON.stringify(addr).slice(1, -1)}) > 0`)
    .all()
    .filter((c) => c.emails.includes(addr));
  for (const c of candidates) {
    const exists = db()
      .select()
      .from(schema.creditorEvents)
      .where(and(eq(schema.creditorEvents.creditorId, c.id), eq(schema.creditorEvents.messageId, message.id)))
      .get();
    if (exists) continue;
    db()
      .insert(schema.creditorEvents)
      .values({
        creditorId: c.id,
        occurredAt: message.sentAt,
        channel: 'gmail',
        direction: message.direction,
        summary: `${m.subject ? `${m.subject}: ` : ''}${message.body.slice(0, 200)}`,
        conversationId: conv.id,
        messageId: message.id,
        createdBy: 'system',
      })
      .run();
    db().update(schema.creditors).set({ lastContactAt: message.sentAt, updatedAt: new Date().toISOString() }).where(eq(schema.creditors.id, c.id)).run();
  }
}

/** 次のアクション期限超過をアラート化 */
export function checkCreditorOverdue(): number {
  const now = new Date().toISOString();
  const rows = db()
    .select({ c: schema.creditors, caseTitle: schema.cases.title, clientName: schema.clients.name })
    .from(schema.creditors)
    .innerJoin(schema.cases, eq(schema.cases.id, schema.creditors.caseId))
    .innerJoin(schema.clients, eq(schema.clients.id, schema.cases.clientId))
    .where(and(isNotNull(schema.creditors.nextActionDue), lt(schema.creditors.nextActionDue, now)))
    .all();
  for (const r of rows) {
    upsertAlert({
      type: 'creditor_overdue',
      dedupeKey: `creditor_overdue:${r.c.id}:${r.c.nextActionDue}`,
      title: `債権者対応の期限超過: ${r.clientName} / ${r.c.name}`,
      body: `${r.c.nextAction ?? '次のアクション'}（期限 ${r.c.nextActionDue?.slice(0, 10)}）`,
      payload: { creditorId: r.c.id, caseId: r.c.caseId },
    });
  }
  return rows.length;
}

// ---- Excel 取込 / 出力 ----

export async function previewExcel(buf: Buffer): Promise<{ headers: string[]; rows: string[][]; sheet: string }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('シートがありません');
  const rows: string[][] = [];
  ws.eachRow((row) => {
    const vals: string[] = [];
    for (let i = 1; i <= ws.columnCount; i++) vals.push(cellText(row.getCell(i).value));
    rows.push(vals);
  });
  const headers = rows.shift() ?? [];
  return { headers, rows: rows.slice(0, 20), sheet: ws.name };
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return v.result === undefined || v.result === null ? '' : String(v.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v);
}

export function guessMapping(headers: string[]): Record<string, number> {
  const rules: Record<string, RegExp> = {
    name: /債権者|名称|会社名|氏名|名前/,
    kana: /カナ|かな|フリガナ/,
    kind: /種別|区分|分類/,
    address: /住所|所在地/,
    phone: /電話|TEL|Tel/,
    fax: /FAX|Fax|ファックス/,
    email: /メール|mail|Mail/,
    contactPerson: /担当/,
    claimAmount: /債権額|金額|残高|元本/,
    claimKind: /債権種別|債権の種類|内容/,
    note: /備考|メモ|摘要/,
  };
  const out: Record<string, number> = {};
  headers.forEach((h, i) => {
    for (const [field, re] of Object.entries(rules)) {
      if (out[field] === undefined && re.test(h)) out[field] = i;
    }
  });
  return out;
}

export async function importExcel(caseId: number, buf: Buffer, mapping: Record<string, number>): Promise<{ created: number; updated: number }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('シートがありません');
  const existing = db().select().from(schema.creditors).where(eq(schema.creditors.caseId, caseId)).all();
  const key = (name: string, address: string | null) => `${name.replace(/[\s　]/g, '')}|${(address ?? '').replace(/[\s　]/g, '')}`;
  const byKey = new Map(existing.map((c) => [key(c.name, c.address), c]));
  let created = 0;
  let updated = 0;
  const firstStage = creditorStagesFor(caseId)[0] ?? null;
  ws.eachRow((row, idx) => {
    if (idx === 1) return;
    const get = (f: string) => (mapping[f] !== undefined ? cellText(row.getCell(mapping[f] + 1).value).trim() : '');
    const name = get('name');
    if (!name) return;
    const address = get('address') || null;
    const amountRaw = get('claimAmount').replace(/[,，円\s]/g, '');
    const claimAmount = amountRaw && /^-?\d+(\.\d+)?$/.test(amountRaw) ? Math.round(Number(amountRaw)) : null;
    const emails = get('email')
      .split(/[;,、\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes('@'));
    const data = {
      name,
      kana: get('kana') || null,
      kind: get('kind') || null,
      address,
      phone: get('phone') || null,
      fax: get('fax') || null,
      emails,
      contactPerson: get('contactPerson') || null,
      claimAmount,
      claimKind: get('claimKind') || null,
      note: get('note') || null,
    };
    const hit = byKey.get(key(name, address));
    if (hit) {
      db().update(schema.creditors).set({ ...data, updatedAt: new Date().toISOString() }).where(eq(schema.creditors.id, hit.id)).run();
      updated++;
    } else {
      db().insert(schema.creditors).values({ caseId, ...data, stage: firstStage, source: 'excel' }).run();
      created++;
    }
  });
  return { created, updated };
}

export async function exportExcel(caseId: number): Promise<Buffer> {
  const rows = listCreditors(caseId);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('債権者一覧');
  ws.columns = [
    { header: '債権者名', key: 'name', width: 30 },
    { header: 'フリガナ', key: 'kana', width: 20 },
    { header: '種別', key: 'kind', width: 12 },
    { header: '住所', key: 'address', width: 40 },
    { header: '電話', key: 'phone', width: 16 },
    { header: 'FAX', key: 'fax', width: 16 },
    { header: 'メール', key: 'email', width: 28 },
    { header: '担当者', key: 'contactPerson', width: 14 },
    { header: '債権額', key: 'claimAmount', width: 14 },
    { header: '債権種別', key: 'claimKind', width: 14 },
    { header: '段階', key: 'stage', width: 20 },
    { header: '最終接触日', key: 'lastContactAt', width: 14 },
    { header: '次のアクション', key: 'nextAction', width: 30 },
    { header: '期限', key: 'nextActionDue', width: 14 },
    { header: '備考', key: 'note', width: 30 },
  ];
  for (const r of rows) {
    ws.addRow({
      ...r,
      email: r.emails.join(', '),
      lastContactAt: r.lastContactAt?.slice(0, 10) ?? '',
      nextActionDue: r.nextActionDue?.slice(0, 10) ?? '',
    });
  }
  ws.getRow(1).font = { bold: true };
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
