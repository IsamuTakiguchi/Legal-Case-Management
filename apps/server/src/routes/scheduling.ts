import { Hono } from 'hono';
import { z } from 'zod';
import { proposeSlotsSchema, confirmSlotSchema, nextHearingInputSchema, EVENT_KINDS } from '@lcm/shared';
import { proposeSlots, confirmSlot, cancelSession, listSessions, findFreeSlots, extractChosenSlot } from '../services/scheduling.js';
import { syncCalendar, checkPostEvents, resolveNextHearing, listCourtDocs, upcomingEvents, relinkEvent, listCalendarEvents, createCalendarEvent, editCalendarEvent, removeCalendarEvent, createHoldSet, confirmHold, cancelHoldSet } from '../services/court.js';
import { createZoomMeeting } from '../integrations/zoom.js';
import { extractScheduleFromConversation, registerScheduleFromConversation } from '../services/scheduleExtract.js';
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

/** 会話のやり取りから日程を読み取る（AI） */
schedulingRoutes.post('/conversations/:id/schedule/extract', async (c) => c.json(await extractScheduleFromConversation(Number(c.req.param('id')))));

/** 読み取った（修正済みの）日程をカレンダーに登録 */
schedulingRoutes.post('/conversations/:id/schedule/register', async (c) => {
  const body = z
    .object({
      mode: z.enum(['confirmed', 'holds']),
      title: z.string().min(1),
      kind: z.enum(EVENT_KINDS).default('meeting'),
      slots: z.array(z.object({ startAt: z.string(), endAt: z.string() })).min(1).max(10),
      location: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      caseId: z.number().int().nullable().optional(),
    })
    .parse(await c.req.json());
  return c.json(await registerScheduleFromConversation(Number(c.req.param('id')), body));
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

const eventBody = z.object({
  title: z.string().min(1),
  startAt: z.string(),
  endAt: z.string(),
  kind: z.enum(EVENT_KINDS),
  clientId: z.number().int().nullable().optional(),
  caseId: z.number().int().nullable().optional(),
  location: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  tentative: z.boolean().optional(),
});

/** 期間内の予定（from/to は ISO。省略時は今日から 4 週間） */
schedulingRoutes.get('/calendar/events', (c) => {
  const q = c.req.query();
  const from = q.from ? new Date(q.from) : new Date();
  const to = q.to ? new Date(q.to) : new Date(from.getTime() + 28 * 86400_000);
  return c.json(listCalendarEvents(from, to, { clientId: q.clientId ? Number(q.clientId) : undefined, caseId: q.caseId ? Number(q.caseId) : undefined }));
});

schedulingRoutes.post('/calendar/events', async (c) => c.json(await createCalendarEvent(eventBody.parse(await c.req.json()))));

schedulingRoutes.put('/calendar/events/:id', async (c) => {
  const body = eventBody.partial().parse(await c.req.json());
  const id = Number(c.req.param('id'));
  // 紐付けだけの変更（依頼者・事件・種別）は Google 側を触らない
  if (body.title === undefined && body.startAt === undefined && body.endAt === undefined && body.location === undefined && body.description === undefined && body.tentative === undefined) {
    relinkEvent(id, { clientId: body.clientId, caseId: body.caseId, kind: body.kind });
    return c.json(db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id)).get());
  }
  return c.json(await editCalendarEvent(id, body));
});

/** 複数候補の仮押さえをまとめて登録 */
schedulingRoutes.post('/calendar/holds', async (c) => {
  const body = z
    .object({
      title: z.string().min(1),
      kind: z.enum(EVENT_KINDS).default('meeting'),
      clientId: z.number().int().nullable().optional(),
      caseId: z.number().int().nullable().optional(),
      counterpartName: z.string().nullable().optional(),
      location: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      slots: z.array(z.object({ startAt: z.string(), endAt: z.string() })).min(1).max(10),
    })
    .parse(await c.req.json());
  return c.json(await createHoldSet(body));
});

schedulingRoutes.post('/calendar/holds/:sessionId/confirm', async (c) => {
  const body = z.object({ eventId: z.number().int() }).parse(await c.req.json());
  return c.json(await confirmHold(Number(c.req.param('sessionId')), body.eventId));
});

schedulingRoutes.post('/calendar/holds/:sessionId/cancel', async (c) => {
  await cancelHoldSet(Number(c.req.param('sessionId')));
  return c.json({ ok: true });
});

schedulingRoutes.delete('/calendar/events/:id', async (c) => {
  await removeCalendarEvent(Number(c.req.param('id')));
  return c.json({ ok: true });
});

schedulingRoutes.post('/court/next-hearing', async (c) => c.json(await resolveNextHearing(nextHearingInputSchema.parse(await c.req.json()))));

schedulingRoutes.get('/court/docs/:clientId', async (c) => c.json(await listCourtDocs(Number(c.req.param('clientId')), { days: c.req.query('days') ? Number(c.req.query('days')) : undefined })));
