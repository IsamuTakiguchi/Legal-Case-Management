import { and, eq, gt, inArray, lt, desc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import * as cal from '../integrations/calendar.js';
import { classifyEventTitle, titleMentionsClient, isNonClientTitle, formatJaDateTime, familyName, type EventKind, type NextHearingInput, OPEN_CASE_STATUSES } from '@lcm/shared';
import { upsertAlert, resolveAlert, resolveAlertsByKeyPrefix } from './alerts.js';
import { storage } from '../integrations/storage.js';
import { clientFolder } from './attachments.js';
import { getSetting } from './settings.js';
import { joinPath } from '../integrations/onedrive.js';
import { logger } from '../logger.js';
import { randomUUID } from 'node:crypto';
import { isGoogleConnected } from '../integrations/google.js';

/** Google カレンダーを同期し、種別と依頼者を推定してキャッシュ */
export async function syncCalendar(): Promise<{ synced: number }> {
  const now = new Date();
  const from = new Date(now.getTime() - 7 * 86400_000);
  const to = new Date(now.getTime() + 90 * 86400_000);
  const events = await cal.listEvents(from, to);
  const clients = db().select().from(schema.clients).where(eq(schema.clients.archived, false)).all();
  const d = db();
  const seen = new Set<string>();
  for (const e of events) {
    seen.add(e.id);
    let kind: EventKind = e.tag.kind ?? classifyEventTitle(e.title);
    let clientId = e.tag.clientId ?? null;
    let caseId = e.tag.caseId ?? null;
    if (!clientId && !isNonClientTitle(e.title)) {
      // 姓が長い順に照合し、同姓の依頼者は別名（フルネーム等）で区別できるようにする
      const hit = clients
        .map((c) => ({ c, names: [c.name, familyName(c.name), ...c.aliases] }))
        .sort((a, b) => Math.max(...b.names.map((n) => n.length)) - Math.max(...a.names.map((n) => n.length)))
        .find((x) => titleMentionsClient(e.title, x.names));
      if (hit) clientId = hit.c.id;
    }
    if (clientId && !caseId) {
      // 進行事件 → 残務処理 → 相談 の優先順で割り当てる
      const open = d.select().from(schema.cases).where(and(eq(schema.cases.clientId, clientId), inArray(schema.cases.status, OPEN_CASE_STATUSES))).orderBy(desc(schema.cases.updatedAt)).all();
      const rank: Record<string, number> = { active: 0, wrapup: 1, consultation: 2 };
      const active = open.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))[0];
      if (active) caseId = active.id;
    }
    if (e.tag.kind === undefined && e.status === 'tentative' && kind !== 'hold') kind = 'hold';
    const existing = d.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.googleEventId, e.id)).get();
    const values = {
      googleEventId: e.id,
      clientId,
      caseId,
      kind,
      title: e.title,
      startAt: e.startAt,
      endAt: e.endAt,
      location: e.location ?? null,
      description: e.description ?? null,
      status: e.status ?? null,
      syncedAt: now.toISOString(),
    };
    if (existing) d.update(schema.calendarEvents).set(values).where(eq(schema.calendarEvents.id, existing.id)).run();
    else d.insert(schema.calendarEvents).values(values).run();
  }
  // 期間内でカレンダーから消えたものは削除
  const cached = d.select().from(schema.calendarEvents).where(and(gt(schema.calendarEvents.startAt, from.toISOString()), lt(schema.calendarEvents.startAt, to.toISOString()))).all();
  for (const c of cached) if (!seen.has(c.googleEventId) && !isLocalEventId(c.googleEventId)) d.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, c.id)).run();
  // 事件の次回期日キャッシュ更新
  const cases = d.select().from(schema.cases).where(inArray(schema.cases.status, OPEN_CASE_STATUSES)).all();
  for (const c of cases) {
    const next = d
      .select()
      .from(schema.calendarEvents)
      .where(and(eq(schema.calendarEvents.caseId, c.id), eq(schema.calendarEvents.kind, 'hearing'), gt(schema.calendarEvents.startAt, now.toISOString())))
      .orderBy(schema.calendarEvents.startAt)
      .get();
    d.update(schema.cases).set({ nextHearingAt: next?.startAt ?? null }).where(eq(schema.cases.id, c.id)).run();
  }
  return { synced: events.length };
}

