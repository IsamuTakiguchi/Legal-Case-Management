import { Hono } from 'hono';
import { listStaff, createStaff, updateStaff, deleteStaff, listChatworkAccounts } from '../services/staff.js';
import { listRooms } from '../channels/chatwork.js';
import { isConfigured } from '../config.js';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { clientInputSchema, caseInputSchema, caseNoteInputSchema, creditorInputSchema, creditorEventInputSchema, CREDITOR_IMPORT_FIELDS, caseContactInputSchema } from '@lcm/shared';
import { searchClients } from '../services/identity.js';
import { storage, FolderNotFoundError } from '../integrations/storage.js';
import { clientFolder } from '../services/attachments.js';
import { listCaseTypes, upsertCaseType, createCase, updateCase, listCases, getCase, caseTimeline, addCaseNote, deleteCaseNote, generateCaseSummary, structureNote } from '../services/cases.js';
import * as creditors from '../services/creditors.js';
import { onedriveCandidates, chatworkCandidates, applyImport, deleteClient } from '../services/clientImport.js';
import { clientFolderParents, defaultClientFolderRel } from '../services/clientFolders.js';
import { listContacts, createContact, updateContact, deleteContact, contactBriefs } from '../services/contacts.js';
import { joinPath } from '../integrations/onedrive.js';

export const clientRoutes = new Hono();

// ---- 依頼者 ----
clientRoutes.get('/clients', (c) => {
  const q = c.req.query('q');
  const rows = q
    ? searchClients(q)
    : db().select().from(schema.clients).where(eq(schema.clients.archived, c.req.query('archived') === '1')).orderBy(schema.clients.name).all();
  return c.json(rows);
});

clientRoutes.post('/clients', async (c) => {
  const input = clientInputSchema.parse(await c.req.json());
  const row = db().insert(schema.clients).values({ ...input, emails: input.emails.map((e) => e.toLowerCase()) }).returning().get();
  return c.json(row);
});

clientRoutes.get('/clients/:id', (c) => {
  const id = Number(c.req.param('id'));
  const row = db().select().from(schema.clients).where(eq(schema.clients.id, id)).get();
  if (!row) return c.json({ error: 'not found' }, 404);
  const cases = listCases({ clientId: id });
  const convRows = db().select().from(schema.conversations).where(eq(schema.conversations.clientId, id)).orderBy(desc(schema.conversations.lastMessageAt)).all();
  const briefs = contactBriefs(convRows.map((v) => v.contactId ?? 0));
  const conversations = convRows.map((v) => ({ ...v, contact: v.contactId ? (briefs.get(v.contactId) ?? null) : null }));
  const tasks = db().select().from(schema.tasks).where(eq(schema.tasks.clientId, id)).orderBy(desc(schema.tasks.updatedAt)).all();
  const events = db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.clientId, id)).orderBy(desc(schema.calendarEvents.startAt)).limit(20).all();
  return c.json({ ...row, cases, conversations, tasks, events, folder: clientFolder(row) });
});

clientRoutes.put('/clients/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const input = clientInputSchema.partial().parse(await c.req.json());
  db().update(schema.clients)
    .set({ ...input, ...(input.emails ? { emails: input.emails.map((e) => e.toLowerCase()) } : {}), updatedAt: new Date().toISOString() })
    .where(eq(schema.clients.id, id))
    .run();
  return c.json(db().select().from(schema.clients).where(eq(schema.clients.id, id)).get());
});

clientRoutes.post('/clients/:id/archive', async (c) => {
  const body = z.object({ archived: z.boolean() }).parse(await c.req.json());
  db().update(schema.clients).set({ archived: body.archived }).where(eq(schema.clients.id, Number(c.req.param('id')))).run();
  return c.json({ ok: true });
});

