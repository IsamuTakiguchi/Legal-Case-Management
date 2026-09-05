import { eq, and, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import * as cal from '../integrations/calendar.js';
import { createZoomMeeting, deleteZoomMeeting } from '../integrations/zoom.js';
import { generateStructured } from '../integrations/anthropic.js';
import { getSetting, getSettingInt, holidaySet } from './settings.js';
import { upsertAlert, resolveAlertsByKeyPrefix } from './alerts.js';
import { addBusinessDays, familyName, formatJaDateTime, isJstWeekend, jstDate, toJstParts, type ConfirmSlotInput, type ProposeSlotsInput } from '@lcm/shared';
import { isConfigured } from '../config.js';
import { isGoogleConnected } from '../integrations/google.js';

export type SchedulingRow = typeof schema.schedulingSessions.$inferSelect;

export interface Slot {
  startAt: string;
  endAt: string;
}

/** 営業時間内の空き枠を列挙 */
export async function findFreeSlots(opts: { from: Date; to: Date; durationMinutes: number; preferredHours?: number[]; maxCandidates: number }): Promise<Slot[]> {
  const busy = await cal.freeBusy(opts.from, opts.to);
  const startHour = getSettingInt('business_hours_start', 9);
  const endHour = getSettingInt('business_hours_end', 18);
  const holidays = holidaySet();
  const out: Slot[] = [];
  const dur = opts.durationMinutes * 60_000;
  const isBusy = (s: Date, e: Date) => busy.some((b) => new Date(b.start).getTime() < e.getTime() && new Date(b.end).getTime() > s.getTime());
  let cursor = new Date(Math.max(opts.from.getTime(), Date.now() + 3600_000));
  const usedDays = new Map<string, number>();
  while (cursor < opts.to && out.length < opts.maxCandidates) {
    const p = toJstParts(cursor);
    const dayKey = `${p.year}-${p.month}-${p.day}`;
    if (isJstWeekend(cursor) || holidays.has(`${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`)) {
      cursor = jstDate(p.year, p.month, p.day + 1, startHour, 0);
      continue;
    }
    const hours = opts.preferredHours?.length ? opts.preferredHours : Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
    let found = false;
    for (const h of hours) {
      const s = jstDate(p.year, p.month, p.day, h, 0);
      const e = new Date(s.getTime() + dur);
      if (s < cursor) continue;
      if (toJstParts(e).hour > endHour || (toJstParts(e).hour === endHour && toJstParts(e).minute > 0)) continue;
      if (isBusy(s, e)) continue;
      out.push({ startAt: s.toISOString(), endAt: e.toISOString() });
      usedDays.set(dayKey, (usedDays.get(dayKey) ?? 0) + 1);
      found = true;
      break; // 1 日 1 枠まで（候補日を分散させる）
    }
    void found;
    cursor = jstDate(p.year, p.month, p.day + 1, startHour, 0);
  }
  return out;
}

export function holdTitle(clientName: string, kind: string): string {
  const label = kind === 'WEB' ? 'WEB相談' : kind === '面談' ? '新規相談' : kind;
  return `${familyName(clientName)} ${label} 仮`;
}

export function confirmedTitle(clientName: string, kind: string): string {
  const label = kind === 'WEB' ? 'WEB相談' : kind === '面談' ? '新規相談' : kind;
  return `${familyName(clientName)} ${label}`;
}

/** 候補を提案し、仮押さえイベントを作成 */
export async function proposeSlots(input: ProposeSlotsInput): Promise<{ session: SchedulingRow; slots: Slot[]; text: string }> {
  const conv = db().select().from(schema.conversations).where(eq(schema.conversations.id, input.conversationId)).get();
  if (!conv) throw new Error('会話が見つかりません');
  const client = conv.clientId ? db().select().from(schema.clients).where(eq(schema.clients.id, conv.clientId)).get() : null;
  const name = client?.name ?? conv.counterpartName ?? '相手';
  const slots = await findFreeSlots({
    from: new Date(input.from),
    to: new Date(input.to),
    durationMinutes: input.durationMinutes,
    preferredHours: input.preferredHours,
    maxCandidates: input.maxCandidates,
  });
  if (slots.length === 0) throw new Error('指定期間に空き枠がありません');
  const session = db()
    .insert(schema.schedulingSessions)
    .values({ clientId: conv.clientId ?? null, conversationId: conv.id, kind: input.kind, state: 'proposing', candidates: slots, proposedAt: new Date().toISOString() })
    .returning()
    .get();
  const candidates: { startAt: string; endAt: string; eventId?: string }[] = [];
  for (const s of slots) {
    const ev = await cal.createEvent({
      title: holdTitle(name, input.kind),
      startAt: new Date(s.startAt),
      endAt: new Date(s.endAt),
      tentative: true,
      description: `日程調整中（アプリで管理: セッション ${session.id}）`,
      tag: { clientId: conv.clientId ?? null, kind: 'hold', sessionId: session.id },
    });
    candidates.push({ ...s, eventId: ev.id });
  }
  db().update(schema.schedulingSessions).set({ candidates, updatedAt: new Date().toISOString() }).where(eq(schema.schedulingSessions.id, session.id)).run();
  const text = slots.map((s) => `・${formatJaDateTime(new Date(s.startAt))}〜`).join('\n');
  return { session: { ...session, candidates }, slots, text };
}

/** 確定: 他の仮押さえを削除し確定イベントを作成、WEB なら Zoom 発行 */
/** WEB 会議の提供元: zoom（設定済み）> meet（Google 接続済み）> なし */
export function webMeetingProvider(): 'zoom' | 'meet' | 'none' {
  const pref = getSetting('web_meeting_provider'); // auto | zoom | meet
  if (pref === 'zoom') return isConfigured('zoom') ? 'zoom' : 'none';
  if (pref === 'meet') return isGoogleConnected() ? 'meet' : 'none';
  if (isConfigured('zoom')) return 'zoom';
  if (isGoogleConnected()) return 'meet';
  return 'none';
}

export async function confirmSlot(input: ConfirmSlotInput): Promise<{ session: SchedulingRow; event: cal.CalendarEventSummary; zoom: { id: string; joinUrl: string; password: string } | null; text: string; meetUrl?: string | null }> {
  const session = db().select().from(schema.schedulingSessions).where(eq(schema.schedulingSessions.id, input.sessionId)).get();
  if (!session) throw new Error('日程調整セッションが見つかりません');
  const client = session.clientId ? db().select().from(schema.clients).where(eq(schema.clients.id, session.clientId)).get() : null;
  const conv = session.conversationId ? db().select().from(schema.conversations).where(eq(schema.conversations.id, session.conversationId)).get() : null;
  const name = client?.name ?? conv?.counterpartName ?? '相手';
  for (const c of session.candidates) {
    if (c.eventId) await cal.deleteEvent(c.eventId);
  }
  const startAt = new Date(input.startAt);
  const endAt = new Date(startAt.getTime() + input.durationMinutes * 60_000);
  let zoom: { id: string; joinUrl: string; password: string } | null = null;
  const wantsWeb = input.createZoom || session.kind === 'WEB';
  const provider = wantsWeb ? webMeetingProvider() : 'none';
  if (provider === 'zoom') {
    const z = await createZoomMeeting({ topic: `${familyName(name)}様 ${session.kind === 'WEB' ? 'WEB相談' : session.kind}`, startAt, durationMinutes: input.durationMinutes });
    zoom = { id: z.id, joinUrl: z.joinUrl, password: z.password };
  }
  const isWeb = session.kind === 'WEB';
  const event = await cal.createEvent({
    title: confirmedTitle(name, session.kind),
    startAt,
    endAt,
    location: isWeb ? null : getSetting('office_location') || null,
    description: zoom ? `Zoom: ${zoom.joinUrl}\nパスコード: ${zoom.password}` : null,
    meet: provider === 'meet',
    tag: { clientId: session.clientId, kind: session.kind === '期日' ? 'hearing' : session.kind === '打合せ' ? 'meeting' : 'consult', sessionId: session.id },
  });
  const meetUrl = provider === 'meet' ? (event.meetUrl ?? null) : null;
  db()
    .update(schema.schedulingSessions)
    .set({ state: 'confirmed', confirmedEventId: event.id, confirmedStartAt: startAt.toISOString(), zoom, updatedAt: new Date().toISOString() })
    .where(eq(schema.schedulingSessions.id, session.id))
    .run();
  resolveAlertsByKeyPrefix(`scheduling_stale:${session.id}`);
  const when = formatJaDateTime(startAt);
  const text = zoom ? `${when}\nZoom URL: ${zoom.joinUrl}\nパスコード: ${zoom.password}` : meetUrl ? `${when}\nGoogle Meet URL: ${meetUrl}` : when;
  if (meetUrl) db().update(schema.schedulingSessions).set({ zoom: { id: 'meet', joinUrl: meetUrl, password: '' } }).where(eq(schema.schedulingSessions.id, session.id)).run();
  return { session: { ...session, state: 'confirmed', zoom: zoom ?? (meetUrl ? { id: 'meet', joinUrl: meetUrl, password: '' } : null) }, event, zoom, text, meetUrl };
}

export async function cancelSession(sessionId: number) {
  const session = db().select().from(schema.schedulingSessions).where(eq(schema.schedulingSessions.id, sessionId)).get();
  if (!session) return;
  for (const c of session.candidates) if (c.eventId) await cal.deleteEvent(c.eventId);
  if (session.confirmedEventId) await cal.deleteEvent(session.confirmedEventId);
  if (session.zoom?.id) await deleteZoomMeeting(session.zoom.id).catch(() => undefined);
  db().update(schema.schedulingSessions).set({ state: 'cancelled', updatedAt: new Date().toISOString() }).where(eq(schema.schedulingSessions.id, sessionId)).run();
  resolveAlertsByKeyPrefix(`scheduling_stale:${sessionId}`);
}

export function listSessions(filter: { conversationId?: number; clientId?: number; state?: string }) {
  const conds = [];
  if (filter.conversationId) conds.push(eq(schema.schedulingSessions.conversationId, filter.conversationId));
  if (filter.clientId) conds.push(eq(schema.schedulingSessions.clientId, filter.clientId));
  if (filter.state) conds.push(eq(schema.schedulingSessions.state, filter.state));
  return db()
    .select()
    .from(schema.schedulingSessions)
    .where(conds.length ? and(...conds) : undefined)
    .all();
}

/** 提案から N 営業日過ぎても未確定ならアラート */
export function checkStaleSessions(): number {
  const days = getSettingInt('scheduling_stale_business_days', 3);
  const rows = db().select().from(schema.schedulingSessions).where(inArray(schema.schedulingSessions.state, ['proposing'])).all();
  let n = 0;
  for (const s of rows) {
    if (!s.proposedAt) continue;
    const deadline = addBusinessDays(new Date(s.proposedAt), days, holidaySet());
    if (deadline.getTime() > Date.now()) continue;
    const client = s.clientId ? db().select().from(schema.clients).where(eq(schema.clients.id, s.clientId)).get() : null;
    upsertAlert({
      type: 'scheduling_stale',
      dedupeKey: `scheduling_stale:${s.id}`,
      title: `日程調整が停滞: ${client?.name ?? '相手'}（${s.kind}）`,
      body: `${formatJaDateTime(new Date(s.proposedAt))} に候補を提案後、確定していません。催促または仮押さえの取消を検討してください。`,
      payload: { sessionId: s.id, conversationId: s.conversationId, clientId: s.clientId },
    });
    n++;
  }
  return n;
}

const chosenSlotSchema = z.object({
  chosenIndex: z.number().int().nullable().describe('候補リストのうち相手が選んだもののインデックス（0 始まり）。選んでいなければ null'),
  alternativeText: z.string().nullable().describe('候補以外の日時を希望している場合、その内容'),
  confidence: z.enum(['high', 'medium', 'low']),
});

/** 相手の返信から選ばれた候補を抽出 */
export async function extractChosenSlot(sessionId: number, replyText: string) {
  const session = db().select().from(schema.schedulingSessions).where(eq(schema.schedulingSessions.id, sessionId)).get();
  if (!session) throw new Error('セッションが見つかりません');
  const list = session.candidates.map((c, i) => `${i}: ${formatJaDateTime(new Date(c.startAt))}`).join('\n');
  return generateStructured({
    system: '日程調整の返信を読み、提示した候補のどれが選ばれたかを判定します。',
    user: `提示した候補:\n${list}\n\n相手の返信:\n${replyText}`,
    schema: chosenSlotSchema,
    effort: 'low',
    maxTokens: 500,
  });
}
