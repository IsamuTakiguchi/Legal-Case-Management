import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { logger } from '../logger.js';

/**
 * 同じ依頼者を二重に登録してしまったときの統合。
 * 事件・会話・タスク・記録・ファイルなどの紐付けを「残す依頼者」へ付け替え、
 * メールアドレスや LINE の紐付けをまとめてから、余分な依頼者を削除する。
 */

/** 名前の見た目の違い（空白・全角半角）を無視した比較用のキー */
export function normalizeClientName(name: string): string {
  return name.normalize('NFKC').replace(/[\s　]/g, '').toLowerCase();
}

export interface MergeCandidate {
  id: number;
  name: string;
  kana: string | null;
  emails: string[];
  aliases: string[];
  lineUserId: string | null;
  chatworkRoomId: number | null;
  onedriveFolderPath: string | null;
  preferredChannel: string | null;
  notes: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  counts: { cases: number; conversations: number; messages: number; tasks: number; notes: number; attachments: number; events: number };
  /** 情報の多さ（既定で「残す側」に選ぶ目安） */
  score: number;
}

export interface DuplicateGroup {
  key: string;
  name: string;
  clients: MergeCandidate[];
  /** 既定で残す依頼者（情報が最も多いもの。同じなら古い方） */
  suggestedKeepId: number;
}

function countsFor(clientId: number): MergeCandidate['counts'] {
  const d = db();
  const n = (rows: unknown[]) => rows.length;
  const cases = d.select({ id: schema.cases.id }).from(schema.cases).where(eq(schema.cases.clientId, clientId)).all();
  const caseIds = cases.map((c) => c.id);
  return {
    cases: n(cases),
    conversations: n(d.select({ id: schema.conversations.id }).from(schema.conversations).where(eq(schema.conversations.clientId, clientId)).all()),
    messages: n(d.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.clientId, clientId)).all()),
    tasks: n(d.select({ id: schema.tasks.id }).from(schema.tasks).where(eq(schema.tasks.clientId, clientId)).all()),
    notes: n(caseIds.length ? d.select({ id: schema.caseNotes.id }).from(schema.caseNotes).where(inArray(schema.caseNotes.caseId, caseIds)).all() : []),
    attachments: n(d.select({ id: schema.attachments.id }).from(schema.attachments).where(eq(schema.attachments.clientId, clientId)).all()),
    events: n(d.select({ id: schema.calendarEvents.id }).from(schema.calendarEvents).where(eq(schema.calendarEvents.clientId, clientId)).all()),
  };
}

function candidate(c: typeof schema.clients.$inferSelect): MergeCandidate {
  const counts = countsFor(c.id);
  const score =
    counts.cases * 10 +
    counts.notes * 5 +
    counts.conversations * 3 +
    counts.tasks * 2 +
    counts.messages +
    counts.attachments +
    counts.events +
    (c.onedriveFolderPath ? 5 : 0) +
    (c.lineUserId ? 3 : 0) +
    (c.chatworkRoomId ? 3 : 0) +
    c.emails.length * 2 +
    (c.kana ? 1 : 0);
  return {
    id: c.id,
    name: c.name,
    kana: c.kana,
    emails: c.emails,
    aliases: c.aliases,
    lineUserId: c.lineUserId,
    chatworkRoomId: c.chatworkRoomId,
    onedriveFolderPath: c.onedriveFolderPath,
    preferredChannel: c.preferredChannel,
    notes: c.notes,
    archived: c.archived,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    counts,
    score,
  };
}

