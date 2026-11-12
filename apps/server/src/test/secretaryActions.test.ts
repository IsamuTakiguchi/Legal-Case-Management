import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-secact-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { setAdapter } = await import('../channels/registry.js');
const { applySecretaryActions, previewAction, secretaryActionSchema, secretaryContextNote } = await import('../services/secretary.js');
const { extendedReadTools, normalizeStaffMessage } = await import('../services/secretaryActions.js');
const { eq } = await import('drizzle-orm');

/** Gmail に送ったもの（実際には送らない） */
const sent: { to: string | null | undefined; subject: string | null | undefined; text: string }[] = [];
let seq = 0;
setAdapter('gmail', {
  channel: 'gmail',
  isConfigured: () => true,
  fetchAttachment: async () => Buffer.alloc(0),
  send: async (o) => {
    sent.push({ to: o.to, subject: o.subject, text: o.text });
    seq++;
    return { externalId: `g-${seq}`, externalThreadId: o.externalThreadId.startsWith('new:') ? `th-${seq}` : o.externalThreadId, sentAt: new Date().toISOString() };
  },
});

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());
beforeEach(() => {
  sent.length = 0;
});

let n = 0;
function seed() {
  n++;
  const client = db().insert(schema.clients).values({ name: `吉堂 壱星${n}`, phones: ['090-1111-2222'], emails: [`kichido${n}@example.jp`] }).returning().get();
  const kase = db().insert(schema.cases).values({ clientId: client.id, title: `吉堂 自己破産${n}`, caseType: 'general_civil' }).returning().get();
  const fujita = db().insert(schema.staffMembers).values({ name: `藤田${n}` }).returning().get();
  return { client, kase, fujita };
}
const parse = (a: unknown) => secretaryActionSchema.parse(a);
const tool = (name: string) => extendedReadTools().find((t) => t.name === name)!;

describe('AI 秘書: 事件の変更', () => {
  it('担当事務局を決められる（いま → 変更後を見せ、実行すると変わる）', async () => {
    const s = seed();
    const a = parse({ type: 'case_update', summary: '担当を藤田さんに', caseId: s.kase.id, staffId: s.fujita.id });
    expect(previewAction(a)).toEqual({
      label: `事件の変更: ${s.client.name}／${s.kase.title}`,
      changes: [{ field: 'staffId', label: '担当事務局', before: '（なし）', after: s.fujita.name }],
    });
    const r = await applySecretaryActions([a]);
    expect(r.applied[0]).toMatchObject({ ok: true, link: `/cases/${s.kase.id}` });
    expect(db().select().from(schema.cases).where(eq(schema.cases.id, s.kase.id)).get()!.staffId).toBe(s.fujita.id);
  });

  it('書いていない項目は変えず、clear に書いた項目だけ空にする', async () => {
    const s = seed();
    db().update(schema.cases).set({ staffId: s.fujita.id, stage: '申立準備', courtName: '奈良地裁' }).where(eq(schema.cases.id, s.kase.id)).run();
    await applySecretaryActions([parse({ type: 'case_update', summary: 'x', caseId: s.kase.id, stage: '債権者一覧の作成', clear: ['staffId'] })]);
    expect(db().select().from(schema.cases).where(eq(schema.cases.id, s.kase.id)).get()).toMatchObject({ staffId: null, stage: '債権者一覧の作成', courtName: '奈良地裁' });
  });

  it('存在しない担当事務局・事件類型は断る', async () => {
    const s = seed();
    const r = await applySecretaryActions([parse({ type: 'case_update', summary: 'x', caseId: s.kase.id, staffId: 99999 }), parse({ type: 'case_update', summary: 'y', caseId: s.kase.id, caseType: 'no_such_type' })]);
    expect(r.applied.map((x) => x.ok)).toEqual([false, false]);
    expect(r.applied[0]!.error).toContain('担当事務局が見つかりません');
  });

  it('事件を新しく登録できる', async () => {
    const s = seed();
    const r = await applySecretaryActions([parse({ type: 'case_create', summary: 'x', clientId: s.client.id, title: '吉堂 過払金', staffId: s.fujita.id })]);
    expect(r.applied[0]!.ok).toBe(true);
    const k = db().select().from(schema.cases).all().find((x) => x.title === '吉堂 過払金')!;
    expect(k).toMatchObject({ clientId: s.client.id, staffId: s.fujita.id, status: 'active' });
  });
});

