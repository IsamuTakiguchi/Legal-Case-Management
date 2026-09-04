import { and, eq, desc, gt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { generateStructured, generateText } from '../integrations/anthropic.js';
import { formatJaDateTime, type CaseInput, type CaseNoteInput, WAITING_FOR, CASE_NOTE_KIND_LABEL, type CaseNoteKind } from '@lcm/shared';
import { createTask } from './tasks.js';

export type CaseRow = typeof schema.cases.$inferSelect;

export function listCaseTypes() {
  return db().select().from(schema.caseTypes).orderBy(schema.caseTypes.sortOrder).all();
}

export function upsertCaseType(ct: { key: string; label: string; sortOrder?: number; hasCreditors?: boolean; creditorStages?: string[] }) {
  const cur = db().select().from(schema.caseTypes).where(eq(schema.caseTypes.key, ct.key)).get();
  if (cur) {
    db().update(schema.caseTypes)
      .set({ label: ct.label, sortOrder: ct.sortOrder ?? cur.sortOrder, hasCreditors: ct.hasCreditors ?? cur.hasCreditors, creditorStages: ct.creditorStages ?? cur.creditorStages })
      .where(eq(schema.caseTypes.key, ct.key))
      .run();
  } else {
    db().insert(schema.caseTypes).values({ key: ct.key, label: ct.label, sortOrder: ct.sortOrder ?? 99, hasCreditors: ct.hasCreditors ?? false, creditorStages: ct.creditorStages ?? [] }).run();
  }
}

export function createCase(input: CaseInput & { caseType?: string; stage?: string | null; policy?: string | null }): CaseRow {
  return db()
    .insert(schema.cases)
    .values({
      clientId: input.clientId,
      caseType: input.caseType ?? 'general_civil',
      title: input.title,
      courtName: input.courtName ?? null,
      caseNumber: input.caseNumber ?? null,
      status: input.status,
      stage: input.stage ?? null,
      policy: input.policy ?? null,
    })
    .returning()
    .get();
}

export function updateCase(id: number, patch: Partial<CaseInput & { caseType: string; stage: string | null; policy: string | null }>): CaseRow {
  const cur = db().select().from(schema.cases).where(eq(schema.cases.id, id)).get();
  if (!cur) throw new Error('事件が見つかりません');
  const now = new Date().toISOString();
  const set: Partial<typeof schema.cases.$inferInsert> = { updatedAt: now };
  for (const k of ['title', 'courtName', 'caseNumber', 'status', 'caseType', 'stage'] as const) {
    if (patch[k] !== undefined) (set as Record<string, unknown>)[k] = patch[k] ?? null;
  }
  if (patch.policy !== undefined && patch.policy !== cur.policy) {
    set.policy = patch.policy ?? null;
    set.policyUpdatedAt = now;
    db().insert(schema.caseNotes)
      .values({ caseId: id, clientId: cur.clientId, kind: 'policy', occurredAt: now, rawText: cur.policy ?? '', gist: '方針を更新', createdBy: 'user' })
      .run();
  }
  db().update(schema.cases).set(set).where(eq(schema.cases.id, id)).run();
  return db().select().from(schema.cases).where(eq(schema.cases.id, id)).get()!;
}

export function listCases(filter: { clientId?: number; status?: string }) {
  const conds = [];
  if (filter.clientId) conds.push(eq(schema.cases.clientId, filter.clientId));
  if (filter.status) conds.push(eq(schema.cases.status, filter.status));
  return db()
    .select({ c: schema.cases, clientName: schema.clients.name, caseTypeLabel: schema.caseTypes.label, hasCreditors: schema.caseTypes.hasCreditors })
    .from(schema.cases)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.cases.clientId))
    .leftJoin(schema.caseTypes, eq(schema.caseTypes.key, schema.cases.caseType))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.cases.updatedAt))
    .all()
    .map((r) => ({ ...r.c, clientName: r.clientName, caseTypeLabel: r.caseTypeLabel ?? r.c.caseType, hasCreditors: !!r.hasCreditors }));
}

