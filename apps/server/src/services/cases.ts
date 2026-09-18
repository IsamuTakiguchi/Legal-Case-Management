import { and, eq, desc, gt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { generateStructured, generateText } from '../integrations/anthropic.js';
import { formatJaDateTime, type CaseInput, type CaseNoteInput, WAITING_FOR, CASE_NOTE_KIND_LABEL, type CaseNoteKind, OPEN_CASE_STATUSES, CASE_CONTACT_ROLE_LABEL, type CaseContactRole, type TaskStatus } from '@lcm/shared';
import { createTask } from './tasks.js';
import { syncClientFolderWithStatus } from './clientFolders.js';
import { logger } from '../logger.js';

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

export function createCase(input: CaseInput & { caseType?: string; stage?: string | null; policy?: string | null; staffId?: number | null; chatworkRoomId?: number | null }): CaseRow {
  const client = db().select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.id, input.clientId)).get();
  if (!client) throw new Error('依頼者が見つかりません');
  const row = db()
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
      staffId: input.staffId ?? null,
      chatworkRoomId: input.chatworkRoomId ?? null,
    })
    .returning()
    .get();
  // 区分フォルダ運用なら、依頼者フォルダの区分をこの事件に合わせる（例: 終了事件しかなかった依頼者に進行事件が増えた）
  setImmediate(() => {
    syncClientFolderWithStatus(input.clientId, row.id).catch((err) => logger.warn({ err, caseId: row.id }, '依頼者フォルダの区分合わせに失敗'));
  });
  return row;
}

export function updateCase(id: number, patch: Partial<CaseInput & { caseType: string; stage: string | null; policy: string | null; staffId: number | null; chatworkRoomId: number | null }>): CaseRow {
  const cur = db().select().from(schema.cases).where(eq(schema.cases.id, id)).get();
  if (!cur) throw new Error('事件が見つかりません');
  const now = new Date().toISOString();
  const set: Partial<typeof schema.cases.$inferInsert> = { updatedAt: now };
  for (const k of ['title', 'courtName', 'caseNumber', 'status', 'caseType', 'stage', 'staffId', 'chatworkRoomId'] as const) {
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
  if (patch.status !== undefined && patch.status !== cur.status) {
    // 区分フォルダ運用なら、依頼者フォルダを新しい区分へ移動（非同期・失敗してもログのみ）
    setImmediate(() => {
      syncClientFolderWithStatus(cur.clientId, id).catch((err) => logger.warn({ err, caseId: id }, '依頼者フォルダの移動に失敗'));
    });
  }
  return db().select().from(schema.cases).where(eq(schema.cases.id, id)).get()!;
}

export function listCases(filter: { clientId?: number; status?: string }) {
  const conds = [];
  if (filter.clientId) conds.push(eq(schema.cases.clientId, filter.clientId));
  // 'open' は終了以外（相談・進行事件・残務処理）
  if (filter.status === 'open') conds.push(inArray(schema.cases.status, OPEN_CASE_STATUSES));
  else if (filter.status) conds.push(eq(schema.cases.status, filter.status));
  return db()
    .select({ c: schema.cases, clientName: schema.clients.name, clientKana: schema.clients.kana, caseTypeLabel: schema.caseTypes.label, hasCreditors: schema.caseTypes.hasCreditors, staffName: schema.staffMembers.name })
    .from(schema.cases)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.cases.clientId))
    .leftJoin(schema.caseTypes, eq(schema.caseTypes.key, schema.cases.caseType))
    .leftJoin(schema.staffMembers, eq(schema.staffMembers.id, schema.cases.staffId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.cases.updatedAt))
    .all()
    .map((r) => ({ ...r.c, clientName: r.clientName, clientKana: r.clientKana, caseTypeLabel: r.caseTypeLabel ?? r.c.caseType, hasCreditors: !!r.hasCreditors, staffName: r.staffName ?? null }));
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
  const staff = c.staffId ? (db().select().from(schema.staffMembers).where(eq(schema.staffMembers.id, c.staffId)).get() ?? null) : null;
  const contacts = db().select().from(schema.caseContacts).where(eq(schema.caseContacts.caseId, id)).orderBy(schema.caseContacts.role, schema.caseContacts.name).all();
  const contactById = new Map(contacts.map((x) => [x.id, x]));
  return {
    ...c,
    client,
    caseType,
    notes,
    tasks,
    events,
    conversations: conversations.map((v) => ({ ...v, contact: v.contactId ? (contactById.get(v.contactId) ?? null) : null })),
    staff,
    contacts,
  };
}