/** 終了した期日・打合せについて、次回期日の有無を確認 */
export function checkPostEvents(): number {
  const d = db();
  const now = new Date().toISOString();
  const ended = d
    .select()
    .from(schema.calendarEvents)
    .where(and(inArray(schema.calendarEvents.kind, ['hearing', 'meeting']), lt(schema.calendarEvents.endAt, now), eq(schema.calendarEvents.processedPostEvent, false)))
    .all();
  let n = 0;
  for (const ev of ended) {
    d.update(schema.calendarEvents).set({ processedPostEvent: true }).where(eq(schema.calendarEvents.id, ev.id)).run();
    if (!ev.clientId && !ev.caseId) continue; // 依頼者不明のイベントは対象外
    const conds = [eq(schema.calendarEvents.kind, 'hearing'), gt(schema.calendarEvents.startAt, ev.endAt)];
    if (ev.caseId) conds.push(eq(schema.calendarEvents.caseId, ev.caseId));
    else conds.push(eq(schema.calendarEvents.clientId, ev.clientId!));
    const next = d.select().from(schema.calendarEvents).where(and(...conds)).orderBy(schema.calendarEvents.startAt).get();
    const client = ev.clientId ? d.select().from(schema.clients).where(eq(schema.clients.id, ev.clientId)).get() : null;
    const kase = ev.caseId ? d.select().from(schema.cases).where(eq(schema.cases.id, ev.caseId)).get() : null;
    if (ev.kind === 'hearing' && kase) {
      d.insert(schema.caseNotes)
        .values({ caseId: kase.id, clientId: ev.clientId, kind: 'court', occurredAt: ev.startAt, counterpart: ev.location ?? null, rawText: ev.title, gist: `${ev.title}（${formatJaDateTime(new Date(ev.startAt))}）`, createdBy: 'system' })
        .run();
    }
    if (next) continue;
    upsertAlert({
      type: 'next_hearing_missing',
      dedupeKey: `next_hearing_missing:${ev.googleEventId}`,
      title: `次回期日が未入力: ${client?.name ?? ''} ${ev.title}`,
      body: `${formatJaDateTime(new Date(ev.startAt))} の${ev.kind === 'hearing' ? '期日' : '打合せ'}が終了しましたが、次回期日がカレンダーにありません。入力漏れがないか確認してください。`,
      payload: { calendarEventId: ev.id, googleEventId: ev.googleEventId, clientId: ev.clientId, caseId: ev.caseId, endedAt: ev.endAt, title: ev.title },
    });
    n++;
  }
  return n;
}

/** アラートから次回期日を登録／未定にする */
export async function resolveNextHearing(input: NextHearingInput): Promise<{ eventId?: string }> {
  const alert = db().select().from(schema.alerts).where(eq(schema.alerts.id, input.alertId)).get();
  if (!alert) throw new Error('アラートが見つかりません');
  const p = alert.payload as { clientId?: number | null; caseId?: number | null; title?: string };
  if (input.decision === 'undecided') {
    resolveAlert(alert.id, 'dismissed');
    return {};
  }
  if (!input.startAt) throw new Error('日時が必要です');
  const client = p.clientId ? db().select().from(schema.clients).where(eq(schema.clients.id, p.clientId)).get() : null;
  const startAt = new Date(input.startAt);
  const endAt = new Date(startAt.getTime() + input.durationMinutes * 60_000);
  const title = input.title ?? (client ? `${familyName(client.name)} 期日` : p.title ?? '期日');
  const ev = await cal.createEvent({ title, startAt, endAt, location: input.location ?? null, tag: { clientId: p.clientId ?? null, caseId: p.caseId ?? null, kind: 'hearing' } });
  db().insert(schema.calendarEvents)
    .values({ googleEventId: ev.id, clientId: p.clientId ?? null, caseId: p.caseId ?? null, kind: 'hearing', title, startAt: ev.startAt, endAt: ev.endAt, location: input.location ?? null, status: 'confirmed' })
    .onConflictDoNothing()
    .run();
  if (p.caseId) db().update(schema.cases).set({ nextHearingAt: ev.startAt }).where(eq(schema.cases.id, p.caseId)).run();
  resolveAlert(alert.id);
  return { eventId: ev.id };
}

