import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-stylelearn-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.CHATWORK_API_TOKEN = 'test-token';
process.env.ANTHROPIC_API_KEY = 'test-key';

/** AI に渡した指示（手本が入っているかを確かめる） */
let lastSystem = '';
let extracted: Record<string, unknown> = {};
vi.mock('../integrations/anthropic.js', () => ({
  generateText: async (req: { system: string }) => {
    lastSystem = req.system;
    return '下書き本文';
  },
  generateStructured: async (req: { system: string }) => {
    lastSystem = req.system;
    return extracted;
  },
}));
vi.mock('../integrations/calendar.js', () => ({ listEvents: async () => [] }));

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { pastDraftExamples } = await import('../services/style.js');
const { prepareHearingNotice } = await import('../services/hearingNotice.js');
const { recordEventStyle, applyEventStyle, eventStyleHints, contentOfTitle } = await import('../services/eventStyle.js');
const { proposeScheduleFromNote, registerScheduleFromNote } = await import('../services/noteSchedule.js');
const { registerScheduleFromConversation } = await import('../services/scheduleExtract.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

function seedConv(channel: 'chatwork' | 'gmail', clientId: number | null) {
  return db()
    .insert(schema.conversations)
    .values({ channel, externalThreadId: `t-${Math.random()}`, counterpartName: '依頼者', clientId })
    .returning()
    .get();
}
function seedDraft(convId: number, generated: string, final: string | null, status = 'sent', kind: string | null = 'hearing_notice') {
  return db().insert(schema.drafts).values({ conversationId: convId, instruction: 'x', generatedText: generated, finalText: final, status, kind }).returning().get();
}

describe('期日連絡の書き方を学ぶ', () => {
  beforeEach(() => {
    db().delete(schema.drafts).run();
  });

  it('送った期日連絡を手本にする（同じチャネル → 本人が直したもの → 同じ依頼者 の順）', () => {
    const a = db().insert(schema.clients).values({ name: '甲野 一郎' }).returning().get();
    const b = db().insert(schema.clients).values({ name: '乙山 二郎' }).returning().get();
    const cwA = seedConv('chatwork', a.id);
    const cwB = seedConv('chatwork', b.id);
    const mail = seedConv('gmail', a.id);
    const long = (s: string) => `${s}。本日の期日の結果をご報告いたします。次回期日は追ってご連絡します。`;
    seedDraft(mail.id, long('メール'), long('メール直し'));
    seedDraft(cwB.id, long('別の人そのまま'), long('別の人そのまま'));
    seedDraft(cwA.id, long('同じ人そのまま'), long('同じ人そのまま'));
    seedDraft(cwB.id, long('別の人'), long('別の人を直した'));
    // 送っていない・短すぎる・期日連絡でない下書きは使わない
    seedDraft(cwA.id, long('未送信'), null, 'pending');
    seedDraft(cwA.id, '短い', '短い');
    seedDraft(cwA.id, long('普通の返信'), long('普通の返信'), 'sent', null);
    const ex = pastDraftExamples('hearing_notice', { channel: 'chatwork', clientId: a.id, limit: 4 });
    expect(ex).toEqual([long('別の人を直した'), long('同じ人そのまま'), long('別の人そのまま'), long('メール直し')]);
  });

  it('期日連絡の下書きを作るとき、過去に送った期日連絡を AI に渡し、下書きに印を付ける', async () => {
    const client = db().insert(schema.clients).values({ name: '丙川 三郎', chatworkRoomId: 300 }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '丙川 貸金' }).returning().get();
    const note = db()
      .insert(schema.caseNotes)
      .values({ caseId: kase.id, clientId: client.id, kind: 'court', occurredAt: new Date().toISOString(), rawText: '第1回弁論', gist: '第1回弁論', decisions: [], nextActions: [], theirSaid: [], ourSaid: [], attachments: [] })
      .returning()
      .get();
    // 1 回目は手本なし
    const first = await prepareHearingNotice(note.id);
    expect(lastSystem).not.toContain('本人が過去に送った期日連絡');
    const d1 = db().select().from(schema.drafts).all().find((d) => d.id === first.draftId)!;
    expect(d1.kind).toBe('hearing_notice');
    // 本人が直して送った
    const sent = '丙川様\n\nお世話になっております。本日の期日では、相手方から準備書面が陳述されました。次回までに反論を準備します。';
    db().update(schema.drafts).set({ status: 'sent', finalText: sent }).run();
    await prepareHearingNotice(note.id);
    expect(lastSystem).toContain('本人が過去に送った期日連絡');
    expect(lastSystem).toContain('相手方から準備書面が陳述されました');
  });
});