/** タイムライン: ノート＋メッセージ＋カレンダー＋タスク完了を時系列に */
export function caseTimeline(id: number, limit = 200) {
  const c = db().select().from(schema.cases).where(eq(schema.cases.id, id)).get();
  if (!c) return [];
  type Item = { at: string; type: string; title: string; body?: string | null; ref?: Record<string, unknown> };
  const items: Item[] = [];
  for (const n of db().select().from(schema.caseNotes).where(eq(schema.caseNotes.caseId, id)).all()) {
    items.push({
      at: n.occurredAt,
      type: `note:${n.kind}`,
      title: `${CASE_NOTE_KIND_LABEL[n.kind as CaseNoteKind] ?? n.kind}${n.counterpart ? ` / ${n.counterpart}` : ''}`,
      body: n.gist ?? n.rawText,
      // 「誰の回答待ちか」はタイムラインでも見えるようにする
      ref: { noteId: n.id, waitingFor: n.waitingFor ?? null },
    });
  }
  // 依頼者本人との会話（他の事件の関係者との会話は除く）と、この事件の関係者との会話
  const convs = db()
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.clientId, c.clientId))
    .all()
    .filter((v) => !v.contactId || v.caseId === id);
  const contacts = db().select().from(schema.caseContacts).where(eq(schema.caseContacts.caseId, id)).all();
  const convTag = new Map(convs.filter((v) => v.contactId).map((v) => {
    const ct = contacts.find((x) => x.id === v.contactId);
    return [v.id, ct ? ` 〔${CASE_CONTACT_ROLE_LABEL[ct.role as CaseContactRole] ?? ct.role}: ${ct.name}〕` : ''];
  }));
  const convIds = convs.map((x) => x.id);
  // 依頼者に事件が複数あるときは、事件が決まったメッセージはその事件だけに出し、未確定のものは印を付けて各事件に出す
  const multiCase = db().select({ id: schema.cases.id }).from(schema.cases).where(eq(schema.cases.clientId, c.clientId)).all().length >= 2;
  const seen = new Set<number>();
  const pushMsg = (m: typeof schema.messages.$inferSelect, tag = '') => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    // 本文は長くなりがちなので一覧では 2000 字まで。超える分は「全文を表示」で /messages/:id/body から読む
    items.push({
      at: m.sentAt,
      type: `message:${m.direction}`,
      title: `${m.direction === 'in' ? '受信' : '送信'}（${m.channel}）${m.senderName ? ` ${m.senderName}` : ''}${tag}`,
      body: m.body.slice(0, 2000),
      ref: { conversationId: m.conversationId, messageId: m.id, caseId: m.caseId ?? null, unassignedCase: multiCase && !m.caseId, truncated: m.body.length > 2000 },
    });
  };
  if (convIds.length) {
    const msgs = db().select().from(schema.messages).where(inArray(schema.messages.conversationId, convIds)).orderBy(desc(schema.messages.sentAt)).limit(limit * 2).all();
    for (const m of msgs) {
      const contactConv = convTag.has(m.conversationId);
      if (!contactConv && multiCase && m.caseId && m.caseId !== id) continue; // 別の事件に振り分け済み
      const tag = contactConv ? (convTag.get(m.conversationId) ?? '') : multiCase && !m.caseId ? ' 〔事件未確定〕' : '';
      pushMsg(m, tag);
    }
  }
  // 事務局の伝言など、メッセージ単位でこの事件に紐付いたもの
  for (const m of db().select().from(schema.messages).where(eq(schema.messages.caseId, id)).orderBy(desc(schema.messages.sentAt)).limit(limit).all()) pushMsg(m, ' 伝言');
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
  theirSaid: z.array(z.string()).describe('相手が言ったこと・相手の主張や要望を、1 項目ずつ簡潔に。メモに無ければ空'),
  ourSaid: z.array(z.string()).describe('こちら（弁護士側）が言ったこと・伝えたこと・回答を、1 項目ずつ簡潔に。メモに無ければ空'),
  phone: z.string().nullable().describe('メモに電話番号があればそのまま（ハイフン付き）。無ければ null'),
  decisions: z.array(z.string()).describe('決定事項・合意事項'),
  nextActions: z
    .array(z.object({ title: z.string(), due: z.string().nullable().describe('期限 YYYY-MM-DD。不明なら null'), owner: z.enum(['self', 'client', 'counterpart', 'court', 'other']) }))
    .describe('タスクとして追いかける価値のある「次のアクション」だけを、多くても 3 件。細かい手順は 1 件にまとめる'),
  waitingFor: z.enum(WAITING_FOR).describe('この後、誰の対応待ちになるか'),
  counterpart: z.string().nullable().describe('通話相手（メモから分かれば）'),
});