describe('AI 秘書: 担当事務局を名前で決める・事務局を登録する', () => {
  it('名前（「藤田さん」）でも担当事務局にできる', async () => {
    const s = seed();
    const a = parse({ type: 'case_update', summary: 'x', caseId: s.kase.id, staffName: `${s.fujita.name}さん` });
    expect(previewAction(a).changes).toEqual([{ field: 'staffName', label: '担当事務局', before: '（なし）', after: s.fujita.name }]);
    expect((await applySecretaryActions([a])).applied[0]!.ok).toBe(true);
    expect(db().select().from(schema.cases).where(eq(schema.cases.id, s.kase.id)).get()!.staffId).toBe(s.fujita.id);
  });

  it('まだ登録されていない人は、同じ案の中で事務局に登録してから担当にする（二重には登録しない）', async () => {
    const s = seed();
    const name = `梅本${n}`;
    const acts = [parse({ type: 'staff_create', summary: 'x', name }), parse({ type: 'case_update', summary: 'y', caseId: s.kase.id, staffName: name })];
    expect(previewAction(acts[1]!).changes[0]!.after).toBe(`${name}（登録のときに探します）`);
    const r = await applySecretaryActions(acts);
    expect(r.applied.map((x) => x.ok)).toEqual([true, true]);
    const staff = db().select().from(schema.staffMembers).all().filter((x) => x.name === name);
    expect(staff).toHaveLength(1);
    expect(db().select().from(schema.cases).where(eq(schema.cases.id, s.kase.id)).get()!.staffId).toBe(staff[0]!.id);
    await applySecretaryActions([parse({ type: 'staff_create', summary: 'x', name })]);
    expect(db().select().from(schema.staffMembers).all().filter((x) => x.name === name)).toHaveLength(1);
  });

  it('見つからない名前なら、担当を変えずに知らせる', async () => {
    const s = seed();
    const r = await applySecretaryActions([parse({ type: 'case_update', summary: 'x', caseId: s.kase.id, staffName: 'いない人' })]);
    expect(r.applied[0]).toMatchObject({ ok: false });
    expect(r.applied[0]!.error).toContain('事務局メンバー「いない人」が見つかりません');
    expect(db().select().from(schema.cases).where(eq(schema.cases.id, s.kase.id)).get()!.staffId).toBeNull();
  });
});

describe('AI 秘書: 依頼者・関係者', () => {
  it('依頼者を登録し、電話を足す・メールを外すことができる（ほかの電話は残す）', async () => {
    const s = seed();
    await applySecretaryActions([parse({ type: 'client_update', summary: 'x', clientId: s.client.id, addPhones: ['0742-00-0000'], removeEmails: [s.client.emails[0]] })]);
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, s.client.id)).get()).toMatchObject({ phones: ['090-1111-2222', '0742-00-0000'], emails: [] });
    const r = await applySecretaryActions([parse({ type: 'client_create', summary: 'x', name: '株式会社テスト', emails: ['Info@Test.example'] })]);
    const c = db().select().from(schema.clients).all().find((x) => x.name === '株式会社テスト')!;
    expect(c).toMatchObject({ entityType: 'corporation', emails: ['info@test.example'] });
    expect(r.applied[0]!.link).toBe(`/clients/${c.id}`);
  });

  it('相手方代理人を追加・変更できる', async () => {
    const s = seed();
    await applySecretaryActions([parse({ type: 'contact_create', summary: 'x', caseId: s.kase.id, role: 'opponent_counsel', name: '鈴木 一郎', organization: '鈴木法律事務所' })]);
    const k = db().select().from(schema.caseContacts).where(eq(schema.caseContacts.caseId, s.kase.id)).get()!;
    expect(k).toMatchObject({ role: 'opponent_counsel', name: '鈴木 一郎' });
    const a = parse({ type: 'contact_update', summary: 'x', contactId: k.id, addEmails: ['suzuki@law.example'], fax: '03-1111-2222' });
    expect(previewAction(a).changes.map((c) => c.label)).toEqual(['メール', 'FAX']);
    await applySecretaryActions([a]);
    expect(db().select().from(schema.caseContacts).where(eq(schema.caseContacts.id, k.id)).get()).toMatchObject({ emails: ['suzuki@law.example'], fax: '03-1111-2222', name: '鈴木 一郎' });
  });
});