export function getCase(id: number) {
  const c = db().select().from(schema.cases).where(eq(schema.cases.id, id)).get();
  if (!c) return null;
  const client = db().select().from(schema.clients).where(eq(schema.clients.id, c.clientId)).get();
  const caseType = db().select().from(schema.caseTypes).where(eq(schema.caseTypes.key, c.caseType)).get();
  const notes = db().select().from(schema.caseNotes).where(eq(schema.caseNotes.caseId, id)).orderBy(desc(schema.caseNotes.occurredAt)).all();
  const tasks = db().select().from(schema.tasks).where(eq(schema.tasks.caseId, id)).orderBy(desc(schema.tasks.updatedAt)).all();
  const events = db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.caseId, id)).orderBy(desc(schema.calendarEvents.startAt)).all();
  const conversations = client ? db().select().from(schema.conversations).where(eq(schema.conversations.clientId, client.id)).orderBy(desc(schema.conversations.lastMessageAt)).all() : [];
  return { ...c, client, caseType, notes, tasks, events, conversations };
}

/** タイムライン: ノート＋メッセージ＋カレンダー＋タスク完了を時系列に */
export function caseTimeline(id: number, limit = 200) {
  const c = db().select().from(schema.cases).where(eq(schema.cases.id, id)).get();
  if (!c) return [];
  type Item = { at: string; type: string; title: string; body?: string | null; ref?: Record<string, unknown> };
  const items: Item[] = [];
  for (const n of db().select().from(schema.caseNotes).where(eq(schema.caseNotes.caseId, id)).all()) {
    items.push({ at: n.occurredAt, type: `note:${n.kind}`, title: `${CASE_NOTE_KIND_LABEL[n.kind as CaseNoteKind] ?? n.kind}${n.counterpart ? ` / ${n.counterpart}` : ''}`, body: n.gist ?? n.rawText, ref: { noteId: n.id } });
  }
  const convs = db().select().from(schema.conversations).where(eq(schema.conversations.clientId, c.clientId)).all();
  const convIds = convs.map((x) => x.id);
  if (convIds.length) {
    const msgs = db().select().from(schema.messages).where(inArray(schema.messages.conversationId, convIds)).orderBy(desc(schema.messages.sentAt)).limit(limit).all();
    for (const m of msgs) items.push({ at: m.sentAt, type: `message:${m.direction}`, title: `${m.direction === 'in' ? '受信' : '送信'}（${m.channel}）${m.senderName ? ` ${m.senderName}` : ''}`, body: m.body.slice(0, 200), ref: { conversationId: m.conversationId, messageId: m.id } });
  }
  for (const e of db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.caseId, id)).all()) {
    items.push({ at: e.startAt, type: `event:${e.kind}`, title: e.title, body: e.location, ref: { eventId: e.id } });
  }
  for (const t of db().select().from(schema.tasks).where(eq(schema.tasks.caseId, id)).all()) {
    if (t.completedAt) items.push({ at: t.completedAt, type: 'task:done', title: `完了: ${t.title}`, ref: { taskId: t.id } });
  }
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

const phoneMemoSchema = z.object({
  gist: z.string().describe('要旨（2〜3 文）'),
  decisions: z.array(z.string()).describe('決定事項・合意事項'),
  nextActions: z.array(z.object({ title: z.string(), due: z.string().nullable().describe('期限 YYYY-MM-DD。不明なら null'), owner: z.enum(['self', 'client', 'counterpart', 'court', 'other']) })),
  waitingFor: z.enum(WAITING_FOR).describe('この後、誰の対応待ちになるか'),
  counterpart: z.string().nullable().describe('通話相手（メモから分かれば）'),
});

/** 走り書きのメモを要旨・決定事項・次のアクションに整理 */
export async function structureNote(rawText: string, ctx: { caseTitle?: string; clientName?: string; kind: string; counterpart?: string | null }) {
  const today = formatJaDateTime(new Date()).replace(/\d+時.*$/, '');
  return generateStructured({
    system: '法律事務所の事務補助者として、弁護士の走り書きメモを整理します。事実の創作はせず、メモにある内容だけを使います。日付は今日を基準に解釈します。',
    user: `今日: ${today}\n事件: ${ctx.caseTitle ?? '不明'}\n依頼者: ${ctx.clientName ?? '不明'}\n種別: ${ctx.kind}\n相手: ${ctx.counterpart ?? '（メモから判断）'}\n\nメモ:\n${rawText}`,
    schema: phoneMemoSchema,
    effort: 'low',
    maxTokens: 2000,
  });
}