/** 走り書きのメモを要旨・決定事項・次のアクションに整理 */
export async function structureNote(rawText: string, ctx: { caseTitle?: string; clientName?: string; kind: string; counterpart?: string | null; phone?: string | null }) {
  const today = formatJaDateTime(new Date()).replace(/\d+時.*$/, '');
  return generateStructured({
    purpose: '記録の整理（電話メモなど）',
    system: [
      '法律事務所の事務補助者として、弁護士の走り書きメモを整理します。事実の創作はせず、メモにある内容だけを使います。日付は今日を基準に解釈します。',
      '「相手が言ったこと」と「こちら（弁護士）が言ったこと」は必ず分けてください。「〜とのこと」「〜と言われた」「先方は〜」は相手の発言、「〜と伝えた」「〜と回答」「こちらからは〜」は自分の発言です。どちらか判然としない場合は文脈で判断し、決定事項と重複しても構いません。',
      '次のアクションは、弁護士がタスクとして追いかける単位で挙げます。細かく分けず、ひとまとまりの仕事は 1 件にします（例: 「依頼者に和解案を説明して意向を確認し、来週金曜までに相手方へ回答する」は 1 件）。多くても 3 件。決定事項の言い換えや、すでに終わったこと、「メモを残す」のような当然の作業は含めません。何も無ければ空にします。',
    ].join('\n'),
    user: `今日: ${today}\n事件: ${ctx.caseTitle ?? '不明'}\n依頼者: ${ctx.clientName ?? '不明'}\n種別: ${ctx.kind}\n相手: ${ctx.counterpart ?? '（メモから判断）'}\n電話番号: ${ctx.phone ?? '（メモから判断）'}\n\nメモ:\n${rawText}`,
    schema: phoneMemoSchema,
    effort: 'low',
    maxTokens: 2000,
  });
}

export interface AddNoteOptions {
  structure?: boolean;
  /** true / 'each': 次のアクションごとにタスク化。'single': 1 つのタスクにまとめる。false: 作らない */
  createTasks?: boolean | 'each' | 'single';
  /** タスク化する次のアクションの番号（0 始まり）。省略時はすべて */
  taskIndexes?: number[];
}

