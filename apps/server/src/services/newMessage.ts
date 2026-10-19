import { and, desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import * as cw from '../channels/chatwork.js';
import { isConfigured } from '../config.js';
import { CHANNEL_LABEL, type Channel } from '@lcm/shared';
import { availableChannels, ensureClientConversation } from './hearingNotice.js';
import { clientOwnConversations } from './contacts.js';
import { getClientPerson, listClientPersons } from './clientPersons.js';

/**
 * こちらから新しく送る（返信ではなく、依頼者や事務局へこちらから連絡する）ときの宛先選び。
 * 宛先を選んだら、その相手との会話（無ければ作る）を開き、いつもの画面（AI 下書き・添付・送信予約）で書いて送る
 */

export interface ClientSendTarget {
  /** 「gmail:」「line:12」のように、チャネルと担当者・窓口の組 */
  key: string;
  channel: Channel;
  channelLabel: string;
  /** 宛先（メールアドレス・LINE・ルーム） */
  to: string;
  personId: number | null;
  /** 宛名（依頼者名、または担当者・窓口「鈴木 美香（長女）」） */
  recipient: string;
}

/** 依頼者に送れる宛先と、送れない理由（連絡先が未登録など）。メールは前のやり取りの続きにもできる */
export function clientSendTargets(clientId: number) {
  const client = db().select().from(schema.clients).where(eq(schema.clients.id, clientId)).get();
  if (!client) throw new Error('依頼者が見つかりません');
  const targets: ClientSendTarget[] = availableChannels(client).map((r) => ({ key: `${r.channel}:${r.personId ?? ''}`, channel: r.channel, channelLabel: CHANNEL_LABEL[r.channel] ?? r.channel, to: r.to, personId: r.personId, recipient: r.recipient }));
  const persons = listClientPersons(clientId);
  const anyEmail = client.emails.length > 0 || persons.some((p) => p.emails.length > 0);
  const anyLine = !!client.lineUserId || persons.some((p) => p.lineUserId);
  const anyRoom = !!client.chatworkRoomId || persons.some((p) => p.chatworkRoomId);
  const missing: string[] = [];
  if (!anyEmail) missing.push('メールアドレスが未登録です（依頼者ページの「連絡先」で登録できます）');
  else if (!isConfigured('google')) missing.push('Gmail が未接続です');
  if (!anyLine) missing.push('LINE が未連携です（依頼者ページの「連絡先」から友だち追加を案内できます）');
  else if (!isConfigured('line')) missing.push('LINE 公式アカウントが未設定です');
  if (!anyRoom) missing.push('Chatwork のルームが未設定です');
  else if (!isConfigured('chatwork')) missing.push('Chatwork が未設定です');
  // メールは、前のやり取りの続き（同じスレッド）にもできる
  const gmailThreads = clientOwnConversations(clientId)
    .filter((c) => c.channel === 'gmail' && !c.externalThreadId.startsWith('new:'))
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''))
    .slice(0, 5)
    .map((c) => ({ conversationId: c.id, subject: c.subject ?? '（件名なし）', lastMessageAt: c.lastMessageAt, personId: c.clientPersonId ?? null }));
  return { clientId, clientName: client.name, targets, missing, gmailThreads };
}

/**
 * 依頼者との会話を開く（無ければ作る）。
 * メールは件名を付けて新しいスレッドにする（threadConversationId を渡すと、そのメールの続き）。LINE・Chatwork は相手ごとに 1 つの会話
 */
export function startClientConversation(clientId: number, input: { channel: Channel; personId?: number | null; subject?: string | null; threadConversationId?: number | null }): { conversationId: number } {
  const client = db().select().from(schema.clients).where(eq(schema.clients.id, clientId)).get();
  if (!client) throw new Error('依頼者が見つかりません');
  const personId = input.personId ?? null;
  const target = clientSendTargets(clientId).targets.find((t) => t.channel === input.channel && t.personId === personId);
  if (!target) throw new Error(`${CHANNEL_LABEL[input.channel] ?? input.channel} ではこの宛先に送れません（連絡先が未登録か、チャネルが未設定です）`);
  if (input.channel !== 'gmail') return { conversationId: ensureClientConversation(client, input.channel, personId).id };
  if (input.threadConversationId) {
    const conv = db().select().from(schema.conversations).where(eq(schema.conversations.id, input.threadConversationId)).get();
    if (!conv || conv.channel !== 'gmail' || conv.clientId !== clientId) throw new Error('続けるメールが見つかりません');
    if (conv.archived) db().update(schema.conversations).set({ archived: false }).where(eq(schema.conversations.id, conv.id)).run();
    return { conversationId: conv.id };
  }
  const subject = input.subject?.trim();
  if (!subject) throw new Error('メールの件名を入力してください');
  const person = personId ? getClientPerson(personId) : null;
  const email = (person ?? client).emails[0];
  const row = db()
    .insert(schema.conversations)
    .values({ channel: 'gmail', externalThreadId: `new:${client.id}:${Date.now()}`, clientId: client.id, clientPersonId: person?.id ?? null, counterpartName: person?.name ?? client.name, counterpartAddress: email ?? null, subject })
    .returning()
    .get();
  return { conversationId: row.id };
}

/** 事務局に送る宛先（Chatwork のルームと、宛先に付ける事務局メンバー） */
export async function staffSendTargets() {
  if (!isConfigured('chatwork')) return { configured: false, staff: [], rooms: [], defaultRoomId: null as number | null };
  const staff = db()
    .select()
    .from(schema.staffMembers)
    .where(eq(schema.staffMembers.active, true))
    .all()
    .map((s) => ({ id: s.id, name: s.name, chatworkAccountId: s.chatworkAccountId }));
  const rooms = (await cw.listRooms().catch(() => []))
    .filter((r) => r.type !== 'my')
    .map((r) => ({ roomId: r.room_id, name: r.name, type: r.type }));
  // 既定のルーム: 前に事務局へ確認・報告を送ったルーム（無ければ最初のグループ）
  const last = db()
    .select({ room: schema.conversations.externalThreadId })
    .from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .where(and(eq(schema.messages.channel, 'chatwork'), eq(schema.messages.direction, 'out'), sql`json_extract(${schema.messages.raw}, '$.staffAsk') is not null`))
    .orderBy(desc(schema.messages.sentAt))
    .get();
  const lastRoom = last ? Number(last.room) : null;
  const defaultRoomId = (lastRoom && rooms.some((r) => r.roomId === lastRoom) ? lastRoom : null) ?? rooms.find((r) => r.type === 'group')?.roomId ?? rooms[0]?.roomId ?? null;
  return { configured: true, staff, rooms, defaultRoomId };
}

/** Chatwork のルームとの会話を開く（無ければ作る） */
export function startRoomConversation(roomId: number, name: string | null): { conversationId: number } {
  const existing = db()
    .select()
    .from(schema.conversations)
    .where(and(eq(schema.conversations.channel, 'chatwork'), eq(schema.conversations.externalThreadId, String(roomId))))
    .get();
  if (existing) {
    if (existing.archived) db().update(schema.conversations).set({ archived: false }).where(eq(schema.conversations.id, existing.id)).run();
    return { conversationId: existing.id };
  }
  const row = db()
    .insert(schema.conversations)
    .values({ channel: 'chatwork', externalThreadId: String(roomId), counterpartName: name ?? `ルーム ${roomId}`, counterpartAddress: String(roomId), subject: name ?? null })
    .returning()
    .get();
  return { conversationId: row.id };
}
