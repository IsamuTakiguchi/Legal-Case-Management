import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-eventrelink-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

/** Google カレンダーの代わり（予定ごとに、Google 側に書かれた紐付けを文字列で持つ） */
const google = new Map<string, { title: string; startAt: string; endAt: string; priv: Record<string, string> }>();
vi.mock('../integrations/google.js', async (orig) => ({ ...(await orig<typeof import('../integrations/google.js')>()), isGoogleConnected: () => true }));
vi.mock('../integrations/calendar.js', async (orig) => {
  const actual = await orig<typeof import('../integrations/calendar.js')>();
  return {
    ...actual,
    listEvents: async () =>
      [...google.entries()].map(([id, e]) => ({
        id,
        title: e.title,
        startAt: e.startAt,
        endAt: e.endAt,
        status: 'confirmed',
        tag: { clientId: e.priv.clientId ? Number(e.priv.clientId) : undefined, caseId: e.priv.caseId ? Number(e.priv.caseId) : undefined, kind: e.priv.kind as never },
      })),
    updateEvent: async (id: string, patch: { tag?: { kind: string; clientId?: number | null; caseId?: number | null } }) => {
      const e = google.get(id)!;
      if (patch.tag) e.priv = { kind: patch.tag.kind, clientId: actual.tagValue(patch.tag.clientId), caseId: actual.tagValue(patch.tag.caseId) };
      return null;
    },
  };
});

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { relinkEvent, syncCalendar, editCalendarEvent } = await import('../services/court.js');
const { tagValue } = await import('../integrations/calendar.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

const start = new Date(Date.now() + 5 * 86400_000);
start.setUTCHours(1, 30, 0, 0);
const end = new Date(start.getTime() + 3600_000);

describe('予定の紐付けを直す', () => {
  it('別の依頼者の事件に付けてしまった予定を付け替えると、Google にも書き込まれ、同期しても元に戻らない', async () => {
    const kawamura = db().insert(schema.clients).values({ name: '河村亮祐' }).returning().get();
    const kCase = db().insert(schema.cases).values({ clientId: kawamura.id, title: '損害賠償請求事件', caseType: 'civil', status: 'active' }).returning().get();
    const sato = db().insert(schema.clients).values({ name: '佐藤 花子' }).returning().get();
    const sCase = db().insert(schema.cases).values({ clientId: sato.id, title: '離婚調停', caseType: 'divorce', status: 'active' }).returning().get();
    // 河村さんの期日を、間違って佐藤さんの事件に付けてしまった
    google.set('g1', { title: '河村亮祐　WEB裁判（損害賠償請求事件）', startAt: start.toISOString(), endAt: end.toISOString(), priv: { kind: 'hearing', clientId: String(sato.id), caseId: String(sCase.id) } });
    await syncCalendar();
    const ev = db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.googleEventId, 'g1')).get()!;
    expect(ev).toMatchObject({ clientId: sato.id, caseId: sCase.id });

    const fixed = await relinkEvent(ev.id, { clientId: kawamura.id, caseId: kCase.id });
    expect(fixed).toMatchObject({ clientId: kawamura.id, caseId: kCase.id });
    expect(google.get('g1')!.priv).toMatchObject({ clientId: String(kawamura.id), caseId: String(kCase.id) });
    // 次回期日も付け替わる
    expect(db().select().from(schema.cases).where(eq(schema.cases.id, kCase.id)).get()!.nextHearingAt).toBe(ev.startAt);
    expect(db().select().from(schema.cases).where(eq(schema.cases.id, sCase.id)).get()!.nextHearingAt).toBeNull();
    // 同期しても戻らない
    await syncCalendar();
    expect(db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, ev.id)).get()).toMatchObject({ clientId: kawamura.id, caseId: kCase.id });

    // 依頼者だけ変えたら、前の依頼者の事件は外す
    const onlyClient = await relinkEvent(ev.id, { clientId: sato.id });
    expect(onlyClient).toMatchObject({ clientId: sato.id, caseId: null });
    // 事件だけ選んだら、その事件の依頼者に合わせる
    const onlyCase = await relinkEvent(ev.id, { caseId: kCase.id });
    expect(onlyCase).toMatchObject({ clientId: kawamura.id, caseId: kCase.id });
  });

  it('「なし」にした予定は、同期で件名から依頼者を推し量って付け直さない', async () => {
    const yamada = db().insert(schema.clients).values({ name: '山田 太郎' }).returning().get();
    db().insert(schema.cases).values({ clientId: yamada.id, title: '貸金返還', caseType: 'civil', status: 'active' }).returning().get();
    // 件名に「山田」とあるので、紐付けが無ければ同期で山田さんに付く
    google.set('g2', { title: '山田 打合せ', startAt: start.toISOString(), endAt: end.toISOString(), priv: { kind: 'meeting', clientId: '', caseId: '' } });
    await syncCalendar();
    const ev = db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.googleEventId, 'g2')).get()!;
    expect(ev.clientId).toBe(yamada.id);
    // 別の山田さんの予定だったので外す
    const r = await relinkEvent(ev.id, { clientId: null, caseId: null });
    expect(r).toMatchObject({ clientId: null, caseId: null });
    expect(google.get('g2')!.priv).toMatchObject({ clientId: '0', caseId: '0' });
    await syncCalendar();
    expect(db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, ev.id)).get()).toMatchObject({ clientId: null, caseId: null });
  });

  it('予定の編集で依頼者・事件を「なし」にして保存しても、同期で付け直さない', async () => {
    google.set('g3', { title: '山田 電話打合せ', startAt: start.toISOString(), endAt: end.toISOString(), priv: { kind: 'meeting', clientId: '', caseId: '' } });
    await syncCalendar();
    const ev = db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.googleEventId, 'g3')).get()!;
    expect(ev.clientId).not.toBeNull();
    await editCalendarEvent(ev.id, { title: '山田 電話打合せ', clientId: null, caseId: null });
    await syncCalendar();
    expect(db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, ev.id)).get()).toMatchObject({ clientId: null, caseId: null });
    expect([tagValue(0), tagValue(null), tagValue(undefined), tagValue(12)]).toEqual(['0', '', '', '12']);
  });
});