export async function addCaseNote(input: CaseNoteInput, opts: AddNoteOptions = {}) {
  const c = db().select().from(schema.cases).where(eq(schema.cases.id, input.caseId)).get();
  if (!c) throw new Error('事件が見つかりません');
  const client = db().select().from(schema.clients).where(eq(schema.clients.id, c.clientId)).get();
  let gist = input.gist ?? null;
  let decisions = input.decisions;
  let nextActions = input.nextActions;
  let waitingFor = input.waitingFor ?? null;
  let counterpart = input.counterpart ?? null;
  let phone = input.phone?.trim() || null;
  let theirSaid = input.theirSaid;
  let ourSaid = input.ourSaid;
  if (opts.structure && input.rawText.trim()) {
    const s = await structureNote(input.rawText, { caseTitle: c.title, clientName: client?.name, kind: input.kind, counterpart, phone });
    gist = s.gist;
    decisions = s.decisions;
    nextActions = s.nextActions.map((a) => ({ title: a.title, due: a.due }));
    waitingFor = s.waitingFor;
    counterpart = counterpart ?? s.counterpart ?? null;
    phone = phone ?? s.phone ?? null;
    theirSaid = s.theirSaid;
    ourSaid = s.ourSaid;
  }
  const row = db()
    .insert(schema.caseNotes)
    .values({
      caseId: input.caseId,
      clientId: c.clientId,
      kind: input.kind,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      counterpart,
      phone,
      rawText: input.rawText,
      gist,
      theirSaid,
      ourSaid,
      decisions,
      nextActions,
      waitingFor,
      attachments: input.attachments,
      createdBy: opts.structure ? 'ai' : 'user',
    })
    .returning()
    .get();
  const chosen = nextActions.map((a, i) => ({ a, i })).filter(({ i }) => !opts.taskIndexes || opts.taskIndexes.includes(i));
  if (opts.createTasks && chosen.length) {
    const status = waitingFor === 'client' ? 'waiting_client' : waitingFor && waitingFor !== 'none' ? 'waiting_other' : 'open';
    const dueIso = (due?: string | null) => (due ? new Date(`${due}T09:00:00+09:00`).toISOString() : null);
    const updated: typeof nextActions = nextActions.map((a) => ({ ...a }));
    if (opts.createTasks === 'single') {
      // 1 つのタスクにまとめる: 題名は先頭のアクション（複数なら「ほか n 件」）、メモに全アクションと要旨、期限は最も早いもの
      const first = chosen[0].a;
      const title = chosen.length === 1 ? first.title : `${first.title} ほか ${chosen.length - 1} 件`;
      const dues = chosen.map(({ a }) => a.due).filter((d): d is string => !!d).sort();
      const note = [chosen.map(({ a }) => `・${a.title}${a.due ? `（期限 ${a.due}）` : ''}`).join('\n'), gist ? `\n${gist}` : ''].join('\n').trim();
      const t = await createTask({ title, clientId: c.clientId, caseId: c.id, conversationId: null, status, followUpAt: dueIso(dues[0] ?? null), note, syncToChatwork: false });
      for (const { i } of chosen) updated[i] = { ...updated[i], taskId: t.id };
    } else {
      for (const { a, i } of chosen) {
        const t = await createTask({ title: a.title, clientId: c.clientId, caseId: c.id, conversationId: null, status, followUpAt: dueIso(a.due), note: gist, syncToChatwork: false });
        updated[i] = { ...updated[i], taskId: t.id };
      }
    }
    db().update(schema.caseNotes).set({ nextActions: updated }).where(eq(schema.caseNotes.id, row.id)).run();
    return { ...row, nextActions: updated };
  }
  db().update(schema.cases).set({ updatedAt: new Date().toISOString() }).where(eq(schema.cases.id, c.id)).run();
  return row;
}

const noteTaskSuggestionSchema = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().describe('タスク名。弁護士が見て何をするか分かる言い方で、40 字以内'),
        due: z.string().nullable().describe('期限 YYYY-MM-DD。記録から読み取れなければ null'),
        status: z.enum(['open', 'waiting_client', 'waiting_other']).describe('こちらが動くなら open、依頼者の返事待ちなら waiting_client、相手方・裁判所・保険会社などの待ちなら waiting_other'),
        note: z.string().describe('そのタスクのメモ（背景・決まったこと）。1〜2 文'),
      }),
    )
    .describe('追いかける価値のあるものだけ。多くても 4 件。何も無ければ空'),
  comment: z.string().describe('タスクにしなかったこと・注意点があれば 1 文。無ければ空'),
});

export type NoteTaskSuggestion = z.infer<typeof noteTaskSuggestionSchema>;

/**
 * 記録の内容から、登録するタスクの案を作る。
 * そのまま登録するのではなく、画面で直してから登録する前提の「たたき台」
 */
