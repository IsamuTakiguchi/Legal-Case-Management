import { Hono } from 'hono';
import { z } from 'zod';
import { streamSSE } from 'hono/streaming';
import { listAttachments, assignAttachment, processAttachment, retryFailedAttachments, saveAttachment, ignoreAttachment, fetchAttachmentData, bulkAttachments } from '../services/attachments.js';
import { indexForms, searchForms, updateForm, formStats, draftFromForms } from '../services/forms.js';
import { formDraftRequestSchema } from '@lcm/shared';
import { storage } from '../integrations/storage.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

export const fileRoutes = new Hono();

fileRoutes.get('/attachments', (c) => {
  const q = c.req.query();
  return c.json(listAttachments({ status: q.status || undefined, clientId: q.clientId ? Number(q.clientId) : undefined, channel: q.channel || undefined, limit: q.limit ? Number(q.limit) : undefined }));
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

/** 一括操作: ignore（不要）/ save（保存。clientId 省略時は会話の依頼者）/ retry（再取得） */
fileRoutes.post('/attachments/bulk', async (c) => {
  const body = z.object({ ids: z.array(z.number().int()).min(1).max(500), action: z.enum(['ignore', 'save', 'retry']), clientId: z.number().int().nullable().optional() }).parse(await c.req.json());
  return c.json(await bulkAttachments(body.ids, body.action, body.clientId ?? null));
});

fileRoutes.post('/attachments/retry-failed', async (c) => c.json({ retried: await retryFailedAttachments() }));

/** 未保存の添付を保存（clientId 省略時は会話の依頼者へ） */
fileRoutes.post('/attachments/:id/save', async (c) => {
  const body = z.object({ clientId: z.number().int().optional().nullable() }).parse(await c.req.json().catch(() => ({})));
  await saveAttachment(Number(c.req.param('id')), body.clientId ?? null);
  return c.json(db().select().from(schema.attachments).where(eq(schema.attachments.id, Number(c.req.param('id')))).get());
});

/** 保存不要にする */
fileRoutes.post('/attachments/:id/ignore', async (c) => {
  await ignoreAttachment(Number(c.req.param('id')));
  return c.json({ ok: true });
});

/** 添付のダウンロード（保存済みは OneDrive から、未保存はチャネルから直接） */
fileRoutes.get('/attachments/:id/download', async (c) => {
  const att = db().select().from(schema.attachments).where(eq(schema.attachments.id, Number(c.req.param('id')))).get();
  if (!att) return c.json({ error: 'not found' }, 404);
  if (att.status === 'ignored') return c.json({ error: '保存不要にしたファイルです' }, 410);
  const { data, filename, mime } = await fetchAttachmentData(att.id);
  c.header('Content-Type', mime ?? 'application/octet-stream');
  c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
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
