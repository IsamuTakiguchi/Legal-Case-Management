import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { ingestMessage } from './inbox.js';
import { learnFromSent } from './style.js';
import { getSetting } from './settings.js';
import { isLineGroupThread } from '../channels/line.js';
import type { Channel } from '@lcm/shared';

/**
 * アプリの外（LINE公式アカウントのアプリ・管理画面のチャットなど）で送ったメッセージを、会話に「自分の送信」として記録する。
 * LINE はチャット画面から送った分を Webhook で知らせず、送信履歴を取る API も無いので、自動では取り込めない。
 * 記録するだけで、相手には何も送らない。送った時刻より後に相手から返事があれば「未返信」はそのまま残す
 */
export async function recordSentElsewhere(conversationId: number, input: { text: string; sentAt?: string | null }) {
  const conv = db().select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get();
  if (!conv) throw new Error('会話が見つかりません');
  const text = input.text.trim();
  if (!text) throw new Error('記録する本文を入力してください');
  const sentAt = input.sentAt ? new Date(input.sentAt) : new Date();
  if (Number.isNaN(sentAt.getTime())) throw new Error('送った日時を読めません');
  if (sentAt.getTime() > Date.now() + 5 * 60_000) throw new Error('送った日時が未来になっています');
  const channel = conv.channel as Channel;
  const { message } = await ingestMessage(
    {
      channel,
      externalThreadId: conv.externalThreadId,
      externalId: `manual:${randomUUID()}`,
      direction: 'out',
      sentAt: sentAt.toISOString(),
      senderName: getSetting('lawyer_name') || '自分',
      subject: conv.subject,
      body: text,
      attachments: [],
      raw: { manual: true },
      identity: {
        channel,
        email: conv.counterpartAddress,
        lineUserId: channel === 'line' && !isLineGroupThread(conv.externalThreadId) ? conv.externalThreadId : null,
        chatworkRoomId: channel === 'chatwork' ? Number(conv.externalThreadId) : null,
      },
    },
    { processAttachments: false },
  );
  // 自分で書いた文なので、文体の見本にも使う
  learnFromSent(channel, text, null, { externalId: message.externalId, clientId: conv.clientId, contextText: null });
  return { messageId: message.id };
}