export async function suggestNoteTasks(noteId: number): Promise<NoteTaskSuggestion> {
  const d = db();
  const row = d.select().from(schema.caseNotes).where(eq(schema.caseNotes.id, noteId)).get();
  if (!row) throw new Error('記録が見つかりません');
  const kase = d.select().from(schema.cases).where(eq(schema.cases.id, row.caseId)).get();
  if (!kase) throw new Error('事件が見つかりません');
  const client = d.select().from(schema.clients).where(eq(schema.clients.id, kase.clientId)).get();
  // すでにあるタスクと同じものを出さないように渡す
  const open = d
    .select({ title: schema.tasks.title, status: schema.tasks.status })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.caseId, kase.id), inArray(schema.tasks.status, ['open', 'waiting_client', 'waiting_other'])))
    .all();
  const lines = [
    `今日: ${formatJaDateTime(new Date()).replace(/\d+時.*$/, '')}`,
    `事件: ${kase.title}（${kase.caseType}）`,
    `依頼者: ${client?.name ?? '不明'}`,
    `記録の種別: ${CASE_NOTE_KIND_LABEL[row.kind as CaseNoteKind] ?? row.kind}`,
    `記録の日時: ${formatJaDateTime(new Date(row.occurredAt))}`,
    row.counterpart ? `相手: ${row.counterpart}` : '',
    row.gist ? `要旨: ${row.gist}` : '',
    row.theirSaid.length ? `相手が言ったこと:\n${row.theirSaid.map((x) => `・${x}`).join('\n')}` : '',
    row.ourSaid.length ? `こちらが言ったこと:\n${row.ourSaid.map((x) => `・${x}`).join('\n')}` : '',
    row.decisions.length ? `決定事項:\n${row.decisions.map((x) => `・${x}`).join('\n')}` : '',
    row.nextActions.length ? `記録にある次のアクション:\n${row.nextActions.map((a) => `・${a.title}${a.due ? `（期限 ${dueDate(a.due)}）` : ''}${a.taskId ? '（タスク化済み）' : ''}`).join('\n')}` : '',
    row.waitingFor && row.waitingFor !== 'none' ? `待ち: ${row.waitingFor}` : '',
    `元メモ:\n${row.rawText ?? ''}`,
    open.length ? `この事件の未了タスク（重複させない）:\n${open.map((t) => `・${t.title}`).join('\n')}` : '',
  ].filter(Boolean);
  return generateStructured({
    purpose: '記録からのタスク案',
    system: [
      '法律事務所の事務補助者として、弁護士の記録（電話・打合せ・期日メモ）から、これから追いかけるタスクの案を作ります。記録に無いことは作りません。',
      'タスクは「弁護士や事務局が実際に手を動かす単位」で挙げます。細かい手順に分けず、ひとまとまりの仕事は 1 件にします。多くても 4 件。',
      'すでに終わったこと、決定事項の言い換え、「記録を残す」のような当然の作業、事件の未了タスクと同じ内容は挙げません。挙げるものが無ければ tasks は空にします。',
      '期限は記録から読み取れるときだけ入れます（「来週金曜まで」なども今日を基準に日付にします）。読み取れなければ null にします。',
      'タスク化済みと書かれている次のアクションは、もう一度挙げません。',
    ].join('\n'),
    user: lines.join('\n\n'),
    schema: noteTaskSuggestionSchema,
    effort: 'low',
    maxTokens: 2000,
  });
}

/** 保存済みの記録からタスクを作るときの指定 */
export interface NoteTaskInput {
  /** each = 次のアクションごと / single = まとめて 1 件 / custom = 題名で 1 件 / list = 画面で直した案をそのまま登録 */
  mode: 'each' | 'single' | 'custom' | 'list';
  /** list のとき登録するタスク（AI の案を直したもの） */
  tasks?: { title: string; due?: string | null; status?: TaskStatus; note?: string | null }[];
  /** each・single のとき、タスクにする「次のアクション」の番号（省略すると未タスク化のものすべて） */
  indexes?: number[];
  /** custom のときの題名 */
  title?: string | null;
  /** 期限（YYYY-MM-DD。省略するとアクションの期限、それも無ければ既定の日数後） */
  due?: string | null;
  status?: TaskStatus;
  note?: string | null;
  syncToChatwork?: boolean;
}

/** その記録の見出し（題名の既定値に使う） */
function noteHeadline(row: typeof schema.caseNotes.$inferSelect): string {
  const src = row.gist ?? row.rawText ?? '';
  const first = src.split('\n').map((l) => l.trim()).find(Boolean) ?? '記録';
  return first.slice(0, 80);
}

/** 期限は「2026-09-20」の形で持つが、古い記録には ISO が入っていることがある */
const dueDate = (due?: string | null) => (due ? due.slice(0, 10) : null);
const dueToIso = (due?: string | null) => {
  const d = dueDate(due);
  return d ? new Date(`${d}T09:00:00+09:00`).toISOString() : null;
};