describe('予定の件名・場所の書き方を学ぶ', () => {
  beforeEach(() => {
    db().delete(schema.eventStyleExamples).run();
  });

  it('件名から依頼者名と「仮」を除いて内容を取り出す', () => {
    expect(contentOfTitle('河村亮祐　WEB裁判（損害賠償請求事件）', '河村 亮祐')).toBe('WEB裁判（損害賠償請求事件）');
    expect(contentOfTitle('河村 打合せ 仮', '河村 亮祐')).toBe('打合せ');
    expect(contentOfTitle('打合せ', null)).toBe('打合せ');
  });

  it('直していなければ覚えない。直したら、次の同じ案に同じ直し方を当てる（事件名は今回のまま）', () => {
    expect(recordEventStyle({ source: 'note', kind: 'hearing', clientName: '河村 亮祐', proposedTitle: '河村　次回期日（損害賠償請求事件）', finalTitle: '河村 次回期日（損害賠償請求事件）', proposedLocation: '奈良地裁', finalLocation: '奈良地裁' })).toBe(false);
    expect(
      recordEventStyle({ source: 'note', kind: 'hearing', clientName: '河村 亮祐', proposedTitle: '河村　第2回弁論準備（損害賠償請求事件）', finalTitle: '河村亮祐　弁論準備（損害賠償請求事件）', proposedLocation: '奈良地裁 第3民事部', finalLocation: '奈良地裁 本館3階' }),
    ).toBe(true);
    // 同じ案なら、今回の事件名を残して直す
    expect(applyEventStyle({ kind: 'hearing', content: '第2回弁論準備（貸金返還請求事件）', location: '奈良地裁 第3民事部' })).toEqual({ content: '弁論準備（貸金返還請求事件）', location: '奈良地裁 本館3階', applied: true });
    // 内容が違えば内容はそのまま。場所だけ同じなら場所は直す
    expect(applyEventStyle({ kind: 'hearing', content: '尋問期日（貸金返還請求事件）', location: '奈良地裁 第3民事部' })).toEqual({ content: '尋問期日（貸金返還請求事件）', location: '奈良地裁 本館3階', applied: true });
    // 種別が違えば内容は直さない
    expect(applyEventStyle({ kind: 'meeting', content: '第2回弁論準備', location: null })).toEqual({ content: '第2回弁論準備', location: null, applied: false });
    // AI への手本
    const hints = eventStyleHints();
    expect(hints).toContain('「第2回弁論準備」（場所「奈良地裁 第3民事部」） → 「弁論準備」、場所は「奈良地裁 本館3階」');
  });

  it('新しい直し方を優先し、括弧書きを消していたら今回も付けない', () => {
    recordEventStyle({ source: 'conversation', kind: 'meeting', clientName: '山田 花子', proposedTitle: '山田 打合せ（離婚）', finalTitle: '山田 面談（離婚）' });
    recordEventStyle({ source: 'conversation', kind: 'meeting', clientName: '山田 花子', proposedTitle: '山田 打合せ（離婚）', finalTitle: '山田 来所打合せ' });
    expect(applyEventStyle({ kind: 'meeting', content: '打合せ（相続）', location: null }).content).toBe('来所打合せ');
  });

  it('記録から予定: 前に直した件名・場所を案に当て、直して登録したら覚える', async () => {
    const client = db().insert(schema.clients).values({ name: '河村 亮祐' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '河村 損害賠償' }).returning().get();
    const note = db()
      .insert(schema.caseNotes)
      .values({ caseId: kase.id, clientId: client.id, kind: 'court', occurredAt: '2027-09-01T01:00:00.000Z', rawText: '次回は出頭', gist: '次回期日', decisions: [], nextActions: [], theirSaid: [], ourSaid: [], attachments: [] })
      .returning()
      .get();
    extracted = {
      found: false, content: '', kind: 'hearing', web: null, durationMinutes: null, earliest: null, latest: null, weekdays: [], timeRanges: [], avoid: [], requested: [], quote: '', note: '',
      fixed: [{ startAt: '2099-10-11T13:30:00+09:00', timeKnown: true, content: '第3回口頭弁論（損害賠償請求事件）', kind: 'hearing', durationMinutes: 30, location: '奈良地裁', web: false, quote: '' }],
    };
    // まだ覚えていない
    let r = await proposeScheduleFromNote(note.id);
    expect(r.fixed[0]).toMatchObject({ content: '第3回口頭弁論（損害賠償請求事件）', location: '奈良地裁' });
    // 直して登録 → 覚える
    await registerScheduleFromNote(note.id, {
      mode: 'confirmed',
      title: '河村　口頭弁論（損害賠償請求事件）',
      kind: 'hearing',
      location: '奈良地裁 201号法廷',
      proposed: { title: '河村　第3回口頭弁論（損害賠償請求事件）', location: '奈良地裁' },
      slots: [{ startAt: '2099-10-11T13:30:00+09:00', endAt: '2099-10-11T14:00:00+09:00' }],
    });
    const rows = db().select().from(schema.eventStyleExamples).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'note', kind: 'hearing', proposedContent: '第3回口頭弁論（損害賠償請求事件）', finalContent: '口頭弁論（損害賠償請求事件）', proposedLocation: '奈良地裁', finalLocation: '奈良地裁 201号法廷', clientId: client.id });
    // 次からは直した形で出し、AI にも手本を渡す
    r = await proposeScheduleFromNote(note.id);
    expect(r.fixed[0]).toMatchObject({ content: '口頭弁論（損害賠償請求事件）', location: '奈良地裁 201号法廷' });
    expect(lastSystem).toContain('本人はカレンダーの件名・場所を次のように直して登録しています');
  });

  it('会話から予定: 直して登録したら覚える（直さなければ覚えない）', async () => {
    const client = db().insert(schema.clients).values({ name: '菊岡 正博' }).returning().get();
    const conv = seedConv('chatwork', client.id);
    const slots = [{ startAt: '2099-10-12T10:00:00+09:00', endAt: '2099-10-12T11:00:00+09:00' }];
    await registerScheduleFromConversation(conv.id, { mode: 'confirmed', title: '依頼者 打合せ', kind: 'meeting', location: null, proposed: { title: '依頼者 打合せ', location: null }, slots });
    expect(db().select().from(schema.eventStyleExamples).all()).toHaveLength(0);
    await registerScheduleFromConversation(conv.id, { mode: 'confirmed', title: '菊岡正博 来所打合せ', kind: 'meeting', location: '事務所', proposed: { title: '依頼者 打合せ', location: null }, slots });
    const rows = db().select().from(schema.eventStyleExamples).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'conversation', kind: 'meeting', proposedContent: '打合せ', finalContent: '来所打合せ', proposedLocation: null, finalLocation: '事務所' });
  });
});
