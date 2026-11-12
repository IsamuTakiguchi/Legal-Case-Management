import { desc, eq, asc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, schema } from '../db/index.js';

type TurnRow = typeof schema.secretaryTurns.$inferSelect;

export function newThreadId(): string {
  return randomUUID();
}

/** 頼みごと 1 回分（頼んだ文・秘書の返事・案）を残す */
export function recordTurn(input: {
  threadId: string;
  request: string;
  reply: string;
  context?: { clientId?: number; caseId?: number; conversationId?: number } | null;
  actions: unknown[];
  previews: unknown[];
  questions: string[];
}): TurnRow {
  return db()
    .insert(schema.secretaryTurns)
    .values({
      threadId: input.threadId,
      request: input.request,
      reply: input.reply,
      context: input.context ?? null,
      actions: input.actions,
      previews: input.previews,
      questions: input.questions,
    })
    .returning()
    .get();
}

/** 案を登録した結果を残す */
export function recordApplied(turnId: number, applied: unknown[]) {
  db().update(schema.secretaryTurns).set({ applied, appliedAt: new Date().toISOString() }).where(eq(schema.secretaryTurns.id, turnId)).run();
}

export interface SecretaryThreadSummary {
  threadId: string;
  /** 最初に頼んだ文 */
  first: string;
  /** 最後に頼んだ文 */
  last: string;
  turns: number;
  /** 登録できたものの数 */
  appliedOk: number;
  startedAt: string;
  updatedAt: string;
}

/** これまでのやり取り（新しい順）。q を渡すと、頼んだ文・返事にその語を含むものだけ */
export function listThreads(opts: { limit?: number; q?: string } = {}): SecretaryThreadSummary[] {
  const limit = opts.limit ?? 50;
  const q = opts.q?.trim();
  const rows = db().select().from(schema.secretaryTurns).orderBy(desc(schema.secretaryTurns.createdAt)).limit(2000).all();
  const byThread = new Map<string, TurnRow[]>();
  for (const r of rows) byThread.set(r.threadId, [...(byThread.get(r.threadId) ?? []), r]);
  const out: SecretaryThreadSummary[] = [];
  for (const [threadId, list] of byThread) {
    const turns = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (q && !turns.some((t) => t.request.includes(q) || t.reply.includes(q))) continue;
    const appliedOk = turns.reduce((n, t) => n + ((t.applied ?? []) as { ok?: boolean }[]).filter((x) => x?.ok).length, 0);
    out.push({
      threadId,
      first: turns[0]!.request,
      last: turns[turns.length - 1]!.request,
      turns: turns.length,
      appliedOk,
      startedAt: turns[0]!.createdAt,
      updatedAt: turns[turns.length - 1]!.createdAt,
    });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}

/** ひと続きのやり取り（古い順） */
export function getThread(threadId: string): TurnRow[] {
  return db().select().from(schema.secretaryTurns).where(eq(schema.secretaryTurns.threadId, threadId)).orderBy(asc(schema.secretaryTurns.createdAt), asc(schema.secretaryTurns.id)).all();
}

export function deleteThread(threadId: string): { deleted: number } {
  const n = db().delete(schema.secretaryTurns).where(eq(schema.secretaryTurns.threadId, threadId)).run().changes;
  return { deleted: n };
}
