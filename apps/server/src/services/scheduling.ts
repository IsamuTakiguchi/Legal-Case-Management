import { eq, and, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import * as cal from '../integrations/calendar.js';
import { createZoomMeeting, deleteZoomMeeting } from '../integrations/zoom.js';
import { generateStructured } from '../integrations/anthropic.js';
import { getSetting, getSettingInt, holidaySet, businessHours, parseHm } from './settings.js';
import { upsertAlert, resolveAlertsByKeyPrefix } from './alerts.js';
import { addBusinessDays, familyName, formatJaDateTime, isJstWeekend, jstDate, toJstParts, type ConfirmSlotInput, type ProposeSlotsInput, type SchedulePreferences } from '@lcm/shared';
import { isConfigured } from '../config.js';
import { isGoogleConnected } from '../integrations/google.js';

export type SchedulingRow = typeof schema.schedulingSessions.$inferSelect;

export interface Slot {
  startAt: string;
  endAt: string;
  /** 相手が挙げた希望日時そのもの */
  requested?: boolean;
}

/** 空き検索で避ける予定 */
export interface BusyBlock {
  start: string;
  end: string;
  /** 外出を伴う予定（前後に移動時間を空ける） */
  travel?: boolean;
  title?: string;
}

export interface FreeSlotOptions {
  from: Date;
  to: Date;
  durationMinutes: number;
  maxCandidates: number;
  /** 旧: 候補にする時（0-23）。preferences.timeRanges があればそちらを優先 */
  preferredHours?: number[];
  /** 相手の希望（期間・曜日・時間帯・NG・希望日時） */
  preferences?: SchedulePreferences | null;
  /** 外出予定の前後の移動時間（分）。省略時は設定値 */
  travelBufferMinutes?: number | null;
  /** 予定と予定の間隔（分）。省略時は設定値 */
  gapMinutes?: number | null;
  /** テスト用の現在時刻 */
  now?: Date;
}

/** 予定に移動が必要か: 場所があり、それが事務所でも WEB 会議でもない */
export function needsTravel(ev: { location?: string | null; title?: string | null }, office = getSetting('office_location')): boolean {
  const loc = (ev.location ?? '').trim();
  if (!loc) return false;
  if (/^https?:\/\//i.test(loc) || /zoom|meet\.google|teams|webex|オンライン|WEB/i.test(loc)) return false;
  const norm = (x: string) => x.replace(/[\s\u3000（）()]/g, '');
  const o = norm(office);
  const l = norm(loc);
  if (o && l && (o.includes(l) || l.includes(o))) return false;
  if (/事務所|当所|来所/.test(loc)) return false;
  return true;
}

/** Google カレンダーの予定を、空き検索用のブロックにする（「予定なし」扱いのものは除く） */
export async function busyBlocks(from: Date, to: Date): Promise<BusyBlock[]> {
  const events = await cal.listEvents(new Date(from.getTime() - 86400_000), new Date(to.getTime() + 86400_000));
  return events.filter((e) => !e.transparent).map((e) => ({ start: e.startAt, end: e.endAt, travel: needsTravel(e), title: e.title }));
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 空き枠を選ぶ（純粋関数）。
 * - 営業時間は分単位（10:00 など）。slot_step_minutes ごとに開始時刻を試す
 * - 予定の前後に slot_gap_minutes、外出予定の前後にはさらに travel_buffer_minutes を空ける
 * - 相手の希望（期間・曜日・時間帯・NG）に合う枠だけを候補にし、相手が挙げた希望日時は空いていれば最優先
 * - 候補日を分散させるため、希望日時を除き 1 日 1 枠
 */
export function pickSlots(busy: BusyBlock[], opts: FreeSlotOptions): Slot[] {
  const { startMin, endMin } = businessHours();
  const step = Math.max(5, getSettingInt('slot_step_minutes', 30));
  const travel = opts.travelBufferMinutes ?? getSettingInt('travel_buffer_minutes', 60);
  const gap = opts.gapMinutes ?? getSettingInt('slot_gap_minutes', 0);
  const holidays = holidaySet();
  const pref = opts.preferences ?? {};
  const dur = opts.durationMinutes * 60_000;
  const now = opts.now ?? new Date();
  const notBefore = Math.max(opts.from.getTime(), now.getTime() + 3600_000);
  const blocks = busy.map((b) => {
    const pad = (gap + (b.travel ? travel : 0)) * 60_000;
    return { s: new Date(b.start).getTime() - pad, e: new Date(b.end).getTime() + pad };
  });
  for (const a of pref.avoid ?? []) {
    const s = new Date(a.from).getTime();
    const e = new Date(a.to).getTime();
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) blocks.push({ s, e });
  }
  const isFree = (s: number, e: number) => !blocks.some((b) => b.s < e && b.e > s);
  const ranges = (pref.timeRanges ?? []).map((r) => ({ from: parseHm(r.from, -1), to: parseHm(r.to, -1) })).filter((r) => r.from >= 0 && r.to > r.from);
  const inRanges = (sMin: number, eMin: number) => ranges.length === 0 || ranges.some((r) => sMin >= r.from && eMin <= r.to);
  const weekdays = new Set(pref.weekdays ?? []);
  const dateKey = (p: { year: number; month: number; day: number }) => `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  const dayOk = (d: Date, strict: boolean) => {
    const p = toJstParts(d);
    const key = dateKey(p);
    if (holidays.has(key)) return false;
    if (pref.earliest && key < pref.earliest) return false;
    if (pref.latest && key > pref.latest) return false;
    if (!strict) return true;
    if (isJstWeekend(d)) return false;
    if (weekdays.size && !weekdays.has(p.weekday)) return false;
    return true;
  };
  const out: Slot[] = [];
  const usedDays = new Set<string>();
  // 相手が挙げた希望日時は、空いていればそのまま候補に（曜日・時間帯の希望より優先）
  for (const r of pref.requested ?? []) {
    const s = new Date(r.startAt).getTime();
    if (!Number.isFinite(s) || s < notBefore || s > opts.to.getTime()) continue;
    const e = s + dur;
    const d = new Date(s);
    if (!dayOk(d, false) || !isFree(s, e)) continue;
    if (out.some((o) => o.startAt === d.toISOString())) continue;
    out.push({ startAt: d.toISOString(), endAt: new Date(e).toISOString(), requested: true });
    usedDays.add(dateKey(toJstParts(d)));
    if (out.length >= opts.maxCandidates) break;
  }
  const p0 = toJstParts(new Date(notBefore));
  const hours = opts.preferredHours?.length && ranges.length === 0 ? new Set(opts.preferredHours) : null;
  for (let day = jstDate(p0.year, p0.month, p0.day); day.getTime() < opts.to.getTime() && out.length < opts.maxCandidates; day = new Date(day.getTime() + 86400_000)) {
    const p = toJstParts(day);
    const key = dateKey(p);
    if (usedDays.has(key) || !dayOk(day, true)) continue;
    for (let m = startMin; m + opts.durationMinutes <= endMin; m += step) {
      if (hours && !hours.has(Math.floor(m / 60))) continue;
      if (!inRanges(m, m + opts.durationMinutes)) continue;
      const s = jstDate(p.year, p.month, p.day, Math.floor(m / 60), m % 60).getTime();
      if (s < notBefore) continue;
      const e = s + dur;
      if (!isFree(s, e)) continue;
      out.push({ startAt: new Date(s).toISOString(), endAt: new Date(e).toISOString() });
      usedDays.add(key);
      break;
    }
  }
  return out.sort((a, b) => a.startAt.localeCompare(b.startAt));
}

/** 営業時間内の空き枠を列挙（Google カレンダーの予定を避ける） */
export async function findFreeSlots(opts: FreeSlotOptions): Promise<Slot[]> {
  const busy = await busyBlocks(opts.from, opts.to);
  return pickSlots(busy, opts);
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
    preferences: input.preferences ?? null,
    travelBufferMinutes: input.travelBufferMinutes ?? null,
    gapMinutes: input.gapMinutes ?? null,
  });
  if (slots.length === 0) throw new Error('指定期間に空き枠がありません（相手の希望や移動時間の条件を緩めると見つかることがあります）');
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
    purpose: '日程調整（返信の読み取り）',
    system: '日程調整の返信を読み、提示した候補のどれが選ばれたかを判定します。',
    user: `提示した候補:\n${list}\n\n相手の返信:\n${replyText}`,
    schema: chosenSlotSchema,
    effort: 'low',
    maxTokens: 500,
  });
}