export async function addCaseNote(input: CaseNoteInput, opts: { structure?: boolean; createTasks?: boolean } = {}) {
  const c = db().select().from(schema.cases).where(eq(schema.cases.id, input.caseId)).get();
  if (!c) throw new Error('事件が見つかりません');
  const client = db().select().from(schema.clients).where(eq(schema.clients.id, c.clientId)).get();
  let gist = input.gist ?? null;
  let decisions = input.decisions;
  let nextActions = input.nextActions;
  let waitingFor = input.waitingFor ?? null;
  let counterpart = input.counterpart ?? null;
  if (opts.structure && input.rawText.trim()) {
    const s = await structureNote(input.rawText, { caseTitle: c.title, clientName: client?.name, kind: input.kind, counterpart });
    gist = s.gist;
    decisions = s.decisions;
    nextActions = s.nextActions.map((a) => ({ title: a.title, due: a.due }));
    waitingFor = s.waitingFor;
    counterpart = counterpart ?? s.counterpart ?? null;
  }
  const row = db()
    .insert(schema.caseNotes)
    .values({
      caseId: input.caseId,
      clientId: c.clientId,
      kind: input.kind,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      counterpart,
      rawText: input.rawText,
      gist,
      decisions,
      nextActions,
      waitingFor,
      attachments: input.attachments,
      createdBy: opts.structure ? 'ai' : 'user',
    })
    .returning()
    .get();
  if (opts.createTasks && nextActions.length) {
    const updated: typeof nextActions = [];
    for (const a of nextActions) {
      const status = waitingFor === 'client' ? 'waiting_client' : waitingFor && waitingFor !== 'none' ? 'waiting_other' : 'open';
      const t = await createTask({ title: a.title, clientId: c.clientId, caseId: c.id, conversationId: null, status, followUpAt: a.due ? new Date(`${a.due}T09:00:00+09:00`).toISOString() : null, note: gist, syncToChatwork: false });
      updated.push({ ...a, taskId: t.id });
    }
    db().update(schema.caseNotes).set({ nextActions: updated }).where(eq(schema.caseNotes.id, row.id)).run();
    return { ...row, nextActions: updated };
  }
  db().update(schema.cases).set({ updatedAt: new Date().toISOString() }).where(eq(schema.cases.id, c.id)).run();
  return row;
}

export function deleteCaseNote(id: number) {
  db().delete(schema.caseNotes).where(eq(schema.caseNotes.id, id)).run();
}

/** 進捗サマリーを生成 */
export async function generateCaseSummary(id: number): Promise<string> {
  const c = getCase(id);
  if (!c) throw new Error('事件が見つかりません');
  const timeline = caseTimeline(id, 60);
  const openTasks = c.tasks.filter((t) => t.status !== 'done');
  const upcoming = c.events.filter((e) => e.startAt > new Date().toISOString());
  const md = await generateText({
    system: '法律事務所の事務補助者として、事件の現状を弁護士向けに簡潔にまとめます。事実の創作はせず、与えられた記録だけを根拠にします。Markdown で「現状」「直近の動き」「未了事項」「推奨される次の一手」の 4 見出し、全体で 500 字程度。',
    user: `事件: ${c.title}（${c.caseType?.label ?? c.caseType}）\n依頼者: ${c.client?.name}\n裁判所・事件番号: ${c.courtName ?? ''} ${c.caseNumber ?? ''}\n現在の段階: ${c.stage ?? '未設定'}\n方針メモ: ${c.policy ?? '（なし）'}\n次回期日: ${c.nextHearingAt ? formatJaDateTime(new Date(c.nextHearingAt)) : '未定'}\n\n未了タスク:\n${openTasks.map((t) => `- [${t.status}] ${t.title}`).join('\n') || '（なし）'}\n\n今後の予定:\n${upcoming.map((e) => `- ${formatJaDateTime(new Date(e.startAt))} ${e.title}`).join('\n') || '（なし）'}\n\n記録（新しい順）:\n${timeline.map((t) => `- ${t.at.slice(0, 10)} [${t.type}] ${t.title}${t.body ? `: ${String(t.body).slice(0, 200)}` : ''}`).join('\n')}`,
    effort: 'medium',
    maxTokens: 3000,
  });
  db().update(schema.cases).set({ summary: md, summaryGeneratedAt: new Date().toISOString() }).where(eq(schema.cases.id, id)).run();
  return md;
}

export function activeCasesForClient(clientId: number) {
  return db().select().from(schema.cases).where(and(eq(schema.cases.clientId, clientId), eq(schema.cases.status, 'active'))).orderBy(desc(schema.cases.updatedAt)).all();
}

export function casesNeedingSummary(days = 7) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  return db().select().from(schema.cases).where(eq(schema.cases.status, 'active')).all().filter((c) => !c.summaryGeneratedAt || c.summaryGeneratedAt < cutoff).filter((c) => c.updatedAt > (c.summaryGeneratedAt ?? '') || !c.summaryGeneratedAt);
}

export { gt };