/** 期日報告用: 依頼者フォルダの提出書面（直近更新順） */
export async function listCourtDocs(clientId: number, opts: { days?: number } = {}) {
  const client = db().select().from(schema.clients).where(eq(schema.clients.id, clientId)).get();
  if (!client) throw new Error('依頼者が見つかりません');
  const base = clientFolder(client);
  const sub = getSetting('court_docs_subfolder');
  const folders = [joinPath(base, sub), base];
  const out: { name: string; path: string; itemId?: string; modifiedAt?: string; size?: number; folder: string }[] = [];
  for (const f of folders) {
    try {
      const items = await storage().list(f);
      for (const i of items) {
        if (i.isFolder) continue;
        if (!/\.(pdf|docx?|xlsx?|jpe?g|png)$/i.test(i.name)) continue;
        out.push({ name: i.name, path: i.path, itemId: i.itemId, modifiedAt: i.modifiedAt, size: i.size, folder: f });
      }
    } catch (err) {
      logger.debug({ err, folder: f }, 'フォルダ一覧の取得をスキップ');
    }
  }
  const days = opts.days ?? 0;
  const cutoff = days ? Date.now() - days * 86400_000 : 0;
  return out
    .filter((x) => !cutoff || !x.modifiedAt || new Date(x.modifiedAt).getTime() >= cutoff)
    .sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''));
}

export function upcomingEvents(days = 14) {
  const now = new Date();
  const to = new Date(now.getTime() + days * 86400_000);
  return db()
    .select({ ev: schema.calendarEvents, clientName: schema.clients.name })
    .from(schema.calendarEvents)
    .leftJoin(schema.clients, eq(schema.clients.id, schema.calendarEvents.clientId))
    .where(and(gt(schema.calendarEvents.startAt, now.toISOString()), lt(schema.calendarEvents.startAt, to.toISOString())))
    .orderBy(schema.calendarEvents.startAt)
    .all()
    .map((r) => ({ ...r.ev, clientName: r.clientName ?? null }));
}

export function todaysEvents() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600_000);
  const start = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()) - 9 * 3600_000);
  const end = new Date(start.getTime() + 86400_000);
  return db()
    .select({ ev: schema.calendarEvents, clientName: schema.clients.name })
    .from(schema.calendarEvents)
    .leftJoin(schema.clients, eq(schema.clients.id, schema.calendarEvents.clientId))
    .where(and(gt(schema.calendarEvents.startAt, start.toISOString()), lt(schema.calendarEvents.startAt, end.toISOString())))
    .orderBy(schema.calendarEvents.startAt)
    .all()
    .map((r) => ({ ...r.ev, clientName: r.clientName ?? null }));
}

export function relinkEvent(id: number, patch: { clientId?: number | null; caseId?: number | null; kind?: EventKind }) {
  db().update(schema.calendarEvents).set(patch).where(eq(schema.calendarEvents.id, id)).run();
  resolveAlertsByKeyPrefix(`next_hearing_missing:`);
}

// ---- 予定の一覧・登録・編集・削除（Google カレンダーと連動。未接続ならアプリ内だけに保存） ----

/** Google に無いアプリ内だけの予定（未接続時に登録したもの・デモ）か */
export function isLocalEventId(googleEventId: string): boolean {
  return googleEventId.startsWith('local-') || googleEventId.startsWith('demo-');
}

