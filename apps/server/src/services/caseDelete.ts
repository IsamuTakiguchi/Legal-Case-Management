import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

type Tx = Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0];

/**
 * 事件にぶら下がるものを片付けてから、事件を消す（トランザクションの中で呼ぶ）。
 * - 事件の記録・タスク・債権者（と経過）・関係者は削除する
 * - 会話・メッセージ・予定は残し、事件への紐付けだけ外す。関係者（相手方など）との会話は依頼者の会話ではないので、依頼者からも外す
 * - OneDrive のフォルダ・ファイルには触らない
 */
export function removeCaseRows(d: Tx, caseId: number): void {
  const creditors = d.select({ id: schema.creditors.id }).from(schema.creditors).where(eq(schema.creditors.caseId, caseId)).all();
  if (creditors.length) d.delete(schema.creditorEvents).where(inArray(schema.creditorEvents.creditorId, creditors.map((c) => c.id))).run();
  d.delete(schema.creditors).where(eq(schema.creditors.caseId, caseId)).run();
  d.delete(schema.caseNotes).where(eq(schema.caseNotes.caseId, caseId)).run();
  const contacts = d.select({ id: schema.caseContacts.id }).from(schema.caseContacts).where(eq(schema.caseContacts.caseId, caseId)).all();
  if (contacts.length) {
    d.update(schema.conversations)
      .set({ contactId: null, caseId: null, clientId: null })
      .where(inArray(schema.conversations.contactId, contacts.map((c) => c.id)))
      .run();
  }
  d.delete(schema.caseContacts).where(eq(schema.caseContacts.caseId, caseId)).run();
  d.update(schema.conversations).set({ caseId: null }).where(eq(schema.conversations.caseId, caseId)).run();
  d.update(schema.messages).set({ caseId: null }).where(eq(schema.messages.caseId, caseId)).run();
  d.update(schema.calendarEvents).set({ caseId: null }).where(eq(schema.calendarEvents.caseId, caseId)).run();
  // この事件のタスクと、そのタスクのお知らせ
  const tasks = d.select({ id: schema.tasks.id }).from(schema.tasks).where(eq(schema.tasks.caseId, caseId)).all();
  d.delete(schema.tasks).where(eq(schema.tasks.caseId, caseId)).run();
  const taskIds = new Set(tasks.map((t) => t.id));
  // ほかの事件の記録の「次のアクション」から、消したタスクへの結び付きを外す
  if (taskIds.size) {
    for (const n of d.select().from(schema.caseNotes).all()) {
      if (!n.nextActions.some((x) => x.taskId && taskIds.has(x.taskId))) continue;
      d.update(schema.caseNotes)
        .set({ nextActions: n.nextActions.map((x) => (x.taskId && taskIds.has(x.taskId) ? { ...x, taskId: null } : x)) })
        .where(eq(schema.caseNotes.id, n.id))
        .run();
    }
  }
  const now = new Date().toISOString();
  for (const a of d.select().from(schema.alerts).where(eq(schema.alerts.status, 'open')).all()) {
    const p = (a.payload ?? {}) as { caseId?: number; taskId?: number };
    if (p.caseId === caseId || (p.taskId && taskIds.has(p.taskId))) {
      d.update(schema.alerts).set({ status: 'resolved', resolvedAt: now }).where(eq(schema.alerts.id, a.id)).run();
    }
  }
  d.delete(schema.cases).where(eq(schema.cases.id, caseId)).run();
}

/** 事件を削除する（誤って登録した事件の後始末用）。無ければ false */
export function deleteCase(id: number): boolean {
  const d = db();
  if (!d.select({ id: schema.cases.id }).from(schema.cases).where(eq(schema.cases.id, id)).get()) return false;
  d.transaction((tx) => removeCaseRows(tx, id));
  return true;
}
