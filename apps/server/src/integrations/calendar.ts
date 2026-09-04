import type { calendar_v3 } from 'googleapis';
import { calendarApi } from './google.js';
import { env } from '../config.js';
import type { EventKind } from '@lcm/shared';

const TZ = 'Asia/Tokyo';

export interface EventTag {
  clientId?: number | null;
  caseId?: number | null;
  kind: EventKind;
  sessionId?: number | null;
}

export interface CalendarEventSummary {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  location?: string | null;
  description?: string | null;
  status?: string | null;
  htmlLink?: string | null;
  tag: Partial<EventTag>;
}

function calId() {
  return env().GOOGLE_CALENDAR_ID;
}

function toSummary(e: calendar_v3.Schema$Event): CalendarEventSummary | null {
  const start = e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00+09:00` : null);
  const end = e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00+09:00` : null);
  if (!e.id || !start || !end) return null;
  const p = e.extendedProperties?.private ?? {};
  return {
    id: e.id,
    title: e.summary ?? '',
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    location: e.location,
    description: e.description,
    status: e.status,
    htmlLink: e.htmlLink,
    tag: {
      clientId: p.clientId ? Number(p.clientId) : undefined,
      caseId: p.caseId ? Number(p.caseId) : undefined,
      kind: (p.kind as EventKind | undefined) ?? undefined,
      sessionId: p.sessionId ? Number(p.sessionId) : undefined,
    },
  };
}

export async function listEvents(timeMin: Date, timeMax: Date): Promise<CalendarEventSummary[]> {
  const cal = calendarApi();
  const out: CalendarEventSummary[] = [];
  let pageToken: string | undefined;
  do {
    const res = await cal.events.list({
      calendarId: calId(),
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
      pageToken,
    });
    for (const e of res.data.items ?? []) {
      if (e.status === 'cancelled') continue;
      const s = toSummary(e);
      if (s) out.push(s);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

export async function freeBusy(timeMin: Date, timeMax: Date): Promise<{ start: string; end: string }[]> {
  const cal = calendarApi();
  const res = await cal.freebusy.query({
    requestBody: { timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), timeZone: TZ, items: [{ id: calId() }] },
  });
  const cals = res.data.calendars ?? {};
  const busy = cals[calId()]?.busy ?? Object.values(cals)[0]?.busy ?? [];
  return busy.filter((b) => b.start && b.end).map((b) => ({ start: b.start!, end: b.end! }));
}

export async function createEvent(opts: {
  title: string;
  startAt: Date;
  endAt: Date;
  location?: string | null;
  description?: string | null;
  tentative?: boolean;
  tag: EventTag;
}): Promise<CalendarEventSummary> {
  const cal = calendarApi();
  const priv: Record<string, string> = { kind: opts.tag.kind, app: 'lcm' };
  if (opts.tag.clientId) priv.clientId = String(opts.tag.clientId);
  if (opts.tag.caseId) priv.caseId = String(opts.tag.caseId);
  if (opts.tag.sessionId) priv.sessionId = String(opts.tag.sessionId);
  const res = await cal.events.insert({
    calendarId: calId(),
    requestBody: {
      summary: opts.title,
      location: opts.location ?? undefined,
      description: opts.description ?? undefined,
      start: { dateTime: opts.startAt.toISOString(), timeZone: TZ },
      end: { dateTime: opts.endAt.toISOString(), timeZone: TZ },
      status: opts.tentative ? 'tentative' : 'confirmed',
      extendedProperties: { private: priv },
    },
  });
  const s = toSummary(res.data);
  if (!s) throw new Error('カレンダーイベントの作成結果が不正です');
  return s;
}

export async function updateEvent(
  eventId: string,
  patch: { title?: string; description?: string; location?: string; startAt?: Date; endAt?: Date; tentative?: boolean },
) {
  const cal = calendarApi();
  await cal.events.patch({
    calendarId: calId(),
    eventId,
    requestBody: {
      ...(patch.title !== undefined ? { summary: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.location !== undefined ? { location: patch.location } : {}),
      ...(patch.startAt ? { start: { dateTime: patch.startAt.toISOString(), timeZone: TZ } } : {}),
      ...(patch.endAt ? { end: { dateTime: patch.endAt.toISOString(), timeZone: TZ } } : {}),
      ...(patch.tentative !== undefined ? { status: patch.tentative ? 'tentative' : 'confirmed' } : {}),
    },
  });
}

export async function deleteEvent(eventId: string) {
  const cal = calendarApi();
  try {
    await cal.events.delete({ calendarId: calId(), eventId });
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    if (code === 404 || code === 410) return;
    throw err;
  }
}