export function listCalendarEvents(from: Date, to: Date, filter: { clientId?: number; caseId?: number } = {}) {
  const conds = [gt(schema.calendarEvents.endAt, from.toISOString()), lt(schema.calendarEvents.startAt, to.toISOString())];
  if (filter.clientId) conds.push(eq(schema.calendarEvents.clientId, filter.clientId));
  if (filter.caseId) conds.push(eq(schema.calendarEvents.caseId, filter.caseId));
  // 日程調整中の仮押さえは、どのセッションの候補かを付ける（確定・取消をカレンダーから行うため）
  const sessionByEvent = new Map<string, { id: number; count: number }>();
  for (const s of db().select().from(schema.schedulingSessions).where(eq(schema.schedulingSessions.state, 'proposing')).all()) {
    const withEvent = s.candidates.filter((c) => c.eventId);
    for (const c of withEvent) sessionByEvent.set(c.eventId!, { id: s.id, count: withEvent.length });
  }
  return db()
    .select({ ev: schema.calendarEvents, clientName: schema.clients.name, caseTitle: schema.cases.title })
    .from(schema.calendarEvents)
    .leftJoin(schema.clients, eq(schema.clients.id, schema.calendarEvents.clientId))
    .leftJoin(schema.cases, eq(schema.cases.id, schema.calendarEvents.caseId))
    .where(and(...conds))
    .orderBy(schema.calendarEvents.startAt)
    .all()
    .map((r) => {
      const sess = sessionByEvent.get(r.ev.googleEventId);
      return { ...r.ev, clientName: r.clientName ?? null, caseTitle: r.caseTitle ?? null, local: isLocalEventId(r.ev.googleEventId), sessionId: sess?.id ?? null, sessionCandidates: sess?.count ?? 0 };
    });
}

export interface CalendarEventInput {
  title: string;
  startAt: string;
  endAt: string;
  kind: EventKind;
  clientId?: number | null;
  caseId?: number | null;
  location?: string | null;
  description?: string | null;
  tentative?: boolean;
}

function assertRange(startAt: string, endAt: string) {
  const s = new Date(startAt);
  const e = new Date(endAt);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) throw new Error('日時の形式が不正です');
  if (e.getTime() <= s.getTime()) throw new Error('終了は開始より後にしてください');
  return { s, e };
}

/** 事件の次回期日キャッシュを、その事件の今後の期日から更新 */
function refreshNextHearing(caseId: number | null | undefined) {
  if (!caseId) return;
  const next = db()
    .select()
    .from(schema.calendarEvents)
    .where(and(eq(schema.calendarEvents.caseId, caseId), eq(schema.calendarEvents.kind, 'hearing'), gt(schema.calendarEvents.startAt, new Date().toISOString())))
    .orderBy(schema.calendarEvents.startAt)
    .get();
  db().update(schema.cases).set({ nextHearingAt: next?.startAt ?? null }).where(eq(schema.cases.id, caseId)).run();
}

export async function createCalendarEvent(input: CalendarEventInput) {
  const { s, e } = assertRange(input.startAt, input.endAt);
  const title = input.title.trim();
  if (!title) throw new Error('件名を入力してください');
  const tag = { clientId: input.clientId ?? null, caseId: input.caseId ?? null, kind: input.kind };
  let googleEventId = `local-${randomUUID()}`;
  let startAt = s.toISOString();
  let endAt = e.toISOString();
  if (isGoogleConnected()) {
    const ev = await cal.createEvent({ title, startAt: s, endAt: e, location: input.location ?? null, description: input.description ?? null, tentative: input.tentative, tag });
    googleEventId = ev.id;
    startAt = ev.startAt;
    endAt = ev.endAt;
  }
  const row = db()
    .insert(schema.calendarEvents)
    .values({ googleEventId, clientId: tag.clientId, caseId: tag.caseId, kind: input.kind, title, startAt, endAt, location: input.location ?? null, description: input.description ?? null, status: input.tentative ? 'tentative' : 'confirmed' })
    .returning()
    .get();
  refreshNextHearing(tag.caseId);
  if (input.kind === 'hearing') resolveAlertsByKeyPrefix('next_hearing_missing:');
  logger.info({ id: row.id, google: !isLocalEventId(googleEventId) }, '予定を登録しました');
  return row;
}

