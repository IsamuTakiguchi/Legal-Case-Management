import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-memos-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = 'test-key';

/** AI に渡した指示を控え、決まった答えを返す */
const calls: { purpose?: string; user: string }[] = [];
vi.mock('../integrations/anthropic.js', async (orig) => ({
  ...(await orig<typeof import('../integrations/anthropic.js')>()),
  generateStructured: vi.fn(async (opts: { purpose?: string; user: string }) => {
    calls.push({ purpose: opts.purpose, user: opts.user });
    // 未完了の備忘が渡されていれば、その先頭のきっかけが来たと答える
    const id = Number(/- ID (\d+):/.exec(opts.user)?.[1] ?? 0);
    const triggered = id && /和解期日|和解の日程/.test(opts.user) ? [{ id, reason: '和解の日程が決まったため' }] : [];
    if (opts.purpose === '時期未定の備忘の検出') {
      return {
        items: /和解の前に和解案/.test(opts.user) ? [{ title: '和解案を東京海上日動 岡田様に報告', trigger: '和解の前', reportTo: '東京海上日動 岡田彬弘' }] : [],
        triggered,
      };
    }
    return { triggered };
  }),
}));

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { runMemoDetection, createMemo, checkMemoReviews, checkMemosForNote, snoozeMemo, openMemos, memoSuggestionsFor } = await import('../services/memos.js');
const { updateTask, listTasks } = await import('../services/tasks.js');
const { createApp } = await import('../index.js');
const { setPassword } = await import('../auth/index.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

const INSURER_MAIL = `瀧口様
お世話になっております。

掲題の件で、和解の前に和解案について先にご教示いただけますでしょうか。
資料を以下のURLよりアップロードお願いいたします。

URL：https://example.com/upload

また、相手方の損害は物損のみで間違いございませんでしょうか。

東京海上日動火災保険株式会社　大阪損害サービス第3チーム　岡田彬弘　06-6910-6265`;

function seed() {
  const d = db();
  const client = d.insert(schema.clients).values({ name: '山田 太郎' }).returning().get();
  const kase = d.insert(schema.cases).values({ clientId: client.id, title: '交通事故（物損）', caseType: 'civil', status: 'active' }).returning().get();
  const contact = d.insert(schema.caseContacts).values({ caseId: kase.id, role: 'other', name: '岡田彬弘', organization: '東京海上日動火災保険株式会社', emails: ['okada@example.com'] }).returning().get();
  const conv = d
    .insert(schema.conversations)
    .values({ channel: 'gmail', externalThreadId: `thread-${Math.random()}`, contactId: contact.id, counterpartName: '岡田彬弘', counterpartAddress: 'okada@example.com' })
    .returning()
    .get();
  return { client, kase, contact, conv };
}

function addMessage(conversationId: number, body: string) {
  return db()
    .insert(schema.messages)
    .values({ conversationId, channel: 'gmail', externalId: `m-${Math.random()}`, direction: 'in', senderName: '岡田彬弘', senderAddress: 'okada@example.com', body, sentAt: new Date().toISOString() })
    .returning()
    .get();
}

describe('時期未定の備忘', () => {
  it('受信メールから時期未定の宿題を見つけ、要確認と会話に候補として出す。登録すると事件・会話に紐付く', async () => {
    const { kase, client, conv } = seed();
    const m = addMessage(conv.id, INSURER_MAIL);
    const r = await runMemoDetection(m.id);
    expect(r.items).toHaveLength(1);
    // 相手は事件の関係者（保険会社の担当者）として AI に伝わる
    expect(calls.at(-1)!.user).toContain('東京海上日動火災保険株式会社 岡田彬弘（事件の関係者）');
    expect(calls.at(-1)!.user).toContain('事件: 交通事故（物損）');
    const alert = db().select().from(schema.alerts).where(eq(schema.alerts.dedupeKey, `memo_suggested:${m.id}`)).get()!;
    expect(alert.type).toBe('memo_suggested');
    expect(alert.title).toContain('和解案を東京海上日動 岡田様に報告（和解の前）');
    expect(memoSuggestionsFor(conv.id)).toEqual([expect.objectContaining({ alertId: alert.id, messageId: m.id })]);

    const before = Date.now();
    const t = await createMemo({ title: r.items[0]!.title, trigger: r.items[0]!.trigger, sourceMessageId: m.id });
    expect(t).toMatchObject({ trigger: '和解の前', status: 'open', dueAt: null, caseId: kase.id, clientId: client.id, conversationId: conv.id, sourceMessageId: m.id });
    // 見直す日は既定で 2 週間後（日付だけ）
    expect(new Date(t.reviewAt!).getTime() - before).toBeGreaterThan(13 * 86400_000);
    // メモは用件から（宛名・挨拶は外す）
    expect(t.note).toMatch(/^受信より:\n掲題の件で、和解の前に和解案について/);
    expect(openMemos({ caseId: kase.id }).map((x) => x.id)).toEqual([t.id]);
    expect(listTasks({ caseId: kase.id })[0]).toMatchObject({ trigger: '和解の前' });
  });

  it('後から届いた連絡や事件の記録で、きっかけが来たら要確認に出す', async () => {
    const { kase, conv } = seed();
    const t = await createMemo({ title: '和解案を保険会社に報告', trigger: '和解の前', caseId: kase.id });
    // 未完了の備忘を AI に渡す
    const m = addMessage(conv.id, '次回の弁論準備で和解期日を入れる予定です。よろしくお願いいたします。');
    const r = await runMemoDetection(m.id);
    expect(calls.at(-1)!.user).toContain(`- ID ${t.id}: 和解案を保険会社に報告（きっかけ: 和解の前）`);
    expect(r.triggered).toEqual([{ id: t.id, reason: '和解の日程が決まったため' }]);
    expect(db().select().from(schema.alerts).where(eq(schema.alerts.dedupeKey, `memo_triggered:${t.id}:message:${m.id}`)).get()?.type).toBe('memo_triggered');

    const note = db().insert(schema.caseNotes).values({ caseId: kase.id, clientId: kase.clientId, kind: 'court', occurredAt: new Date().toISOString(), rawText: '弁論準備。次回は和解期日（11/20）', gist: '次回和解期日' }).returning().get();
    const hits = await checkMemosForNote(note.id);
    expect(hits.map((h) => h.id)).toEqual([t.id]);
    expect(db().select().from(schema.alerts).where(eq(schema.alerts.dedupeKey, `memo_triggered:${t.id}:note:${note.id}`)).get()?.status).toBe('open');

    // 完了にすると、きっかけのお知らせも閉じる
    updateTask(t.id, { status: 'done' });
    expect(db().select().from(schema.alerts).where(eq(schema.alerts.dedupeKey, `memo_triggered:${t.id}:note:${note.id}`)).get()?.status).toBe('resolved');
    expect(openMemos({ caseId: kase.id })).toHaveLength(0);
  });

  it('見直す日を過ぎたら要確認に出し、「まだ時期未定」で先に延ばせる。締切を決めたら時期未定ではなくなる', async () => {
    const { kase } = seed();
    const t = await createMemo({ title: '判決が出たら依頼者に報告', trigger: '判決の後', caseId: kase.id, reviewAt: new Date(Date.now() - 60_000).toISOString() });
    expect(checkMemoReviews()).toBeGreaterThanOrEqual(1);
    const key = `memo_review:${t.id}:${t.reviewAt}`;
    expect(db().select().from(schema.alerts).where(eq(schema.alerts.dedupeKey, key)).get()?.status).toBe('open');
    const snoozed = snoozeMemo(t.id, 7)!;
    expect(new Date(snoozed.reviewAt!).getTime()).toBeGreaterThan(Date.now() + 6 * 86400_000);
    expect(db().select().from(schema.alerts).where(eq(schema.alerts.dedupeKey, key)).get()?.status).toBe('resolved');
    expect(openMemos({ caseId: kase.id }).map((x) => x.id)).toContain(t.id);
    updateTask(t.id, { dueAt: new Date(Date.now() + 86400_000).toISOString() });
    expect(openMemos({ caseId: kase.id }).map((x) => x.id)).not.toContain(t.id);
  });

  it('事務局の伝言や短いメッセージは見ない', async () => {
    const { conv } = seed();
    const n = calls.length;
    const short = addMessage(conv.id, 'ありがとうございます。');
    expect((await runMemoDetection(short.id)).items).toHaveLength(0);
    const staff = db().insert(schema.conversations).values({ channel: 'chatwork', externalThreadId: `room-${Math.random()}`, meta: { staff: true } }).returning().get();
    const s = addMessage(staff.id, INSURER_MAIL);
    expect((await runMemoDetection(s.id)).items).toHaveLength(0);
    expect(calls.length).toBe(n);
  });

  it('API: 候補の検出・登録・見直しの延期、会話の画面に候補と備忘を返す', async () => {
    const app = createApp();
    await setPassword('test-pass-1234');
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-pass-1234' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const req = (p: string, init: RequestInit = {}) => app.request(`/api${p}`, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } });
    const { conv, kase } = seed();
    const m = addMessage(conv.id, INSURER_MAIL);
    const det = await (await req(`/messages/${m.id}/memos/detect`, { method: 'POST' })).json();
    expect(det.items[0]).toMatchObject({ trigger: '和解の前' });
    await runMemoDetection(m.id);
    let detail = await (await req(`/conversations/${conv.id}`)).json();
    expect(detail.memoSuggestions).toHaveLength(1);
    const created = await (await req('/memos', { method: 'POST', body: JSON.stringify({ title: det.items[0].title, trigger: '和解の前', sourceMessageId: m.id }) })).json();
    expect(created).toMatchObject({ caseId: kase.id, trigger: '和解の前' });
    detail = await (await req(`/conversations/${conv.id}`)).json();
    expect(detail.memos).toEqual([expect.objectContaining({ id: created.id, trigger: '和解の前' })]);
    const snoozed = await (await req(`/tasks/${created.id}/memo-snooze`, { method: 'POST', body: JSON.stringify({ days: 30 }) })).json();
    expect(new Date(snoozed.reviewAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86400_000);
    // きっかけは PUT でも直せる
    const upd = await (await req(`/tasks/${created.id}`, { method: 'PUT', body: JSON.stringify({ trigger: '和解期日の前' }) })).json();
    expect(upd.trigger).toBe('和解期日の前');
  });
});
