import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { isLineGroupThread, getLineGroupSummary } from '../channels/line.js';
import { cleanDisplayName } from './identity.js';
import { recomputeConversation } from './inbox.js';
import { isConfigured } from '../config.js';
import { logger } from '../logger.js';

/**
 * 以前は、グループの発言も「発言した人の個人トーク」として取り込んでいた。
 * そのままだと返信がグループではなくその人ひとりに届いてしまうので、
 * 取り込み済みのメッセージを、本来のグループの会話へ移し替える。
 */

/** webhook の生データから、その発言が実際に属していたトークの ID を読む */
export function threadIdFromRaw(raw: unknown): string | null {
  const src = (raw as { source?: { groupId?: string; roomId?: string } } | null)?.source;
  return src?.groupId ?? src?.roomId ?? null;
}

export interface LineGroupRepairResult {
  /** 移し替えたメッセージ数 */
  moved: number;
  /** 新しく作ったグループの会話数 */
  created: number;
  /** 移し替えの対象になった会話（元 → 先） */
  threads: { from: string; to: string; messages: number; groupName: string | null }[];
}

export async function repairLineGroupConversations(): Promise<LineGroupRepairResult> {
  const d = db();
  const out: LineGroupRepairResult = { moved: 0, created: 0, threads: [] };
  const convs = d.select().from(schema.conversations).where(eq(schema.conversations.channel, 'line')).all().filter((c) => !isLineGroupThread(c.externalThreadId));
  for (const conv of convs) {
    const msgs = d.select().from(schema.messages).where(eq(schema.messages.conversationId, conv.id)).all();
    // 受信した発言のうち、実際はグループのものを取り出す
    const byThread = new Map<string, number[]>();
    for (const m of msgs) {
      if (m.direction !== 'in') continue;
      const thread = threadIdFromRaw(m.raw);
      if (!thread || thread === conv.externalThreadId) continue;
      const list = byThread.get(thread) ?? [];
      list.push(m.id);
      byThread.set(thread, list);
    }
    for (const [thread, ids] of byThread) {
      let target = d.select().from(schema.conversations).where(and(eq(schema.conversations.channel, 'line'), eq(schema.conversations.externalThreadId, thread))).get();
      const groupName = isConfigured('line') ? cleanDisplayName((await getLineGroupSummary(thread).catch(() => null))?.groupName) : null;
      if (!target) {
        target = d
          .insert(schema.conversations)
          .values({
            channel: 'line',
            externalThreadId: thread,
            // 元の会話の依頼者・事件を引き継ぐ（同じ相手とのやり取りなので）
            clientId: conv.clientId,
            caseId: conv.caseId,
            counterpartName: groupName ?? 'LINE グループ',
            subject: conv.subject,
            lastMessageAt: conv.lastMessageAt,
          })
          .returning()
          .get();
        out.created++;
      } else if (groupName && !cleanDisplayName(target.counterpartName)) {
        d.update(schema.conversations).set({ counterpartName: groupName }).where(eq(schema.conversations.id, target.id)).run();
      }
      for (const id of ids) {
        d.update(schema.messages).set({ conversationId: target.id }).where(eq(schema.messages.id, id)).run();
      }
      out.moved += ids.length;
      out.threads.push({ from: conv.externalThreadId, to: thread, messages: ids.length, groupName });
      recomputeConversation(target.id);
    }
    if (byThread.size) {
      recomputeConversation(conv.id);
      // 移し替えて空になった会話は一覧から隠す（タスクや下書きが指していることがあるので消さない）
      const left = d.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.conversationId, conv.id)).all();
      if (left.length === 0) d.update(schema.conversations).set({ archived: true }).where(eq(schema.conversations.id, conv.id)).run();
    }
  }
  if (out.moved) logger.info(out, 'LINE グループの発言を、グループの会話へ移し替えました');
  return out;
}
