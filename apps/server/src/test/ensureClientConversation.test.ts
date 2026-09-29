import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-ensureconv-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { ensureClientConversation } = await import('../services/hearingNotice.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

let client: typeof schema.clients.$inferSelect;
beforeEach(() => {
  db().delete(schema.messages).run();
  db().delete(schema.conversations).run();
  db().delete(schema.clients).run();
  client = db().insert(schema.clients).values({ name: '山田 花子', lineUserId: 'U-yamada', chatworkRoomId: 4321, emails: ['yamada@example.com'] }).returning().get();
});

const convs = () => db().select().from(schema.conversations).all();

describe('依頼者との会話を探す・作る（期日連絡・依頼者に確認）', () => {
  it('アーカイブした LINE の会話があれば、二重に作らずアーカイブを戻して使う', () => {
    const archived = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'U-yamada', clientId: client.id, archived: true }).returning().get();
    const conv = ensureClientConversation(client, 'line');
    expect(conv.id).toBe(archived.id);
    expect(conv.archived).toBe(false);
    expect(convs().length).toBe(1);
    expect(convs()[0]!.archived).toBe(false);
  });

  it('まだ依頼者に紐付いていない LINE の会話があれば、紐付けて使う', () => {
    const unlinked = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'U-yamada', clientId: null, counterpartName: 'はなこ' }).returning().get();
    const conv = ensureClientConversation(client, 'line');
    expect(conv.id).toBe(unlinked.id);
    expect(db().select().from(schema.conversations).where(eq(schema.conversations.id, unlinked.id)).get()!.clientId).toBe(client.id);
    expect(convs().length).toBe(1);
  });

  it('Chatwork のルームも同じ（アーカイブ済みを使う）', () => {
    const archived = db().insert(schema.conversations).values({ channel: 'chatwork', externalThreadId: '4321', clientId: client.id, archived: true }).returning().get();
    expect(ensureClientConversation(client, 'chatwork').id).toBe(archived.id);
    expect(convs().length).toBe(1);
  });

  it('使っている会話があればそれを使い、無ければ作る', () => {
    const active = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'U-yamada', clientId: client.id }).returning().get();
    expect(ensureClientConversation(client, 'line').id).toBe(active.id);
    db().delete(schema.conversations).run();
    const created = ensureClientConversation(client, 'line');
    expect(created).toMatchObject({ channel: 'line', externalThreadId: 'U-yamada', clientId: client.id });
  });

  it('Gmail は、使っているスレッドが無ければ新しいメールとして作る（アーカイブしたスレッドには返信しない）', () => {
    db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: 'thread-old', clientId: client.id, archived: true }).run();
    const conv = ensureClientConversation(client, 'gmail');
    expect(conv.externalThreadId.startsWith('new:')).toBe(true);
    expect(conv.counterpartAddress).toBe('yamada@example.com');
    expect(convs().length).toBe(2);
  });
});