describe('AI 秘書: タスク・予定の変更と削除', () => {
  it('タスクを完了・起案・検討完了にし、期限を外し、削除できる', async () => {
    const s = seed();
    const t = db().insert(schema.tasks).values({ title: '債権者一覧の作成', status: 'open', caseId: s.kase.id, clientId: s.client.id, dueAt: '2026-11-10T14:59:59.999Z' }).returning().get();
    const a = parse({ type: 'task_update', summary: 'x', taskId: t.id, status: 'drafted', clear: ['dueAt'] });
    expect(previewAction(a).changes.map((c) => `${c.label}:${c.before}→${c.after}`)).toEqual(['状態:対応中→起案・検討完了', '締切:11月10日(火)23時59分→（なし）']);
    await applySecretaryActions([a]);
    expect(db().select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()).toMatchObject({ status: 'drafted', dueAt: null });
    await applySecretaryActions([parse({ type: 'task_update', summary: 'x', taskId: t.id, status: 'done' })]);
    expect(db().select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()!.status).toBe('done');
    await applySecretaryActions([parse({ type: 'task_delete', summary: 'x', taskId: t.id })]);
    expect(db().select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()).toBeUndefined();
  });

  it('予定の日時・場所を変え、削除できる', async () => {
    const s = seed();
    const e = db().insert(schema.calendarEvents).values({ googleEventId: `local-sec-${n}`, title: '吉堂　打合せ', startAt: '2026-11-11T05:00:00.000Z', endAt: '2026-11-11T06:00:00.000Z', kind: 'meeting', clientId: s.client.id }).returning().get();
    await applySecretaryActions([parse({ type: 'event_update', summary: 'x', eventId: e.id, startAt: '2026-11-12T15:00:00+09:00', endAt: '2026-11-12T16:00:00+09:00', location: '事務所' })]);
    expect(db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, e.id)).get()).toMatchObject({ startAt: '2026-11-12T06:00:00.000Z', location: '事務所', title: '吉堂　打合せ' });
    await applySecretaryActions([parse({ type: 'event_delete', summary: 'x', eventId: e.id })]);
    expect(db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, e.id)).get()).toBeUndefined();
  });
});

describe('AI 秘書: メッセージの送信', () => {
  it('依頼者に、件名を付けた新しいメールで送り、事件に付ける', async () => {
    const s = seed();
    const r = await applySecretaryActions([parse({ type: 'message_send', summary: 'x', to: 'client', clientId: s.client.id, channel: 'gmail', subject: '書類のお願い', text: '源泉徴収票をお送りください。', caseId: s.kase.id })]);
    expect(r.applied[0]).toMatchObject({ ok: true });
    expect(sent[0]).toMatchObject({ to: s.client.emails[0], subject: '書類のお願い', text: '源泉徴収票をお送りください。' });
    const out = db().select().from(schema.messages).all().find((m) => m.direction === 'out' && m.body.includes('源泉徴収票'))!;
    expect(out).toMatchObject({ caseId: s.kase.id, clientId: s.client.id });
    expect(r.applied[0]!.link).toContain(`/inbox/${out.conversationId}`);
  });

  it('件名が無く、その相手とのメールもまだ無ければ送らない', async () => {
    const s = seed();
    const r = await applySecretaryActions([parse({ type: 'message_send', summary: 'x', to: 'client', clientId: s.client.id, channel: 'gmail', text: '本文' })]);
    expect(r.applied[0]).toMatchObject({ ok: false });
    expect(r.applied[0]!.error).toContain('件名を入れてください');
    expect(sent).toHaveLength(0);
  });
});

