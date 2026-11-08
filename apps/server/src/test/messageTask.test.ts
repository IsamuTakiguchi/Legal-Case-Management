import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-message-task-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { createApp } = await import('../index.js');
const { setPassword } = await import('../auth/index.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

let seq = 0;
function seed(opts: { channel: 'gmail' | 'line'; subject?: string | null; withContact?: boolean; twoCases?: boolean }) {
  const d = db();
  seq += 1;
  const client = d.insert(schema.clients).values({ name: `依頼者${seq}` }).returning().get();
  const kase = d.insert(schema.cases).values({ clientId: client.id, title: `事件A${seq}`, caseType: 'civil', status: 'active' }).returning().get();
  const kase2 = opts.twoCases ? d.insert(schema.cases).values({ clientId: client.id, title: `事件B${seq}`, caseType: 'civil', status: 'active' }).returning().get() : null;
  const contact = opts.withContact ? d.insert(schema.caseContacts).values({ caseId: kase.id, role: 'opponent_counsel', name: '相手方代理人', emails: [`op${seq}@example.com`] }).returning().get() : null;
  const conv = d
    .insert(schema.conversations)
    .values({
      channel: opts.channel,
      externalThreadId: `thread-${seq}`,
      subject: opts.subject ?? null,
      clientId: client.id,
      contactId: contact?.id ?? null,
      caseId: contact ? kase.id : null,
      counterpartName: 'X',
    })
    .returning()
    .get();
  const msg = d
    .insert(schema.messages)
    .values({ conversationId: conv.id, channel: opts.channel, externalId: `m-${seq}`, direction: 'in', body: '戸籍謄本を取り寄せてください。\nよろしくお願いします。', sentAt: new Date().toISOString() })
    .returning()
    .get();
  return { client, kase, kase2, conv, msg };
}

async function api() {
  const app = createApp();
  await setPassword('test-pass-1234');
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-pass-1234' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  return (p: string, body: unknown) => app.request(`/api${p}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
}

describe('受信メッセージのタスク化（/messages/:id/task）', () => {
  it('メールは件名を題名の既定にし、元のメッセージ・会話・依頼者に紐付ける', async () => {
    const post = await api();
    const { client, conv, msg } = seed({ channel: 'gmail', subject: '戸籍の件' });
    const r = await post(`/messages/${msg.id}/task`, {});
    expect(r.status).toBe(200);
    const t = await r.json();
    expect(t.title).toBe('戸籍の件');
    expect(t.clientId).toBe(client.id);
    expect(t.conversationId).toBe(conv.id);
    expect(t.sourceMessageId).toBe(msg.id);
    expect(t.note).toContain('戸籍謄本を取り寄せてください');
    expect(t.status).toBe('open');
  });

  it('LINE は本文の最初の行を題名にし、関係者との会話なら会話の事件に付ける', async () => {
    const post = await api();
    const { client, kase, msg } = seed({ channel: 'line', withContact: true });
    const t = await (await post(`/messages/${msg.id}/task`, {})).json();
    expect(t.title).toBe('戸籍謄本を取り寄せてください。');
    expect(t.caseId).toBe(kase.id);
    expect(t.clientId).toBe(client.id);
  });

  it('状態・締切・返信期限・事件を指定できる', async () => {
    const post = await api();
    const { kase2, msg } = seed({ channel: 'gmail', subject: '件名', twoCases: true });
    const t = await (await post(`/messages/${msg.id}/task`, { title: '戸籍の返事待ち', status: 'waiting_client', due: '2026-12-01', replyBy: '2026-11-20', caseId: kase2!.id })).json();
    expect(t.title).toBe('戸籍の返事待ち');
    expect(t.status).toBe('waiting_client');
    expect(t.caseId).toBe(kase2!.id);
    expect(t.dueAt).toBeTruthy();
    expect(t.followUpAt).toBeTruthy();
    expect(new Date(t.followUpAt).getTime()).toBeLessThan(new Date(t.dueAt).getTime());
  });

  it('別の依頼者の事件には付けない', async () => {
    const post = await api();
    const a = seed({ channel: 'gmail', subject: 'A' });
    const b = seed({ channel: 'gmail', subject: 'B' });
    const r = await post(`/messages/${a.msg.id}/task`, { caseId: b.kase.id });
    expect(r.status).toBe(400);
  });

  it('Chatwork の伝言の旧形式（followUpAt）もそのまま使える', async () => {
    const post = await api();
    const { msg } = seed({ channel: 'line' });
    const t = await (await post(`/messages/${msg.id}/task`, { title: '伝言', followUpAt: '2026-12-01T14:59:59.999Z' })).json();
    expect(t.dueAt).toBe('2026-12-01T14:59:59.999Z');
  });
});
