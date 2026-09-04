import { Hono } from 'hono';
import { z } from 'zod';
import { streamSSE } from 'hono/streaming';
import { listAttachments, assignAttachment, processAttachment, retryFailedAttachments } from '../services/attachments.js';
import { indexForms, searchForms, updateForm, formStats, draftFromForms } from '../services/forms.js';
import { formDraftRequestSchema } from '@lcm/shared';
import { storage } from '../integrations/storage.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

export const fileRoutes = new Hono();

fileRoutes.get('/attachments', (c) => {
  const q = c.req.query();
  return c.json(listAttachments({ status: q.status || undefined, clientId: q.clientId ? Number(q.clientId) : undefined, limit: q.limit ? Number(q.limit) : undefined }));
});

fileRoutes.post('/attachments/:id/assign', async (c) => {
  const body = z.object({ clientId: z.number().int() }).parse(await c.req.json());
  await assignAttachment(Number(c.req.param('id')), body.clientId);
  return c.json({ ok: true });
});

fileRoutes.post('/attachments/:id/retry', async (c) => {
  const id = Number(c.req.param('id'));
  db().update(schema.attachments).set({ status: 'pending' }).where(eq(schema.attachments.id, id)).run();
  await processAttachment(id);
  return c.json(db().select().from(schema.attachments).where(eq(schema.attachments.id, id)).get());
});

fileRoutes.post('/attachments/retry-failed', async (c) => c.json({ retried: await retryFailedAttachments() }));

/** 保存済み添付のダウンロード（アプリ経由） */
fileRoutes.get('/attachments/:id/download', async (c) => {
  const att = db().select().from(schema.attachments).where(eq(schema.attachments.id, Number(c.req.param('id')))).get();
  if (!att?.storedPath) return c.json({ error: 'not stored' }, 404);
  const data = await storage().get({ itemId: att.driveItemId, path: att.storedPath });
  c.header('Content-Type', att.mime ?? 'application/octet-stream');
  c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(att.filename)}`);
  return c.body(new Uint8Array(data));
});

// ---- 書式ライブラリ ----
fileRoutes.get('/forms', (c) => {
  const q = c.req.query();
  return c.json(searchForms({ q: q.q, caseType: q.caseType || undefined, docType: q.docType || undefined, source: q.source || undefined, limit: q.limit ? Number(q.limit) : undefined }));
});

fileRoutes.get('/forms/stats', (c) => c.json(formStats()));

fileRoutes.post('/forms/index', async (c) => c.json(await indexForms({ full: c.req.query('full') === '1' })));

fileRoutes.put('/forms/:id', async (c) => {
  const body = z.object({ caseType: z.string().nullable().optional(), docType: z.string().nullable().optional() }).parse(await c.req.json());
  updateForm(Number(c.req.param('id')), body);
  return c.json({ ok: true });
});

fileRoutes.get('/forms/:id/text', (c) => {
  const row = db().select().from(schema.formTemplates).where(eq(schema.formTemplates.id, Number(c.req.param('id')))).get();
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ id: row.id, name: row.name, text: row.extractedText, error: row.extractError });
});

/** AI 下書き（SSE で進捗を流し、最後に結果を返す） */
fileRoutes.post('/forms/draft', async (c) => {
  const req = formDraftRequestSchema.parse(await c.req.json());
  return streamSSE(c, async (stream) => {
    try {
      const result = await draftFromForms(req, (t) => {
        void stream.writeSSE({ event: 'delta', data: JSON.stringify({ t }) });
      });
      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({ text: result.text, filename: result.filename, savedPath: result.savedPath, webUrl: result.webUrl, docxBase64: result.docx.toString('base64') }),
      });
    } catch (err) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: String((err as Error).message ?? err) }) });
    }
  });
});
