import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import * as cw from '../channels/chatwork.js';
import { isConfigured } from '../config.js';
import { chatworkMyAccountId } from '../jobs/chatworkPoll.js';
import { chatworkSource, chatworkReplyable, updateTask } from './tasks.js';
import { sendToConversation } from './send.js';
import { learnFromSent } from './style.js';
import { logger } from '../logger.js';

/** 返信したあとタスクをどうするか */
export type TaskReplyAfter = 'keep' | 'done' | 'waiting_staff';

export interface TaskReplyResult {
  /** アプリの会話に残ったとき、その会話とメッセージ */
  conversationId: number | null;
  messageId: number | null;
  to: string | null;
  status: string;
}

/**
 * Chatwork で振られたタスクの、元のメッセージと振った人を確かめる。
 * 以前の版で取り込んだタスクで分からなければ、Chatwork に問い合わせて保存する
 */
async function resolveSource(taskId: number) {
  const t = db().select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (!t) throw new Error('タスクが見つかりません');
  if (!t.chatworkTaskId || !t.chatworkRoomId) throw new Error('Chatwork から取り込んだタスクではありません');
  if (t.chatworkMessageId && t.chatworkAssignedById) return t;
  const remote = await cw.roomTask(t.chatworkRoomId, t.chatworkTaskId);
  if (!remote?.message_id) throw new Error('Chatwork でこのタスクが見つかりません（削除された可能性があります）');
  db().update(schema.tasks).set(chatworkSource(remote)).where(eq(schema.tasks.id, t.id)).run();
  return db().select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()!;
}

/**
 * タスクを振った人に、タスクのメッセージへの「返信」として Chatwork で送る。
 * そのルームがアプリの受信箱にあれば、会話にも返信として残す
 */
export async function replyToChatworkTask(taskId: number, input: { text: string; after: TaskReplyAfter }): Promise<TaskReplyResult> {
  if (!isConfigured('chatwork')) throw new Error('Chatwork が未設定です');
  const text = input.text.trim();
  if (!text) throw new Error('返信の本文を入力してください');
  const t = await resolveSource(taskId);
  const me = await chatworkMyAccountId().catch(() => null);
  if (!chatworkReplyable(t, me)) throw new Error('自分で作ったタスクのため、返信する相手がいません');
  const roomId = t.chatworkRoomId!;
  const messageId = t.chatworkMessageId!;

  const conv = db()
    .select()
    .from(schema.conversations)
    .where(and(eq(schema.conversations.channel, 'chatwork'), eq(schema.conversations.externalThreadId, String(roomId))))
    .get();
  const source = conv
    ? db()
        .select()
        .from(schema.messages)
        .where(and(eq(schema.messages.conversationId, conv.id), eq(schema.messages.externalId, messageId)))
        .get()
    : null;

  let result: TaskReplyResult;
  if (conv && source) {
    // 受信箱にタスクのメッセージがあれば、いつもの返信と同じ流れで送る（会話に残り、文体の学習にも使う）
    const out = await sendToConversation(conv.id, { text, attachmentIds: [], driveFiles: [], createWaitingTask: false, replyToMessageId: source.id });
    result = { conversationId: conv.id, messageId: out.messageId, to: t.chatworkAssignedByName, status: t.status };
  } else {
    const prefix = cw.chatworkReplyPrefix(roomId, { accountId: t.chatworkAssignedById!, messageId });
    const posted = await cw.postMessage(roomId, prefix + text);
    learnFromSent('chatwork', text, null, { externalId: posted.message_id, clientId: t.clientId, contextText: t.note?.slice(0, 500) ?? null });
    result = { conversationId: null, messageId: null, to: t.chatworkAssignedByName, status: t.status };
  }

  const now = new Date().toISOString();
  db().update(schema.tasks).set({ chatworkRepliedAt: now, updatedAt: now }).where(eq(schema.tasks.id, t.id)).run();
  if (input.after !== 'keep' && input.after !== t.status) {
    try {
      result.status = updateTask(t.id, { status: input.after }).status;
    } catch (err) {
      logger.warn({ err, taskId: t.id }, '返信後のタスク状態の変更に失敗');
    }
  }
  return result;
}