export async function editCalendarEvent(id: number, patch: Partial<CalendarEventInput>) {
  const row = db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id)).get();
  if (!row) throw new Error('予定が見つかりません');
  const startAt = patch.startAt ?? row.startAt;
  const endAt = patch.endAt ?? row.endAt;
  const { s, e } = assertRange(startAt, endAt);
  const title = (patch.title ?? row.title).trim();
  if (!title) throw new Error('件名を入力してください');
  const kind = patch.kind ?? (row.kind as EventKind);
  const clientId = patch.clientId !== undefined ? patch.clientId : row.clientId;
  const caseId = patch.caseId !== undefined ? patch.caseId : row.caseId;
  const location = patch.location !== undefined ? patch.location : row.location;
  const description = patch.description !== undefined ? patch.description : row.description;
  const tentative = patch.tentative !== undefined ? patch.tentative : row.status === 'tentative';
  if (!isLocalEventId(row.googleEventId) && isGoogleConnected()) {
    await cal.updateEvent(row.googleEventId, { title, startAt: s, endAt: e, location: location ?? '', description: description ?? '', tentative, tag: { clientId, caseId, kind } });
  }
  db()
    .update(schema.calendarEvents)
    .set({ title, kind, clientId, caseId, startAt: s.toISOString(), endAt: e.toISOString(), location: location ?? null, description: description ?? null, status: tentative ? 'tentative' : 'confirmed' })
    .where(eq(schema.calendarEvents.id, id))
    .run();
  refreshNextHearing(row.caseId);
  if (caseId !== row.caseId) refreshNextHearing(caseId);
  return db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id)).get();
}

export async function removeCalendarEvent(id: number) {
  const row = db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id)).get();
  if (!row) return;
  if (!isLocalEventId(row.googleEventId) && isGoogleConnected()) await cal.deleteEvent(row.googleEventId);
  db().delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, id)).run();
  refreshNextHearing(row.caseId);
}

// ---- 複数候補の仮押さえ（日程調整セッションとして管理。1 つを確定すると残りを削除） ----

export interface HoldSetInput {
  /** 予定の内容（例: 打合せ、WEB相談）。件名は「{姓} {内容} 仮」になる */
  title: string;
  kind: EventKind;
  clientId?: number | null;
  caseId?: number | null;
  /** 依頼者を選ばない場合の相手の名前（件名の先頭に付ける） */
  counterpartName?: string | null;
  location?: string | null;
  description?: string | null;
  slots: { startAt: string; endAt: string }[];
}

function holdSetTitle(input: HoldSetInput, clientName: string | null): { hold: string; confirmed: string } {
  const who = clientName ? familyName(clientName) : (input.counterpartName ?? '').trim();
  const content = input.title.trim();
  const base = [who, content].filter(Boolean).join(' ');
  return { hold: base.endsWith('仮') ? base : `${base} 仮`, confirmed: base.replace(/\s*仮$/, '') };
}

export async function createHoldSet(input: HoldSetInput) {
  if (!input.slots.length) throw new Error('候補日時を 1 つ以上入れてください');
  if (!input.title.trim()) throw new Error('内容を入力してください');
  const client = input.clientId ? db().select().from(schema.clients).where(eq(schema.clients.id, input.clientId)).get() : null;
  const titles = holdSetTitle(input, client?.name ?? null);
  const sorted = [...input.slots].sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  for (const sl of sorted) assertRange(sl.startAt, sl.endAt);
  const session = db()
    .insert(schema.schedulingSessions)
    .values({ clientId: client?.id ?? null, conversationId: null, kind: input.kind === 'hearing' ? '期日' : input.kind === 'consult' ? '面談' : '打合せ', state: 'proposing', candidates: [], proposedAt: new Date().toISOString() })
    .returning()
    .get();
  const candidates: { startAt: string; endAt: string; eventId?: string }[] = [];
  const events = [];
  for (const sl of sorted) {
    const row = await createCalendarEvent({
      title: titles.hold,
      startAt: sl.startAt,
      endAt: sl.endAt,
      kind: 'hold',
      clientId: client?.id ?? null,
      caseId: input.caseId ?? null,
      location: input.location ?? null,
      description: [input.description ?? '', `日程調整中（アプリで管理: セッション ${session.id}）`].filter(Boolean).join('\n'),
      tentative: true,
    });
    candidates.push({ startAt: row.startAt, endAt: row.endAt, eventId: row.googleEventId });
    events.push(row);
  }
  db()
    .update(schema.schedulingSessions)
    .set({ candidates, updatedAt: new Date().toISOString() })
    .where(eq(schema.schedulingSessions.id, session.id))
    .run();
  // 確定後の種別と件名を後で使えるようにメモしておく（zoom 列は使っていないので流用しない。description に残す）
  holdMeta.set(session.id, { kind: input.kind, confirmedTitle: titles.confirmed });
  logger.info({ sessionId: session.id, slots: events.length }, '複数候補の仮押さえを登録しました');
  return { sessionId: session.id, events };
}

