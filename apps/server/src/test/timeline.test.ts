import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-timeline-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.STORAGE_BACKEND = 'local';
process.env.LOCAL_CLIENT_ROOT = path.join(tmp, 'clients');
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { caseTimeline } = await import('../services/cases.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

describe('タイムラインの本文', () => {
  it('長いメッセージは 2000 字まで返し、続きがあることを知らせる', () => {
    const client = db().insert(schema.clients).values({ name: '中村 五郎' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '中村 建物明渡' }).returning().get();
    const conv = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: 'tl-1', clientId: client.id, lastMessageAt: '2027-04-01T00:00:00.000Z' }).returning().get();
    const long = 'あ'.repeat(2500);
    db().insert(schema.messages).values({ conversationId: conv.id, clientId: client.id, channel: 'gmail', externalId: 'tl-long', direction: 'in', body: long, sentAt: '2027-04-01T00:00:00.000Z' }).run();
    db().insert(schema.messages).values({ conversationId: conv.id, clientId: client.id, channel: 'gmail', externalId: 'tl-short', direction: 'in', body: '短い連絡です', sentAt: '2027-04-02T00:00:00.000Z' }).run();

    const items = caseTimeline(kase.id).filter((i) => i.type.startsWith('message:'));
    const longItem = items.find((i) => (i.body ?? '').startsWith('あ'))!;
    expect(longItem.body).toHaveLength(2000);
    expect(longItem.ref?.truncated).toBe(true);
    const shortItem = items.find((i) => i.body === '短い連絡です')!;
    expect(shortItem.ref?.truncated).toBe(false);
  });
});