/** 名前が同じ（空白・全角半角の違いは無視）依頼者の組を探す */
export function findDuplicateClients(): DuplicateGroup[] {
  const groups = new Map<string, typeof schema.clients.$inferSelect[]>();
  for (const c of db().select().from(schema.clients).all()) {
    const key = normalizeClientName(c.name);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }
  const out: DuplicateGroup[] = [];
  for (const [key, rows] of groups) {
    if (rows.length < 2) continue;
    const clients = rows.map(candidate).sort((a, b) => b.score - a.score || a.id - b.id);
    out.push({ key, name: clients[0]!.name, clients, suggestedKeepId: clients[0]!.id });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

export interface MergeResult {
  keepId: number;
  mergedIds: number[];
  moved: { cases: number; conversations: number; messages: number; tasks: number; notes: number; attachments: number; events: number; sessions: number; styleSamples: number; forms: number; alerts: number };
  /** そのままにした情報（残す側と食い違ったもの）。あとで手で直せるように返す */
  conflicts: string[];
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}

/**
 * sourceIds の依頼者を keepId の依頼者に統合する。
 * 事件はそのまま（削除せず）keepId に付け替えるので、同じ依頼者に複数の事件が並ぶ形になる。
 */
export function mergeClients(keepId: number, sourceIds: number[]): MergeResult {
  const d = db();
  const keep = d.select().from(schema.clients).where(eq(schema.clients.id, keepId)).get();
  if (!keep) throw new Error('残す依頼者が見つかりません');
  const ids = [...new Set(sourceIds)].filter((id) => id !== keepId);
  if (ids.length === 0) throw new Error('統合する依頼者を選んでください');
  const sources = d.select().from(schema.clients).where(inArray(schema.clients.id, ids)).all();
  if (sources.length !== ids.length) throw new Error('統合する依頼者が見つかりません');

  const moved: MergeResult['moved'] = { cases: 0, conversations: 0, messages: 0, tasks: 0, notes: 0, attachments: 0, events: 0, sessions: 0, styleSamples: 0, forms: 0, alerts: 0 };
  const conflicts: string[] = [];
  const now = new Date().toISOString();

  d.transaction(() => {
    for (const src of sources) {
      const c = countsFor(src.id);
      moved.cases += c.cases;
      moved.conversations += c.conversations;
      moved.messages += c.messages;
      moved.tasks += c.tasks;
      moved.attachments += c.attachments;
      moved.events += c.events;
      moved.notes += d.select({ id: schema.caseNotes.id }).from(schema.caseNotes).where(eq(schema.caseNotes.clientId, src.id)).all().length;
      moved.sessions += d.select({ id: schema.schedulingSessions.id }).from(schema.schedulingSessions).where(eq(schema.schedulingSessions.clientId, src.id)).all().length;
      moved.styleSamples += d.select({ id: schema.styleSamples.id }).from(schema.styleSamples).where(eq(schema.styleSamples.clientId, src.id)).all().length;
      moved.forms += d.select({ id: schema.formTemplates.id }).from(schema.formTemplates).where(eq(schema.formTemplates.clientId, src.id)).all().length;

      // 紐付けの付け替え（事件・記録・会話・メッセージ・添付・タスク・日程調整・予定・文体サンプル・書式）
      d.update(schema.cases).set({ clientId: keepId, updatedAt: now }).where(eq(schema.cases.clientId, src.id)).run();
      d.update(schema.caseNotes).set({ clientId: keepId }).where(eq(schema.caseNotes.clientId, src.id)).run();
      d.update(schema.conversations).set({ clientId: keepId }).where(eq(schema.conversations.clientId, src.id)).run();
      d.update(schema.messages).set({ clientId: keepId }).where(eq(schema.messages.clientId, src.id)).run();
      d.update(schema.attachments).set({ clientId: keepId }).where(eq(schema.attachments.clientId, src.id)).run();
      d.update(schema.tasks).set({ clientId: keepId, updatedAt: now }).where(eq(schema.tasks.clientId, src.id)).run();
      d.update(schema.schedulingSessions).set({ clientId: keepId }).where(eq(schema.schedulingSessions.clientId, src.id)).run();
      d.update(schema.calendarEvents).set({ clientId: keepId }).where(eq(schema.calendarEvents.clientId, src.id)).run();
      d.update(schema.styleSamples).set({ clientId: keepId }).where(eq(schema.styleSamples.clientId, src.id)).run();
      d.update(schema.formTemplates).set({ clientId: keepId }).where(eq(schema.formTemplates.clientId, src.id)).run();

      // 要確認（アラート）の中の依頼者 ID も付け替える
      for (const a of d.select().from(schema.alerts).all()) {
        const payload = a.payload as Record<string, unknown>;
        if (Number(payload?.clientId) !== src.id) continue;
        d.update(schema.alerts).set({ payload: { ...payload, clientId: keepId } }).where(eq(schema.alerts.id, a.id)).run();
        moved.alerts++;
      }
    }

    // 連絡先などの情報をまとめる（残す側の値を優先し、空いているところだけ埋める）
    const patch: Partial<typeof schema.clients.$inferInsert> = { updatedAt: now };
    patch.emails = uniq([...keep.emails, ...sources.flatMap((s) => s.emails)]);
    patch.aliases = uniq([...keep.aliases, ...sources.flatMap((s) => [...s.aliases, s.name])]).filter((a) => a !== keep.name);
    patch.kana = keep.kana ?? sources.find((s) => s.kana)?.kana ?? null;
    patch.preferredChannel = keep.preferredChannel ?? sources.find((s) => s.preferredChannel)?.preferredChannel ?? null;
    if (!keep.lineUserId) {
      patch.lineUserId = sources.find((s) => s.lineUserId)?.lineUserId ?? null;
    } else {
      for (const s of sources) if (s.lineUserId && s.lineUserId !== keep.lineUserId) conflicts.push(`${s.name}（ID ${s.id}）の LINE の紐付けは引き継いでいません（残す側に別の紐付けがあるため）`);
    }
    if (!keep.chatworkRoomId) {
      const s = sources.find((x) => x.chatworkRoomId);
      patch.chatworkRoomId = s?.chatworkRoomId ?? null;
      patch.chatworkAccountId = keep.chatworkAccountId ?? s?.chatworkAccountId ?? null;
    } else {
      for (const s of sources) if (s.chatworkRoomId && s.chatworkRoomId !== keep.chatworkRoomId) conflicts.push(`${s.name}（ID ${s.id}）の Chatwork ルームは引き継いでいません（残す側に別のルームがあるため）`);
    }
    if (!keep.onedriveFolderPath?.trim()) {
      const s = sources.find((x) => x.onedriveFolderPath?.trim());
      patch.onedriveFolderPath = s?.onedriveFolderPath ?? null;
      patch.onedriveItemId = s?.onedriveItemId ?? keep.onedriveItemId ?? null;
    } else {
      for (const s of sources) {
        const p = s.onedriveFolderPath?.trim();
        if (p && p !== keep.onedriveFolderPath?.trim()) conflicts.push(`OneDrive のフォルダ「${p}」は統合していません。中身は手で移してください（残す側は「${keep.onedriveFolderPath}」）`);
      }
    }
    const log = `${now.slice(0, 10)} ${sources.map((s) => `${s.name}（ID ${s.id}）`).join('、')}を統合`;
    patch.notes = [keep.notes, ...sources.map((s) => s.notes).filter((n) => n && n.trim()), log].filter((n): n is string => !!n && !!n.trim()).join('\n');
    // 片方が非表示でも、統合後は表示する
    patch.archived = false;
    d.update(schema.clients).set(patch).where(eq(schema.clients.id, keepId)).run();

    d.delete(schema.clients).where(inArray(schema.clients.id, ids)).run();
  });

  logger.info({ keepId, mergedIds: ids, moved }, '依頼者を統合しました');
  return { keepId, mergedIds: ids, moved, conflicts };
}