describe('AI 秘書: 事務局へのチャットの書き方', () => {
  const msg = (text: string, extra: Record<string, unknown>) => normalizeStaffMessage({ type: 'message_send', summary: 'x', to: 'staff', staffId: 1, channel: 'chatwork', text, ...extra } as never) as { text: string };
  it('1 行目に依頼者の氏名、2 行目から本題にする（「○○さん（自己破産）について、」の前置きは外す）', () => {
    const client = db().insert(schema.clients).values({ name: '吉堂 壱星' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '自己破産', caseType: 'general_civil' }).returning().get();
    expect(msg('吉堂さん（自己破産）について、本人から書類が届きましたので、法テラスへ審査回付をお願いします。', { caseId: kase.id }).text).toBe('吉堂壱星\n本人から書類が届きましたので、法テラスへ審査回付をお願いします。');
    expect(msg('吉堂壱星様の件で、書類の確認をお願いします。', { caseId: kase.id }).text).toBe('吉堂壱星\n書類の確認をお願いします。');
    // 前置きが無ければ、本文はそのまま 2 行目から
    expect(msg('本人から書類が届きました。\n審査回付をお願いします。', { caseId: kase.id }).text).toBe('吉堂壱星\n本人から書類が届きました。\n審査回付をお願いします。');
    // すでにその形ならそのまま
    expect(msg('吉堂壱星\n審査回付をお願いします。', { caseId: kase.id }).text).toBe('吉堂壱星\n審査回付をお願いします。');
    expect(msg('吉堂 壱星さん\n審査回付をお願いします。', { clientId: client.id }).text).toBe('吉堂 壱星さん\n審査回付をお願いします。');
    // 「吉堂さんから」は意味が変わるので外さない
    expect(msg('吉堂さんから電話がありました。', { clientId: client.id }).text).toBe('吉堂壱星\n吉堂さんから電話がありました。');
  });

  it('依頼者が分からないとき・事務局宛てでないときは変えない', () => {
    expect(msg('書類の確認をお願いします。', {}).text).toBe('書類の確認をお願いします。');
    const client = db().insert(schema.clients).values({ name: '山田 太郎' }).returning().get();
    const a = normalizeStaffMessage({ type: 'message_send', summary: 'x', to: 'client', clientId: client.id, channel: 'gmail', text: '本文' } as never) as { text: string };
    expect(a.text).toBe('本文');
  });
});

describe('AI 秘書: 開いた画面', () => {
  it('依頼者・事件・会話の画面から開くと、「この件」が誰のことかを AI に伝える', () => {
    const client = db().insert(schema.clients).values({ name: '吉堂 壱星' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '自己破産', caseType: 'general_civil' }).returning().get();
    const conv = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: `ctx-${client.id}`, clientId: client.id, counterpartName: '吉堂 壱星' }).returning().get();
    const byCase = secretaryContextNote({ caseId: kase.id })!;
    expect(byCase).toContain(`依頼者「吉堂 壱星」（clientId=${client.id}）`);
    expect(byCase).toContain(`事件「自己破産」（caseId=${kase.id}）`);
    expect(byCase).toContain('「この件」');
    expect(secretaryContextNote({ conversationId: conv.id })).toContain(`conversationId=${conv.id}`);
    expect(secretaryContextNote({ conversationId: conv.id })).toContain('依頼者「吉堂 壱星」');
    expect(secretaryContextNote(undefined)).toBeNull();
    expect(secretaryContextNote({ caseId: 999999 })).toBeNull();
  });
});

describe('AI 秘書: 調べる道具', () => {
  it('get_case は担当事務局・関係者・未了のタスクを返し、list_staff_and_types は事務局の ID を返す', async () => {
    const s = seed();
    db().update(schema.cases).set({ staffId: s.fujita.id }).where(eq(schema.cases.id, s.kase.id)).run();
    db().insert(schema.tasks).values({ title: '申立書の起案', status: 'open', caseId: s.kase.id }).run();
    const c = (await tool('get_case').run({ caseId: s.kase.id })) as { staff: { name: string }; openTasks: { title: string }[] };
    expect(c.staff.name).toBe(s.fujita.name);
    expect(c.openTasks.map((t) => t.title)).toEqual(['申立書の起案']);
    const l = (await tool('list_staff_and_types').run({})) as { staff: { id: number; name: string }[] };
    expect(l.staff.find((x) => x.name === s.fujita.name)?.id).toBe(s.fujita.id);
  });
});
