import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-casedelete-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { deleteCase } = await import('../services/caseDelete.js');
const { deleteClient } = await import('../services/clientImport.js');
const { upsertAlert } = await import('../services/alerts.js');
const { eq } = await import('drizzle-orm');
const { createApp } = await import('../index.js');
const { setPassword } = await import('../auth/index.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

/** 事件と、それにぶら下がるもの一式を作る */
function seed(name: string) {
  const client = db().insert(schema.clients).values({ name }).returning().get();
  const kase = db().insert(schema.cases).values({ clientId: client.id, title: `${name} 事件` }).returning().get();
  const note = db().insert(schema.caseNotes).values({ caseId: kase.id, clientId: client.id, kind: 'phone', occurredAt: '2026-10-01T00:00:00.000Z' }).returning().get();
  const task = db().insert(schema.tasks).values({ title: '書面の準備', status: 'open', clientId: client.id, caseId: kase.id }).returning().get();
  const creditor = db().insert(schema.creditors).values({ caseId: kase.id, name: 'A 銀行' }).returning().get();
  db().insert(schema.creditorEvents).values({ creditorId: creditor.id, occurredAt: '2026-10-01T00:00:00.000Z' }).run();
  const contact = db().insert(schema.caseContacts).values({ caseId: kase.id, role: 'opponent_counsel', name: '相手方代理人' }).returning().get();
  // 依頼者との会話（事件に付いている）と、相手方代理人との会話
  const clientConv = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: `U-${name}`, clientId: client.id, caseId: kase.id }).returning().get();
  const contactConv = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: `t-${name}`, clientId: client.id, caseId: kase.id, contactId: contact.id }).returning().get();
  const msg = db().insert(schema.messages).values({ conversationId: clientConv.id, channel: 'line', externalId: `m-${name}`, direction: 'in', body: 'よろしくお願いします', sentAt: '2026-10-01T00:00:00.000Z', clientId: client.id, caseId: kase.id }).returning().get();
  const event = db().insert(schema.calendarEvents).values({ googleEventId: `ev-${name}`, title: '期日', startAt: '2026-11-01T01:00:00.000Z', endAt: '2026-11-01T02:00:00.000Z', clientId: client.id, caseId: kase.id }).returning().get();
  return { client, kase, note, task, creditor, contact, clientConv, contactConv, msg, event };
}

describe('事件の削除', () => {
  it('記録・タスク・債権者・関係者は消し、会話・メッセージ・予定は残して事件の紐付けだけ外す。依頼者は残す', () => {
    const s = seed('山田 太郎');
    const keep = db().insert(schema.cases).values({ clientId: s.client.id, title: '山田 別件' }).returning().get();
    const keepNote = db()
      .insert(schema.caseNotes)
      .values({ caseId: keep.id, clientId: s.client.id, kind: 'memo', occurredAt: '2026-10-02T00:00:00.000Z', nextActions: [{ title: '書面の準備', taskId: s.task.id }] })
      .returning()
      .get();
    upsertAlert({ type: 'waiting_overdue', dedupeKey: `waiting_overdue:${s.task.id}:x`, title: '期限超過', body: '', payload: { taskId: s.task.id } });

    expect(deleteCase(s.kase.id)).toBe(true);
    expect(db().select().from(schema.cases).where(eq(schema.cases.id, s.kase.id)).get()).toBeUndefined();
    expect(db().select().from(schema.caseNotes).where(eq(schema.caseNotes.id, s.note.id)).get()).toBeUndefined();
    expect(db().select().from(schema.tasks).where(eq(schema.tasks.id, s.task.id)).get()).toBeUndefined();
    expect(db().select().from(schema.creditors).where(eq(schema.creditors.id, s.creditor.id)).get()).toBeUndefined();
    expect(db().select().from(schema.creditorEvents).where(eq(schema.creditorEvents.creditorId, s.creditor.id)).all()).toEqual([]);
    expect(db().select().from(schema.caseContacts).where(eq(schema.caseContacts.id, s.contact.id)).get()).toBeUndefined();
    // 依頼者との会話は依頼者に付いたまま、事件だけ外れる
    expect(db().select().from(schema.conversations).where(eq(schema.conversations.id, s.clientConv.id)).get()).toMatchObject({ clientId: s.client.id, caseId: null });
    // 相手方代理人との会話は依頼者の会話ではないので、紐付けをすべて外す
    expect(db().select().from(schema.conversations).where(eq(schema.conversations.id, s.contactConv.id)).get()).toMatchObject({ clientId: null, caseId: null, contactId: null });
    expect(db().select().from(schema.messages).where(eq(schema.messages.id, s.msg.id)).get()).toMatchObject({ clientId: s.client.id, caseId: null });
    expect(db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, s.event.id)).get()).toMatchObject({ clientId: s.client.id, caseId: null });
    // 依頼者とほかの事件は残る。ほかの事件の記録から、消したタスクへの結び付きは外れる
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, s.client.id)).get()).toBeTruthy();
    expect(db().select().from(schema.caseNotes).where(eq(schema.caseNotes.id, keepNote.id)).get()!.nextActions).toEqual([{ title: '書面の準備', taskId: null }]);
    expect(db().select().from(schema.alerts).where(eq(schema.alerts.dedupeKey, `waiting_overdue:${s.task.id}:x`)).get()!.status).toBe('resolved');
  });

  it('画面から 1 件ずつ・まとめて削除できる', async () => {
    const app = createApp();
    setPassword('case-delete-test');
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'case-delete-test' }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const a = seed('高橋 健');
    const b = seed('伊藤 誠');
    const c = seed('中村 修');
    expect((await app.request(`/api/cases/${a.kase.id}`, { method: 'DELETE', headers: { cookie } })).status).toBe(200);
    expect((await app.request(`/api/cases/${a.kase.id}`, { method: 'DELETE', headers: { cookie } })).status).toBe(404);
    const res = await app.request('/api/cases/bulk-delete', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ids: [b.kase.id, c.kase.id, 999999] }) });
    expect(await res.json()).toEqual({ deleted: 2 });
    expect(db().select().from(schema.cases).where(eq(schema.cases.id, c.kase.id)).get()).toBeUndefined();
  });

  it('無い事件は false', () => {
    expect(deleteCase(999999)).toBe(false);
  });

  it('依頼者の削除でも、事件の関係者・関係者との会話・依頼者に付いたメッセージがあっても消せる', () => {
    const s = seed('佐藤 花子');
    expect(deleteClient(s.client.id)).toBe(true);
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, s.client.id)).get()).toBeUndefined();
    expect(db().select().from(schema.caseContacts).where(eq(schema.caseContacts.id, s.contact.id)).get()).toBeUndefined();
    expect(db().select().from(schema.conversations).where(eq(schema.conversations.id, s.contactConv.id)).get()).toMatchObject({ clientId: null, contactId: null });
    expect(db().select().from(schema.messages).where(eq(schema.messages.id, s.msg.id)).get()).toMatchObject({ clientId: null, caseId: null });
  });
});