/** 依頼者フォルダの一覧（OneDrive） */
clientRoutes.get('/clients/:id/files', async (c) => {
  const id = Number(c.req.param('id'));
  const row = db().select().from(schema.clients).where(eq(schema.clients.id, id)).get();
  if (!row) return c.json({ error: 'not found' }, 404);
  const sub = c.req.query('path') ?? '';
  const folder = sub ? `${clientFolder(row)}/${sub.replace(/^\/+/, '')}` : clientFolder(row);
  try {
    const items = await storage().list(folder);
    return c.json({ folder, items, exists: true });
  } catch (err) {
    // 新規依頼者などでフォルダがまだ無いのはエラーではない（最初の保存時か「作成」で作られる）
    if (err instanceof FolderNotFoundError) return c.json({ folder, items: [], exists: false });
    throw err;
  }
});

/** 依頼者フォルダを OneDrive に作る。パス未設定なら既定の場所に作り、依頼者に記録する */
clientRoutes.post('/clients/:id/folder', async (c) => {
  const id = Number(c.req.param('id'));
  const row = db().select().from(schema.clients).where(eq(schema.clients.id, id)).get();
  if (!row) return c.json({ error: 'not found' }, 404);
  let rel = row.onedriveFolderPath?.trim() ?? '';
  if (!rel) {
    rel = defaultClientFolderRel(row);
    db().update(schema.clients).set({ onedriveFolderPath: rel, updatedAt: new Date().toISOString() }).where(eq(schema.clients.id, id)).run();
  }
  const folder = clientFolder({ ...row, onedriveFolderPath: rel });
  await storage().ensureFolder(folder);
  return c.json({ folder, path: rel });
});

/** ルート直下のフォルダ一覧（既存フォルダから依頼者フォルダを選ぶ） */
clientRoutes.get('/drive/folders', async (c) => {
  const root = storage().clientRoot();
  const p = c.req.query('path');
  if (p) return c.json({ path: p, items: await storage().list(p) });
  // 区分フォルダ運用なら各区分の中身をまとめて返す（name は「区分/フォルダ名」）
  const parents = clientFolderParents();
  const items: { name: string; path: string; isFolder: boolean }[] = [];
  for (const parent of parents) {
    const list = await storage().list(parent ? joinPath(root, parent) : root).catch(() => []);
    for (const i of list) items.push({ name: parent ? `${parent}/${i.name}` : i.name, path: i.path, isFolder: i.isFolder });
  }
  return c.json({ path: root, items });
});

// ---- 依頼者の一括登録 ----
clientRoutes.get('/clients/import/candidates', async (c) => {
  const source = c.req.query('source') ?? 'onedrive';
  return c.json(source === 'chatwork' ? await chatworkCandidates() : await onedriveCandidates());
});

clientRoutes.post('/clients/import', async (c) => {
  const rows = z
    .array(
      z.object({
        name: z.string(),
        folderPath: z.string().optional().nullable(),
        chatworkRoomId: z.number().int().optional().nullable(),
        existingClientId: z.number().int().optional().nullable(),
        caseStatus: z.enum(['consultation', 'active', 'wrapup', 'closed']).optional().nullable(),
        caseTitle: z.string().optional().nullable(),
        caseType: z.string().optional().nullable(),
        kana: z.string().optional().nullable(),
      }),
    )
    .parse(await c.req.json());
  return c.json(applyImport(rows));
});

clientRoutes.delete('/clients/:id', (c) => {
  const ok = deleteClient(Number(c.req.param('id')));
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});

/** 一括削除（誤って登録した依頼者の後始末用） */
clientRoutes.post('/clients/bulk-delete', async (c) => {
  const body = z.object({ ids: z.array(z.number().int()).min(1).max(500) }).parse(await c.req.json());
  let deleted = 0;
  for (const id of body.ids) if (deleteClient(id)) deleted++;
  return c.json({ deleted });
});

