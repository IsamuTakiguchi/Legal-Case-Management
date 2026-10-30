import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-relink-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { linkConversationToContact } = await import('../services/contacts.js');
const { linkConversationToClient, findClientByIdentity } = await import('../services/identity.js');
const { findContactByIdentity } = await import('../services/contacts.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

let n = 0;
function seed() {
  n++;
  const client = db().insert(schema.clients).values({ name: `山田 太郎${n}` }).returning().get();
  const kase = db().insert(schema.cases).values({ clientId: client.id, title: `山田 離婚${n}` }).returning().get();
  const wrong = db().insert(schema.caseContacts).values({ caseId: kase.id, role: 'opponent', name: '相手方 本人' }).returning().get();
  const right = db().insert(schema.caseContacts).values({ caseId: kase.id, role: 'opponent_counsel', name: '鈴木 一郎' }).returning().get();
  const addr = `suzuki${n}@law.example.com`;
  const conv = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: `t-${n}`, counterpartAddress: addr }).returning().get();
  db().insert(schema.messages).values({ conversationId: conv.id, channel: 'gmail', externalId: `m-${n}`, direction: 'in', body: 'ご連絡', sentAt: '2026-10-30T00:00:00.000Z' }).run();
  return { client, kase, wrong, right, addr, conv };
}
const contact = (id: number) => db().select().from(schema.caseContacts).where(eq(schema.caseContacts.id, id)).get()!;
const conversation = (id: number) => db().select().from(schema.conversations).where(eq(schema.conversations.id, id)).get()!;

describe('関係者の紐付けを変える', () => {
  it('間違えた関係者から正しい関係者に付け替えると、メールアドレスも移り、次の連絡は正しい関係者に付く', () => {
    const s = seed();
    linkConversationToContact(s.conv.id, s.wrong.id);
    expect(contact(s.wrong.id).emails).toEqual([s.addr]);
    linkConversationToContact(s.conv.id, s.right.id);
    expect(conversation(s.conv.id)).toMatchObject({ contactId: s.right.id, caseId: s.kase.id, clientId: s.client.id });
    expect(contact(s.wrong.id).emails).toEqual([]);
    expect(contact(s.right.id).emails).toEqual([s.addr]);
    expect(findContactByIdentity({ channel: 'gmail', email: s.addr })?.contact.id).toBe(s.right.id);
  });

  it('関係者として付けた会話を依頼者本人に付け替えると、関係者の紐付けとアドレスを外し、依頼者の連絡先にする', () => {
    const s = seed();
    linkConversationToContact(s.conv.id, s.wrong.id);
    linkConversationToClient(s.conv.id, s.client.id);
    // 同じ依頼者の事件なので事件は残す。関係者は外れる
    expect(conversation(s.conv.id)).toMatchObject({ clientId: s.client.id, contactId: null, caseId: s.kase.id });
    expect(contact(s.wrong.id).emails).toEqual([]);
    expect(findContactByIdentity({ channel: 'gmail', email: s.addr })).toBeNull();
    expect(findClientByIdentity({ channel: 'gmail', email: s.addr })?.id).toBe(s.client.id);
  });

  it('別の依頼者の関係者だったときは、その事件も外す', () => {
    const s = seed();
    const other = db().insert(schema.clients).values({ name: `佐藤 花子${n}` }).returning().get();
    linkConversationToContact(s.conv.id, s.wrong.id);
    linkConversationToClient(s.conv.id, other.id);
    expect(conversation(s.conv.id)).toMatchObject({ clientId: other.id, contactId: null, caseId: null });
    expect(db().select().from(schema.messages).where(eq(schema.messages.conversationId, s.conv.id)).get()).toMatchObject({ clientId: other.id, caseId: null });
  });

  it('依頼者の会話を関係者に付け替えると、依頼者の連絡先からそのアドレスを外す', () => {
    const s = seed();
    linkConversationToClient(s.conv.id, s.client.id);
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, s.client.id)).get()!.emails).toEqual([s.addr]);
    linkConversationToContact(s.conv.id, s.right.id);
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, s.client.id)).get()!.emails).toEqual([]);
    expect(findContactByIdentity({ channel: 'gmail', email: s.addr })?.contact.id).toBe(s.right.id);
  });

  it('依頼者を別の依頼者に付け替えると、前の依頼者からアドレスを外す', () => {
    const s = seed();
    const other = db().insert(schema.clients).values({ name: `高橋 健${n}` }).returning().get();
    linkConversationToClient(s.conv.id, s.client.id);
    linkConversationToClient(s.conv.id, other.id);
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, s.client.id)).get()!.emails).toEqual([]);
    expect(findClientByIdentity({ channel: 'gmail', email: s.addr })?.id).toBe(other.id);
  });

  it('同じ相手に付け直しても、何も外さない', () => {
    const s = seed();
    linkConversationToClient(s.conv.id, s.client.id);
    linkConversationToClient(s.conv.id, s.client.id);
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, s.client.id)).get()!.emails).toEqual([s.addr]);
    linkConversationToContact(s.conv.id, s.right.id);
    linkConversationToContact(s.conv.id, s.right.id);
    expect(contact(s.right.id).emails).toEqual([s.addr]);
  });
});