/**
 * 保存済みの記録をタスクにする。
 * 「次のアクション」からでも、その場で書いた題名からでも作れる。
 * 作ったタスクは記録の「次のアクション」に控えるので、同じものを二重にタスク化しない。
 */
export async function createTasksFromNote(noteId: number, input: NoteTaskInput) {
  const d = db();
  const row = d.select().from(schema.caseNotes).where(eq(schema.caseNotes.id, noteId)).get();
  if (!row) throw new Error('記録が見つかりません');
  const kase = d.select().from(schema.cases).where(eq(schema.cases.id, row.caseId)).get();
  if (!kase) throw new Error('事件が見つかりません');
  const status: TaskStatus = input.status ?? (row.waitingFor === 'client' ? 'waiting_client' : row.waitingFor && row.waitingFor !== 'none' ? 'waiting_other' : 'open');
  const base = { clientId: kase.clientId, caseId: kase.id, conversationId: null, status, syncToChatwork: input.syncToChatwork ?? false };
  const actions = row.nextActions.map((a) => ({ ...a }));
  const created: { id: number; title: string }[] = [];

  if (input.mode === 'list') {
    const list = (input.tasks ?? []).map((t) => ({ ...t, title: t.title.trim() })).filter((t) => t.title);
    if (list.length === 0) throw new Error('登録するタスクがありません');
    for (const t of list) {
      const created0 = await createTask({ ...base, status: t.status ?? status, title: t.title, followUpAt: dueToIso(t.due ?? input.due), note: t.note ?? row.gist ?? null });
      created.push({ id: created0.id, title: created0.title });
      actions.push({ title: t.title, due: dueDate(t.due ?? input.due), taskId: created0.id });
    }
  } else if (input.mode === 'custom') {
    const title = (input.title ?? '').trim() || noteHeadline(row);
    const t = await createTask({ ...base, title, followUpAt: dueToIso(input.due), note: input.note ?? row.gist ?? null });
    created.push({ id: t.id, title: t.title });
    // 記録にも「タスクにしたもの」として残す
    actions.push({ title, due: dueDate(input.due), taskId: t.id });
  } else {
    // 指定が無ければ、まだタスクにしていないアクションを全部
    const chosen = actions.map((a, i) => ({ a, i })).filter(({ a, i }) => (input.indexes ? input.indexes.includes(i) : !a.taskId) && !a.taskId);
    if (chosen.length === 0) throw new Error('タスクにする「次のアクション」がありません。題名を書いてタスクにしてください');
    if (input.mode === 'single') {
      const first = chosen[0]!.a;
      const title = (input.title ?? '').trim() || (chosen.length === 1 ? first.title : `${first.title} ほか ${chosen.length - 1} 件`);
      const dues = chosen.map(({ a }) => a.due).filter((x): x is string => !!x).sort();
      const note = input.note ?? [chosen.map(({ a }) => `・${a.title}${a.due ? `（期限 ${dueDate(a.due)}）` : ''}`).join('\n'), row.gist ? `\n${row.gist}` : ''].join('\n').trim();
      const t = await createTask({ ...base, title, followUpAt: dueToIso(input.due ?? dues[0] ?? null), note });
      created.push({ id: t.id, title: t.title });
      for (const { i } of chosen) actions[i] = { ...actions[i]!, taskId: t.id };
    } else {
      for (const { a, i } of chosen) {
        const t = await createTask({ ...base, title: a.title, followUpAt: dueToIso(input.due ?? a.due), note: input.note ?? row.gist ?? null });
        created.push({ id: t.id, title: t.title });
        actions[i] = { ...actions[i]!, taskId: t.id };
      }
    }
  }
  d.update(schema.caseNotes).set({ nextActions: actions }).where(eq(schema.caseNotes.id, noteId)).run();
  d.update(schema.cases).set({ updatedAt: new Date().toISOString() }).where(eq(schema.cases.id, kase.id)).run();
  logger.info({ noteId, mode: input.mode, tasks: created.length }, '記録からタスクを作りました');
  return { tasks: created, note: d.select().from(schema.caseNotes).where(eq(schema.caseNotes.id, noteId)).get()! };
}