// ---- 事件類型 ----
clientRoutes.get('/case-types', (c) => c.json(listCaseTypes()));
clientRoutes.put('/case-types', async (c) => {
  const body = z.array(z.object({ key: z.string().min(1), label: z.string().min(1), sortOrder: z.number().int().optional(), hasCreditors: z.boolean().optional(), creditorStages: z.array(z.string()).optional() })).parse(await c.req.json());
  body.forEach((ct, i) => upsertCaseType({ ...ct, sortOrder: ct.sortOrder ?? i }));
  return c.json(listCaseTypes());
});

// ---- 事件 ----
clientRoutes.get('/cases', (c) => c.json(listCases({ clientId: c.req.query('clientId') ? Number(c.req.query('clientId')) : undefined, status: c.req.query('status') || undefined })));

const caseExtra = { caseType: z.string().optional(), stage: z.string().optional().nullable(), policy: z.string().optional().nullable(), staffId: z.number().int().nullable().optional(), chatworkRoomId: z.number().int().nullable().optional() };

clientRoutes.post('/cases', async (c) => {
  const body = caseInputSchema.extend(caseExtra).parse(await c.req.json());
  return c.json(createCase(body));
});

clientRoutes.get('/cases/:id', (c) => {
  const kase = getCase(Number(c.req.param('id')));
  if (!kase) return c.json({ error: 'not found' }, 404);
  return c.json(kase);
});

clientRoutes.get('/cases/:id/timeline', (c) => c.json(caseTimeline(Number(c.req.param('id')))));

// ---- 事件の関係者（相手方・相手方代理人など） ----
clientRoutes.get('/cases/:id/contacts', (c) => c.json(listContacts(Number(c.req.param('id')))));
clientRoutes.post('/cases/:id/contacts', async (c) => c.json(createContact(Number(c.req.param('id')), caseContactInputSchema.parse(await c.req.json()))));
clientRoutes.put('/contacts/:id', async (c) => c.json(updateContact(Number(c.req.param('id')), caseContactInputSchema.partial().parse(await c.req.json()))));
clientRoutes.delete('/contacts/:id', (c) => {
  deleteContact(Number(c.req.param('id')));
  return c.json({ ok: true });
});

// ---- 事務局メンバー ----
clientRoutes.get('/staff', (c) => c.json(listStaff({ includeInactive: c.req.query('all') === '1' })));
clientRoutes.post('/staff', async (c) => {
  const body = z.object({ name: z.string().min(1), kana: z.string().nullable().optional(), chatworkAccountId: z.number().int().nullable().optional(), note: z.string().nullable().optional() }).parse(await c.req.json());
  return c.json(createStaff(body));
});
clientRoutes.put('/staff/:id', async (c) => {
  const body = z.object({ name: z.string().min(1).optional(), kana: z.string().nullable().optional(), chatworkAccountId: z.number().int().nullable().optional(), note: z.string().nullable().optional(), active: z.boolean().optional() }).parse(await c.req.json());
  return c.json(updateStaff(Number(c.req.param('id')), body));
});
clientRoutes.delete('/staff/:id', (c) => {
  deleteStaff(Number(c.req.param('id')));
  return c.json({ ok: true });
});
/** Chatwork の参加ルームのメンバー一覧（事務局メンバー登録の候補） */
clientRoutes.get('/staff/chatwork-accounts', async (c) => c.json(await listChatworkAccounts({ refresh: c.req.query('refresh') === '1' })));
/** Chatwork の参加ルーム一覧（事件専用ルームの指定用） */
clientRoutes.get('/chatwork/rooms', async (c) => {
  if (!isConfigured('chatwork')) return c.json([]);
  const rooms = await listRooms();
  return c.json(rooms.filter((r) => r.type !== 'my').map((r) => ({ roomId: r.room_id, name: r.name, type: r.type })));
});

clientRoutes.put('/cases/:id', async (c) => {
  const body = caseInputSchema.partial().extend(caseExtra).parse(await c.req.json());
  return c.json(updateCase(Number(c.req.param('id')), body));
});

