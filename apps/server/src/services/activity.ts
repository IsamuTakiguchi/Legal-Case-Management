import { desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { CASE_NOTE_KIND_LABEL, CHANNEL_LABEL, type CaseNoteKind, type Channel } from '@lcm/shared';

/**
 * 直前の行動（最近の動き）。
 * 「さっき電話記録を入れたあの事件」「さっき返信したあの会話」にダッシュボードから戻れるようにする。
 */

export type ActivityKind = 'note' | 'sent' | 'received' | 'task' | 'task_done';

export interface ActivityItem {
  /** 並べ替えに使う時刻（その行動をした時刻） */
  at: string;
  kind: ActivityKind;
  /** 何をしたか（「電話の記録」「Gmail で送信」など） */
  label: string;
  /** 中身の 1 行目 */
  title: string;
  clientId: number | null;
  clientName: string | null;
  caseId: number | null;
  caseTitle: string | null;
  /** 押したときに開く画面 */
  to: string;
}

/** 本文の 1 行目を見出しの長さに切る */
function headline(text: string | null | undefined, limit = 70): string {
  const line = (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return '';
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

export function recentActivity(limit = 12): ActivityItem[] {
  const d = db();
  const items: ActivityItem[] = [];

  // 事件の記録（電話・打合せ・期日・メモ）。方針メモは行動というより設定なので出さない
  const notes = d.select().from(schema.caseNotes).orderBy(desc(schema.caseNotes.createdAt)).limit(limit * 2).all().filter((n) => n.kind !== 'policy');
  // 送受信したメッセージ
  const msgs = d.select().from(schema.messages).orderBy(desc(schema.messages.sentAt)).limit(limit).all();
  // 作ったタスクと、完了したタスク
  const madeTasks = d.select().from(schema.tasks).orderBy(desc(schema.tasks.createdAt)).limit(limit).all();
  const doneTasks = d.select().from(schema.tasks).where(eq(schema.tasks.status, 'done')).orderBy(desc(schema.tasks.updatedAt)).limit(limit).all();

  // 依頼者名・事件名をまとめて引く
  const convIds = [...new Set(msgs.map((m) => m.conversationId))];
  const convs = convIds.length ? d.select().from(schema.conversations).where(inArray(schema.conversations.id, convIds)).all() : [];
  const convById = new Map(convs.map((c) => [c.id, c]));
  const caseIds = [...new Set([...notes.map((n) => n.caseId), ...msgs.map((m) => m.caseId), ...convs.map((c) => c.caseId), ...madeTasks.map((t) => t.caseId), ...doneTasks.map((t) => t.caseId)].filter((v): v is number => !!v))];
  const cases = caseIds.length ? d.select({ id: schema.cases.id, title: schema.cases.title, clientId: schema.cases.clientId }).from(schema.cases).where(inArray(schema.cases.id, caseIds)).all() : [];
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const clientIds = [...new Set([...notes.map((n) => n.clientId), ...msgs.map((m) => m.clientId), ...convs.map((c) => c.clientId), ...madeTasks.map((t) => t.clientId), ...doneTasks.map((t) => t.clientId), ...cases.map((c) => c.clientId)].filter((v): v is number => !!v))];
  const clients = clientIds.length ? d.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(inArray(schema.clients.id, clientIds)).all() : [];
  const clientById = new Map(clients.map((c) => [c.id, c]));

  /** 事件が分かれば、その依頼者も分かる */
  const who = (clientId: number | null, caseId: number | null) => {
    const kase = caseId ? (caseById.get(caseId) ?? null) : null;
    const cid = clientId ?? kase?.clientId ?? null;
    return {
      clientId: cid,
      clientName: cid ? (clientById.get(cid)?.name ?? null) : null,
      caseId: kase?.id ?? null,
      caseTitle: kase?.title ?? null,
    };
  };

  for (const n of notes) {
    items.push({
      at: n.createdAt,
      kind: 'note',
      label: `${CASE_NOTE_KIND_LABEL[n.kind as CaseNoteKind] ?? n.kind}の記録${n.counterpart ? `（${n.counterpart}）` : ''}`,
      title: headline(n.gist ?? n.rawText),
      ...who(n.clientId, n.caseId),
      to: `/cases/${n.caseId}#note-${n.id}`,
    });
  }
  for (const m of msgs) {
    const conv = convById.get(m.conversationId);
    items.push({
      at: m.sentAt,
      kind: m.direction === 'out' ? 'sent' : 'received',
      label: `${CHANNEL_LABEL[m.channel as Channel] ?? m.channel} を${m.direction === 'out' ? '送信' : '受信'}${m.direction === 'in' && m.senderName ? `（${m.senderName}）` : ''}`,
      title: headline(m.body),
      ...who(m.clientId ?? conv?.clientId ?? null, m.caseId ?? conv?.caseId ?? null),
      to: `/inbox/${m.conversationId}`,
    });
  }
  const taskLink = (t: typeof schema.tasks.$inferSelect) => (t.caseId ? `/cases/${t.caseId}` : t.conversationId ? `/inbox/${t.conversationId}` : '/tasks');
  for (const t of madeTasks) {
    items.push({ at: t.createdAt, kind: 'task', label: 'タスクを作成', title: headline(t.title), ...who(t.clientId, t.caseId), to: taskLink(t) });
  }
  for (const t of doneTasks) {
    // 作ってすぐ完了にしたものは「作成」と二重に出ないよう、完了の方だけ残す
    if (t.updatedAt === t.createdAt) continue;
    items.push({ at: t.updatedAt, kind: 'task_done', label: 'タスクを完了', title: headline(t.title), ...who(t.clientId, t.caseId), to: taskLink(t) });
  }

  // 一度にたくさん作ったタスクで埋まると、見たかった記録ややり取りが押し出される。
  // まずタスクを全体の 1/4 までに抑えて記録・送受信の席を確保し、それでも余ったら残りのタスクで埋める
  const sorted = items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const isTask = (i: ActivityItem) => i.kind === 'task' || i.kind === 'task_done';
  const taskQuota = Math.max(2, Math.floor(limit / 4));
  const out: ActivityItem[] = [];
  const spilled: ActivityItem[] = [];
  let taskUsed = 0;
  for (const it of sorted) {
    if (out.length >= limit) break;
    if (isTask(it) && taskUsed >= taskQuota) {
      spilled.push(it);
      continue;
    }
    if (isTask(it)) taskUsed++;
    out.push(it);
  }
  for (const it of spilled) {
    if (out.length >= limit) break;
    out.push(it);
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