/** 記録の編集（本文・整理結果・日時などを差し替える。タスク化済みの次のアクションは taskId を引き継ぐ） */
export function updateCaseNote(id: number, patch: Partial<Omit<CaseNoteInput, 'caseId'>>) {
  const cur = db().select().from(schema.caseNotes).where(eq(schema.caseNotes.id, id)).get();
  if (!cur) throw new Error('記録が見つかりません');
  const set: Partial<typeof schema.caseNotes.$inferInsert> = {};
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.occurredAt !== undefined) set.occurredAt = patch.occurredAt || cur.occurredAt;
  if (patch.counterpart !== undefined) set.counterpart = patch.counterpart?.trim() || null;
  if (patch.phone !== undefined) set.phone = patch.phone?.trim() || null;
  if (patch.rawText !== undefined) set.rawText = patch.rawText;
  if (patch.gist !== undefined) set.gist = patch.gist?.trim() || null;
  if (patch.theirSaid !== undefined) set.theirSaid = patch.theirSaid.map((x) => x.trim()).filter(Boolean);
  if (patch.ourSaid !== undefined) set.ourSaid = patch.ourSaid.map((x) => x.trim()).filter(Boolean);
  if (patch.decisions !== undefined) set.decisions = patch.decisions.map((x) => x.trim()).filter(Boolean);
  if (patch.nextActions !== undefined) {
    set.nextActions = patch.nextActions
      .map((a) => ({ title: a.title.trim(), due: a.due || null, taskId: a.taskId ?? cur.nextActions.find((x) => x.title === a.title.trim())?.taskId ?? null }))
      .filter((a) => a.title);
  }
  if (patch.waitingFor !== undefined) set.waitingFor = patch.waitingFor ?? null;
  if (Object.keys(set).length) db().update(schema.caseNotes).set(set).where(eq(schema.caseNotes.id, id)).run();
  return db().select().from(schema.caseNotes).where(eq(schema.caseNotes.id, id)).get()!;
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
    purpose: '事件サマリーの生成',
    system: '法律事務所の事務補助者として、事件の現状を弁護士向けに簡潔にまとめます。事実の創作はせず、与えられた記録だけを根拠にします。Markdown で「現状」「直近の動き」「未了事項」「推奨される次の一手」の 4 見出し、全体で 500 字程度。',
    user: `事件: ${c.title}（${c.caseType?.label ?? c.caseType}）\n依頼者: ${c.client?.name}\n裁判所・事件番号: ${c.courtName ?? ''} ${c.caseNumber ?? ''}\n現在の段階: ${c.stage ?? '未設定'}\n方針メモ: ${c.policy ?? '（なし）'}\n次回期日: ${c.nextHearingAt ? formatJaDateTime(new Date(c.nextHearingAt)) : '未定'}\n\n未了タスク:\n${openTasks.map((t) => `- [${t.status}] ${t.title}`).join('\n') || '（なし）'}\n\n今後の予定:\n${upcoming.map((e) => `- ${formatJaDateTime(new Date(e.startAt))} ${e.title}`).join('\n') || '（なし）'}\n\n記録（新しい順）:\n${timeline.map((t) => `- ${t.at.slice(0, 10)} [${t.type}] ${t.title}${t.body ? `: ${String(t.body).slice(0, 200)}` : ''}`).join('\n')}`,
    effort: 'medium',
    maxTokens: 3000,
  });
  db().update(schema.cases).set({ summary: md, summaryGeneratedAt: new Date().toISOString() }).where(eq(schema.cases.id, id)).run();
  return md;
}

/** 終了以外の事件。進行事件 → 残務処理 → 相談 の順（メッセージや予定の自動割当に使う） */
export function activeCasesForClient(clientId: number) {
  const order: Record<string, number> = { active: 0, wrapup: 1, consultation: 2 };
  return db()
    .select()
    .from(schema.cases)
    .where(and(eq(schema.cases.clientId, clientId), inArray(schema.cases.status, OPEN_CASE_STATUSES)))
    .orderBy(desc(schema.cases.updatedAt))
    .all()
    .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
}

export function casesNeedingSummary(days = 7) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  return db().select().from(schema.cases).where(inArray(schema.cases.status, ['active', 'wrapup'])).all().filter((c) => !c.summaryGeneratedAt || c.summaryGeneratedAt < cutoff).filter((c) => c.updatedAt > (c.summaryGeneratedAt ?? '') || !c.summaryGeneratedAt);
}

export { gt };
