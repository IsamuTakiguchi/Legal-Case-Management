import { Hono } from 'hono';
import { z } from 'zod';
import { proposeSlotsSchema, confirmSlotSchema, nextHearingInputSchema, EVENT_KINDS } from '@lcm/shared';
import { proposeSlots, confirmSlot, cancelSession, listSessions, findFreeSlots, extractChosenSlot } from '../services/scheduling.js';
import { syncCalendar, checkPostEvents, resolveNextHearing, listCourtDocs, upcomingEvents, relinkEvent } from '../services/court.js';
import { createZoomMeeting } from '../integrations/zoom.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

export const schedulingRoutes = new Hono();

schedulingRoutes.post('/scheduling/free-slots', async (c) => {
  const body = z.object({ from: z.string(), to: z.string(), durationMinutes: z.number().int().default(60), maxCandidates: z.number().int().default(5), preferredHours: z.array(z.number().int()).optional() }).parse(await c.req.json());
  return c.json(await findFreeSlots({ from: new Date(body.from), to: new Date(body.to), durationMinutes: body.durationMinutes, maxCandidates: body.maxCandidates, preferredHours: body.preferredHours }));
});

schedulingRoutes.post('/scheduling/propose', async (c) => c.json(await proposeSlots(proposeSlotsSchema.parse(await c.req.json()))));

schedulingRoutes.post('/scheduling/confirm', async (c) => c.json(await confirmSlot(confirmSlotSchema.parse(await c.req.json()))));

schedulingRoutes.post('/scheduling/:id/cancel', async (c) => {
  await cancelSession(Number(c.req.param('id')));
  return c.json({ ok: true });
});

schedulingRoutes.post('/scheduling/:id/extract-choice', async (c) => {
  const body = z.object({ replyText: z.string() }).parse(await c.req.json());
  return c.json(await extractChosenSlot(Number(c.req.param('id')), body.replyText));
});

schedulingRoutes.get('/scheduling', (c) => {
  const q = c.req.query();
  return c.json(listSessions({ conversationId: q.conversationId ? Number(q.conversationId) : undefined, clientId: q.clientId ? Number(q.clientId) : undefined, state: q.state || undefined }));
});

/** 単独で Zoom を発行（既存の予定に追加する用途） */
schedulingRoutes.post('/zoom', async (c) => {
  const body = z.object({ topic: z.string(), startAt: z.string(), durationMinutes: z.number().int().default(60) }).parse(await c.req.json());
  return c.json(await createZoomMeeting({ topic: body.topic, startAt: new Date(body.startAt), durationMinutes: body.durationMinutes }));
});

// ---- カレンダー・期日 ----
schedulingRoutes.post('/calendar/sync', async (c) => {
  const r = await syncCalendar();
  const alerts = checkPostEvents();
  return c.json({ ...r, alerts });
});

schedulingRoutes.get('/calendar/upcoming', (c) => c.json(upcomingEvents(Number(c.req.query('days') ?? '14'))));

schedulingRoutes.put('/calendar/events/:id', async (c) => {
  const body = z.object({ clientId: z.number().int().nullable().optional(), caseId: z.number().int().nullable().optional(), kind: z.enum(EVENT_KINDS).optional() }).parse(await c.req.json());
  relinkEvent(Number(c.req.param('id')), body);
  return c.json(db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, Number(c.req.param('id')))).get());
});

schedulingRoutes.post('/court/next-hearing', async (c) => c.json(await resolveNextHearing(nextHearingInputSchema.parse(await c.req.json()))));

schedulingRoutes.get('/court/docs/:clientId', async (c) => c.json(await listCourtDocs(Number(c.req.param('clientId')), { days: c.req.query('days') ? Number(c.req.query('days')) : undefined })));
