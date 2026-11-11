import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-evnotice-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.STORAGE_BACKEND = 'local';
process.env.LOCAL_CLIENT_ROOT = path.join(tmp, 'clients');
// Chatwork を「設定済み」にして送り先を作る。AI は使わない（下書きは決まった文で出る）
process.env.CHATWORK_API_TOKEN = 'test-token';

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { prepareEventNotice } = await import('../services/eventNotice.js');
const { ClientUnreachableError } = await import('../services/hearingNotice.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

let room = 9100;
function seed(opts: { name?: string; reachable?: boolean } = {}) {
  room += 1;
  const client = db()
    .insert(schema.clients)
    .values({ name: opts.name ?? '山田 太郎', chatworkRoomId: opts.reachable === false ? null : room })
    .returning()
    .get();
  const kase = db().insert(schema.cases).values({ clientId: client.id, title: '山田 離婚' }).returning().get();
  return { client, kase };
}

function event(v: { clientId: number | null; caseId: number | null; startAt: string; endAt: string; kind?: string; status?: string; location?: string | null; description?: string | null; title?: string }) {
  return db()
    .insert(schema.calendarEvents)
    .values({
      googleEventId: `g-${Math.random()}`,
      clientId: v.clientId,
      caseId: v.caseId,
      kind: v.kind ?? 'meeting',
      title: v.title ?? '山田 打合せ',
      startAt: v.startAt,
      endAt: v.endAt,
      location: v.location ?? null,
      description: v.description ?? null,
      status: v.status ?? 'confirmed',
    })
    .returning()
    .get();
}

describe('決まった予定を依頼者に報告', () => {
  it('日時（終わりの時刻まで）・場所・WEB 会議の URL を本文に入れ、依頼者との会話で送れるようにする', async () => {
    const { client, kase } = seed();
    // 11/20(金) 14:00〜15:30 JST
    const ev = event({ clientId: null, caseId: kase.id, startAt: '2026-11-20T05:00:00.000Z', endAt: '2026-11-20T06:30:00.000Z', description: 'Zoom: https://zoom.us/j/123456789\nパスコード: abc123' });
    const n = await prepareEventNotice(ev.id);
    expect(n.clientId).toBe(client.id);
    expect(n.caseTitle).toBe('山田 離婚');
    expect(n.channel).toBe('chatwork');
    expect(n.conversationId).toBeTypeOf('number');
    expect(n.info.text).toContain('日時: 11月20日(金)14時〜15時30分');
    expect(n.text).toContain('山田様');
    expect(n.text).toContain('打合せの日程が決まりました');
    expect(n.text).toContain('https://zoom.us/j/123456789');
    expect(n.text).toContain('パスコード: abc123');
    const conv = db().select().from(schema.conversations).all().find((c) => c.id === n.conversationId);
    expect(conv?.clientId).toBe(client.id);
  });

  it('終日の期日は日付だけを入れる', async () => {
    const { client, kase } = seed({ name: '佐藤 花子' });
    const ev = event({ clientId: client.id, caseId: kase.id, kind: 'hearing', title: '第2回口頭弁論', startAt: '2026-11-24T15:00:00.000Z', endAt: '2026-11-25T15:00:00.000Z', location: '奈良地裁 302号法廷' });
    const n = await prepareEventNotice(ev.id);
    expect(n.info.text).toContain('日時: 11月25日(水)終日');
    expect(n.text).toContain('場所: 奈良地裁 302号法廷');
    expect(n.text).toContain('期日の日程が決まりました');
  });

  it('仮押さえ・依頼者の無い予定は報告しない。連絡先が無ければ登録を促す', async () => {
    const { client, kase } = seed({ name: '鈴木 一郎' });
    const hold = event({ clientId: client.id, caseId: kase.id, kind: 'hold', status: 'tentative', startAt: '2026-11-26T01:00:00.000Z', endAt: '2026-11-26T02:00:00.000Z' });
    await expect(prepareEventNotice(hold.id)).rejects.toThrow('確定してから');
    const orphan = event({ clientId: null, caseId: null, startAt: '2026-11-26T01:00:00.000Z', endAt: '2026-11-26T02:00:00.000Z' });
    await expect(prepareEventNotice(orphan.id)).rejects.toThrow('依頼者に紐付いていません');
    const unreachable = seed({ name: '田中 次郎', reachable: false });
    const ev = event({ clientId: unreachable.client.id, caseId: unreachable.kase.id, startAt: '2026-11-26T01:00:00.000Z', endAt: '2026-11-26T02:00:00.000Z' });
    await expect(prepareEventNotice(ev.id)).rejects.toBeInstanceOf(ClientUnreachableError);
  });
});
