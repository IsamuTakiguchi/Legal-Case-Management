import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-persons-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.STORAGE_BACKEND = 'local';
process.env.LOCAL_CLIENT_ROOT = path.join(tmp, 'clients');

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { createApp } = await import('../index.js');
const { setPassword } = await import('../auth/index.js');
const { setAdapter } = await import('../channels/registry.js');
const { ingestMessage } = await import('../services/inbox.js');
const { linkConversationToClient } = await import('../services/identity.js');
const { setConversationPerson } = await import('../services/clientPersons.js');
const { availableChannels, ensureClientConversation, prepareHearingNotice } = await import('../services/hearingNotice.js');
const { deleteClient } = await import('../services/clientImport.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => {
  openTestDatabase();
  for (const channel of ['gmail', 'line'] as const) {
    setAdapter(channel, { channel, isConfigured: () => true, fetchAttachment: async () => Buffer.from(''), send: async () => ({ externalId: 'x', externalThreadId: 'x', sentAt: new Date().toISOString() }) });
  }
});
afterAll(() => closeDatabase());

const json = { 'content-type': 'application/json' };
const mail = (id: string, email: string, name: string) => ({
  channel: 'gmail' as const,
  externalThreadId: `t-${id}`,
  externalId: `m-${id}`,
  direction: 'in' as const,
  sentAt: '2026-10-01T01:00:00.000Z',
  senderName: name,
  senderAddress: email,
  subject: '件名',
  body: '本文',
  attachments: [],
  identity: { channel: 'gmail' as const, email, displayName: name },
});