/** セッション作成時の確定後情報（再起動で消えても件名から復元できる） */
const holdMeta = new Map<number, { kind: EventKind; confirmedTitle: string }>();

/** 候補のうち 1 つを確定。残りの仮押さえを削除し、選んだ予定を確定に切り替える */
export async function confirmHold(sessionId: number, eventId: number) {
  const session = db().select().from(schema.schedulingSessions).where(eq(schema.schedulingSessions.id, sessionId)).get();
  if (!session) throw new Error('日程調整が見つかりません');
  if (session.state !== 'proposing') throw new Error('この日程調整はすでに確定または取消されています');
  const chosen = db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId)).get();
  if (!chosen || !session.candidates.some((c) => c.eventId === chosen.googleEventId)) throw new Error('選んだ予定はこの日程調整の候補ではありません');
  for (const c of session.candidates) {
    if (!c.eventId || c.eventId === chosen.googleEventId) continue;
    const row = db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.googleEventId, c.eventId)).get();
    if (row) await removeCalendarEvent(row.id);
    else if (!isLocalEventId(c.eventId) && isGoogleConnected()) await cal.deleteEvent(c.eventId);
  }
  const meta = holdMeta.get(sessionId);
  const kind: EventKind = meta?.kind ?? (session.kind === '期日' ? 'hearing' : session.kind === '面談' || session.kind === 'WEB' ? 'consult' : 'meeting');
  const title = meta?.confirmedTitle ?? chosen.title.replace(/\s*仮$/, '');
  const description = (chosen.description ?? '').replace(/\n?日程調整中（アプリで管理: セッション \d+）/, '').trim() || null;
  const updated = await editCalendarEvent(chosen.id, { title, kind, tentative: false, description });
  db()
    .update(schema.schedulingSessions)
    .set({ state: 'confirmed', confirmedEventId: chosen.googleEventId, confirmedStartAt: chosen.startAt, updatedAt: new Date().toISOString() })
    .where(eq(schema.schedulingSessions.id, sessionId))
    .run();
  holdMeta.delete(sessionId);
  resolveAlertsByKeyPrefix(`scheduling_stale:${sessionId}`);
  return updated;
}

/** 仮押さえをすべて取り消す */
export async function cancelHoldSet(sessionId: number) {
  const session = db().select().from(schema.schedulingSessions).where(eq(schema.schedulingSessions.id, sessionId)).get();
  if (!session) throw new Error('日程調整が見つかりません');
  for (const c of session.candidates) {
    if (!c.eventId) continue;
    const row = db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.googleEventId, c.eventId)).get();
    if (row) await removeCalendarEvent(row.id);
    else if (!isLocalEventId(c.eventId) && isGoogleConnected()) await cal.deleteEvent(c.eventId);
  }
  db().update(schema.schedulingSessions).set({ state: 'cancelled', updatedAt: new Date().toISOString() }).where(eq(schema.schedulingSessions.id, sessionId)).run();
  holdMeta.delete(sessionId);
  resolveAlertsByKeyPrefix(`scheduling_stale:${sessionId}`);
}