clientRoutes.post('/cases/:id/summary', async (c) => {
  const md = await generateCaseSummary(Number(c.req.param('id')));
  return c.json({ summary: md });
});

/** 電話メモなどの整理（保存前プレビュー） */
clientRoutes.post('/cases/:id/notes/structure', async (c) => {
  const id = Number(c.req.param('id'));
  const body = z.object({ rawText: z.string().min(1), kind: z.string().default('phone'), counterpart: z.string().optional().nullable(), phone: z.string().optional().nullable() }).parse(await c.req.json());
  const kase = getCase(id);
  if (!kase) return c.json({ error: 'not found' }, 404);
  const r = await structureNote(body.rawText, { caseTitle: kase.title, clientName: kase.client?.name, kind: body.kind, counterpart: body.counterpart, phone: body.phone });
  return c.json(r);
});

clientRoutes.post('/cases/:id/notes', async (c) => {
  const id = Number(c.req.param('id'));
  const raw = await c.req.json();
  const input = caseNoteInputSchema.parse({ ...raw, caseId: id });
  const row = await addCaseNote(input, { structure: raw.structure === true, createTasks: raw.createTasks === true });
  return c.json(row);
});

clientRoutes.delete('/case-notes/:id', (c) => {
  deleteCaseNote(Number(c.req.param('id')));
  return c.json({ ok: true });
});

// ---- 債権者 ----
clientRoutes.get('/cases/:id/creditors', (c) => {
  const id = Number(c.req.param('id'));
  return c.json({ creditors: creditors.listCreditors(id), dashboard: creditors.creditorDashboard(id) });
});

clientRoutes.post('/creditors', async (c) => c.json(creditors.createCreditor(creditorInputSchema.parse(await c.req.json()))));

clientRoutes.put('/creditors/:id', async (c) => c.json(creditors.updateCreditor(Number(c.req.param('id')), creditorInputSchema.partial().parse(await c.req.json()))));

clientRoutes.delete('/creditors/:id', (c) => {
  creditors.deleteCreditor(Number(c.req.param('id')));
  return c.json({ ok: true });
});

clientRoutes.get('/creditors/:id/events', (c) => c.json(creditors.listCreditorEvents(Number(c.req.param('id')))));

clientRoutes.post('/creditors/:id/events', async (c) => {
  const input = creditorEventInputSchema.parse({ ...(await c.req.json()), creditorId: Number(c.req.param('id')) });
  return c.json(creditors.addCreditorEvent(input));
});

clientRoutes.post('/creditors/bulk-event', async (c) => {
  const body = z.object({ creditorIds: z.array(z.number().int()).min(1), event: creditorEventInputSchema.omit({ creditorId: true }) }).parse(await c.req.json());
  return c.json({ count: creditors.bulkCreditorEvent(body.creditorIds, body.event) });
});

clientRoutes.post('/cases/:id/creditors/import/preview', async (c) => {
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) return c.json({ error: 'ファイルがありません' }, 400);
  const buf = Buffer.from(await file.arrayBuffer());
  const preview = await creditors.previewExcel(buf);
  return c.json({ ...preview, mapping: creditors.guessMapping(preview.headers), fields: CREDITOR_IMPORT_FIELDS });
});

clientRoutes.post('/cases/:id/creditors/import', async (c) => {
  const id = Number(c.req.param('id'));
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) return c.json({ error: 'ファイルがありません' }, 400);
  const mapping = JSON.parse(String(form.mapping ?? '{}')) as Record<string, number>;
  const buf = Buffer.from(await file.arrayBuffer());
  return c.json(await creditors.importExcel(id, buf, mapping));
});

clientRoutes.get('/cases/:id/creditors/export', async (c) => {
  const id = Number(c.req.param('id'));
  const buf = await creditors.exportExcel(id);
  c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  c.header('Content-Disposition', `attachment; filename="creditors_${id}.xlsx"`);
  return c.body(new Uint8Array(buf));
});