describe('法人の依頼者の担当者', () => {
  it('担当者を登録・編集でき、主担当は 1 人だけ。担当者のメールからの受信はその法人の、その担当者との会話になる', async () => {
    const app = createApp();
    setPassword('persons-test');
    const login = await app.request('/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ password: 'persons-test' }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const client = db().insert(schema.clients).values({ name: '株式会社テスト', entityType: 'corporation', emails: ['info@test.co.jp'] }).returning().get();
    const post = async (body: unknown) => (await app.request(`/api/clients/${client.id}/persons`, { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify(body) })).json();
    const sato = await post({ name: '佐藤 花子', title: '総務部 課長', emails: ['sato@test.co.jp'], phones: ['０６-１２３４-５６７８'] });
    expect(sato.primary).toBe(true); // 最初の担当者は主担当
    const suzuki = await post({ name: '鈴木 一郎', title: '経理部', emails: ['suzuki@test.co.jp'], lineUserId: 'U-suzuki' });
    expect(suzuki.primary).toBe(false);
    // 主担当を付け替えると、前の主担当は外れる
    await app.request(`/api/client-persons/${suzuki.id}`, { method: 'PUT', headers: { ...json, cookie }, body: JSON.stringify({ primary: true }) });
    const detail = await (await app.request(`/api/clients/${client.id}`, { headers: { cookie } })).json();
    expect(detail.persons.map((p: { name: string; primary: boolean }) => [p.name, p.primary])).toEqual([
      ['鈴木 一郎', true],
      ['佐藤 花子', false],
    ]);

    // 担当者のメールから届いたら、法人の会話で、その担当者との会話になる
    const r = await ingestMessage(mail('1', 'SATO@test.co.jp', '佐藤花子'), { processAttachments: false });
    expect(r.conversation.clientId).toBe(client.id);
    expect(r.conversation.clientPersonId).toBe(sato.id);
    const conv = await (await app.request(`/api/conversations/${r.conversation.id}`, { headers: { cookie } })).json();
    expect(conv.clientPerson).toEqual({ id: sato.id, name: '佐藤 花子', title: '総務部 課長' });
    // 会社のアドレスからなら、担当者は付かない
    const r2 = await ingestMessage(mail('2', 'info@test.co.jp', '株式会社テスト'), { processAttachments: false });
    expect(r2.conversation.clientId).toBe(client.id);
    expect(r2.conversation.clientPersonId).toBeNull();

    // 送れる宛先: 主担当 → 会社 → ほかの担当者
    expect(availableChannels(db().select().from(schema.clients).where(eq(schema.clients.id, client.id)).get()!).map((x) => [x.recipient, x.channel, x.to])).toEqual([
      ['鈴木 一郎（経理部）', 'gmail', 'suzuki@test.co.jp'],
      ['鈴木 一郎（経理部）', 'line', 'LINE'],
      ['株式会社テスト', 'gmail', 'info@test.co.jp'],
      ['佐藤 花子（総務部 課長）', 'gmail', 'sato@test.co.jp'],
    ]);
  });

  it('担当者宛の会話は担当者の連絡先で作り、会社宛の会話とは分ける', () => {
    const client = db().select().from(schema.clients).where(eq(schema.clients.name, '株式会社テスト')).get()!;
    const suzuki = db().select().from(schema.clientPersons).where(eq(schema.clientPersons.name, '鈴木 一郎')).get()!;
    const sato = db().select().from(schema.clientPersons).where(eq(schema.clientPersons.name, '佐藤 花子')).get()!;
    const toSuzuki = ensureClientConversation(client, 'gmail', suzuki.id);
    expect(toSuzuki).toMatchObject({ clientId: client.id, clientPersonId: suzuki.id, counterpartAddress: 'suzuki@test.co.jp', counterpartName: '鈴木 一郎' });
    expect(toSuzuki.externalThreadId.startsWith('new:')).toBe(true);
    // 佐藤さんとは受信した会話がすでにあるのでそれを使う。会社宛は会社のアドレスの会話
    expect(ensureClientConversation(client, 'gmail', sato.id).counterpartAddress?.toLowerCase()).toBe('sato@test.co.jp');
    expect(ensureClientConversation(client, 'gmail').counterpartAddress).toBe('info@test.co.jp');
    expect(ensureClientConversation(client, 'line', suzuki.id)).toMatchObject({ externalThreadId: 'U-suzuki', clientPersonId: suzuki.id });
    // 別の依頼者の担当者は使えない
    const other = db().insert(schema.clients).values({ name: '別会社' }).returning().get();
    expect(() => ensureClientConversation(other, 'gmail', suzuki.id)).toThrow('この依頼者の担当者ではありません');
  });

  it('期日連絡は主担当宛が既定で、担当者を選び直せる。宛名は担当者になる', async () => {
    const client = db().select().from(schema.clients).where(eq(schema.clients.name, '株式会社テスト')).get()!;
    const sato = db().select().from(schema.clientPersons).where(eq(schema.clientPersons.name, '佐藤 花子')).get()!;
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '売掛金請求', caseType: 'civil', status: 'active' }).returning().get();
    const note = db().insert(schema.caseNotes).values({ caseId: kase.id, clientId: client.id, kind: 'court', occurredAt: '2026-10-01T01:00:00.000Z', rawText: '弁論準備。次回までに準備書面を提出', gist: '弁論準備' }).returning().get();
    const first = await prepareHearingNotice(note.id);
    expect(first.recipient).toBe('鈴木 一郎（経理部）');
    expect(first.to).toBe('suzuki@test.co.jp');
    expect(first.text).toContain('鈴木様');
    const toSato = await prepareHearingNotice(note.id, { channel: 'gmail', personId: sato.id });
    expect(toSato.personId).toBe(sato.id);
    expect(toSato.text).toContain('佐藤様');
    expect(db().select().from(schema.conversations).where(eq(schema.conversations.id, toSato.conversationId)).get()!.counterpartAddress?.toLowerCase()).toBe('sato@test.co.jp');
    const toCompany = await prepareHearingNotice(note.id, { channel: 'gmail', personId: null });
    expect(toCompany.to).toBe('info@test.co.jp');
  });

  it('未紐付けの会話を法人に紐付けてから担当者にすると、そのアドレスは会社ではなく担当者のものとして覚える', async () => {
    const client = db().select().from(schema.clients).where(eq(schema.clients.name, '株式会社テスト')).get()!;
    const r = await ingestMessage(mail('3', 'tanaka@test.co.jp', '田中'), { processAttachments: false });
    expect(r.conversation.clientId).toBeNull();
    linkConversationToClient(r.conversation.id, client.id);
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, client.id)).get()!.emails).toContain('tanaka@test.co.jp');
    const set = setConversationPerson(r.conversation.id, { newPerson: { name: '田中 次郎', title: '営業部' } });
    expect(set.person).toMatchObject({ name: '田中 次郎', title: '営業部', emails: ['tanaka@test.co.jp'], primary: false });
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, client.id)).get()!.emails).toEqual(['info@test.co.jp']);
    expect(db().select().from(schema.conversations).where(eq(schema.conversations.id, r.conversation.id)).get()!.clientPersonId).toBe(set.person!.id);
    // 次に田中さんから届いたメールも、この法人の田中さんとの会話になる
    const next = await ingestMessage(mail('4', 'tanaka@test.co.jp', '田中'), { processAttachments: false });
    expect(next.conversation).toMatchObject({ clientId: client.id, clientPersonId: set.person!.id });
    // 会社・代表として扱い直せる
    setConversationPerson(r.conversation.id, { personId: null });
    expect(db().select().from(schema.conversations).where(eq(schema.conversations.id, r.conversation.id)).get()!.clientPersonId).toBeNull();
    // 別の依頼者の担当者にはできない
    const other = db().select().from(schema.clients).where(eq(schema.clients.name, '別会社')).get()!;
    const otherPerson = db().insert(schema.clientPersons).values({ clientId: other.id, name: '他社 太郎' }).returning().get();
    expect(() => setConversationPerson(r.conversation.id, { personId: otherPerson.id })).toThrow('この依頼者の担当者ではありません');
  });

  it('依頼者を削除すると担当者も消え、会話の担当者の紐付けも外れる', () => {
    const client = db().select().from(schema.clients).where(eq(schema.clients.name, '株式会社テスト')).get()!;
    expect(deleteClient(client.id)).toBe(true);
    expect(db().select().from(schema.clientPersons).where(eq(schema.clientPersons.clientId, client.id)).all()).toEqual([]);
    expect(db().select().from(schema.conversations).all().filter((c) => c.clientPersonId && !db().select().from(schema.clientPersons).where(eq(schema.clientPersons.id, c.clientPersonId)).get())).toEqual([]);
  });
});
