import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-stale-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { staleUnanswered, clearStaleUnanswered } = await import('../services/inbox.js');
const { navCounts } = await import('../routes/settings.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());
beforeEach(() => {
  db().delete(schema.messages).run();
  db().delete(schema.conversations).run();
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

function seedConv(patch: Record<string, unknown>) {
  return db()
    .insert(schema.conversations)
    .values({ channel: 'chatwork', externalThreadId: String(Math.random()), needsReply: true, archived: false, ...patch })
    .returning()
    .get();
}

describe('しばらく動きのない未返信', () => {
  it('最終受信が指定の日数より前のものだけ数える', () => {
    seedConv({ lastInboundAt: daysAgo(120), lastMessageAt: daysAgo(120) });
    seedConv({ lastInboundAt: daysAgo(45), lastMessageAt: daysAgo(45) });
    seedConv({ lastInboundAt: daysAgo(2), lastMessageAt: daysAgo(2) });

    const r = staleUnanswered(30);
    expect(r.total).toBe(3);
    expect(r.stale).toBe(2);
    expect(r.byChannel).toEqual({ chatwork: 2 });
    expect(new Date(r.oldest!).getTime()).toBeLessThan(Date.now() - 100 * 86400_000);
    // 期間を変えると対象も変わる
    expect(staleUnanswered(90).stale).toBe(1);
    expect(staleUnanswered(1).stale).toBe(3);
  });

  it('未返信でないもの・アーカイブ済みのものは数えない', () => {
    seedConv({ lastInboundAt: daysAgo(120), lastMessageAt: daysAgo(120), needsReply: false });
    seedConv({ lastInboundAt: daysAgo(120), lastMessageAt: daysAgo(120), archived: true });
    const r = staleUnanswered(30);
    expect(r.total).toBe(0);
    expect(r.stale).toBe(0);
  });

  it('最終受信が無いものは、会話の最終日時で見る', () => {
    seedConv({ lastInboundAt: null, lastMessageAt: daysAgo(120) });
    expect(staleUnanswered(30).stale).toBe(1);
    // どちらも無ければ対象外（判断できないので触らない）
    db().delete(schema.conversations).run();
    seedConv({ lastInboundAt: null, lastMessageAt: null });
    expect(staleUnanswered(30).stale).toBe(0);
  });

  it('チャネルごとの内訳を返す', () => {
    seedConv({ channel: 'chatwork', lastInboundAt: daysAgo(60), lastMessageAt: daysAgo(60) });
    seedConv({ channel: 'chatwork', lastInboundAt: daysAgo(60), lastMessageAt: daysAgo(60) });
    seedConv({ channel: 'gmail', lastInboundAt: daysAgo(60), lastMessageAt: daysAgo(60) });
    expect(staleUnanswered(30).byChannel).toEqual({ chatwork: 2, gmail: 1 });
  });

  it('まとめて対応済みにすると、メニューとアイコンの数が減る', () => {
    seedConv({ lastInboundAt: daysAgo(120), lastMessageAt: daysAgo(120), unread: 5 });
    seedConv({ lastInboundAt: daysAgo(60), lastMessageAt: daysAgo(60), unread: 3 });
    const keep = seedConv({ lastInboundAt: daysAgo(2), lastMessageAt: daysAgo(2), unread: 1 });
    expect(navCounts().inbox).toBe(3);

    expect(clearStaleUnanswered(30, 'resolve')).toBe(2);
    expect(navCounts().inbox).toBe(1);
    expect(navCounts().unread).toBe(1);
    expect(staleUnanswered(30).stale).toBe(0);
    // 最近のものは残る。会話自体も消さない
    const rows = db().select().from(schema.conversations).all();
    expect(rows.length).toBe(3);
    expect(rows.find((r) => r.id === keep.id)!.needsReply).toBe(true);
    expect(rows.filter((r) => r.archived).length).toBe(0);
  });

  it('まとめてアーカイブすると受信箱から外れる', () => {
    seedConv({ lastInboundAt: daysAgo(120), lastMessageAt: daysAgo(120) });
    expect(clearStaleUnanswered(30, 'archive')).toBe(1);
    const row = db().select().from(schema.conversations).all()[0]!;
    expect(row.archived).toBe(true);
    expect(row.needsReply).toBe(false);
    expect(navCounts().inbox).toBe(0);
  });

  it('対象が無ければ何もしない', () => {
    seedConv({ lastInboundAt: daysAgo(2), lastMessageAt: daysAgo(2) });
    expect(clearStaleUnanswered(30, 'resolve')).toBe(0);
    expect(navCounts().inbox).toBe(1);
  });
});
