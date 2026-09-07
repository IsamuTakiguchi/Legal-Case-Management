import { and, eq, inArray, desc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import * as cw from '../channels/chatwork.js';
import { isConfigured } from '../config.js';
import { familyName, OPEN_CASE_STATUSES } from '@lcm/shared';
import { logger } from '../logger.js';

/**
 * 事務局メンバー。Chatwork は依頼者ではなく内部の事務局からの伝言が中心なので、
 * 登録した人からのメッセージは「事務局」として扱い、依頼者の未紐付け警告を出さない。
 */
export type StaffRow = typeof schema.staffMembers.$inferSelect;

export function listStaff(opts: { includeInactive?: boolean } = {}): StaffRow[] {
  const rows = db().select().from(schema.staffMembers).orderBy(schema.staffMembers.name).all();
  return opts.includeInactive ? rows : rows.filter((r) => r.active);
}

export function createStaff(input: { name: string; kana?: string | null; chatworkAccountId?: number | null; note?: string | null }): StaffRow {
  return db()
    .insert(schema.staffMembers)
    .values({ name: input.name.trim(), kana: input.kana?.trim() || null, chatworkAccountId: input.chatworkAccountId ?? null, note: input.note?.trim() || null })
    .returning()
    .get();
}

export function updateStaff(id: number, patch: { name?: string; kana?: string | null; chatworkAccountId?: number | null; note?: string | null; active?: boolean }): StaffRow {
  const set: Partial<typeof schema.staffMembers.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.kana !== undefined) set.kana = patch.kana?.trim() || null;
  if (patch.chatworkAccountId !== undefined) set.chatworkAccountId = patch.chatworkAccountId;
  if (patch.note !== undefined) set.note = patch.note?.trim() || null;
  if (patch.active !== undefined) set.active = patch.active;
  db().update(schema.staffMembers).set(set).where(eq(schema.staffMembers.id, id)).run();
  const row = db().select().from(schema.staffMembers).where(eq(schema.staffMembers.id, id)).get();
  if (!row) throw new Error('事務局メンバーが見つかりません');
  return row;
}

/** 担当になっている事件があれば担当を外してから削除 */
export function deleteStaff(id: number) {
  db().update(schema.cases).set({ staffId: null }).where(eq(schema.cases.staffId, id)).run();
  db().delete(schema.staffMembers).where(eq(schema.staffMembers.id, id)).run();
}

export function staffByChatworkAccount(accountId: number | null | undefined): StaffRow | null {
  if (!accountId) return null;
  return db().select().from(schema.staffMembers).where(and(eq(schema.staffMembers.chatworkAccountId, accountId), eq(schema.staffMembers.active, true))).get() ?? null;
}

/** Chatwork の参加ルームからメンバーを集める（事務局メンバー登録の候補。自分は除く） */
export async function listChatworkAccounts(): Promise<{ accountId: number; name: string; rooms: string[] }[]> {
  if (!isConfigured('chatwork')) return [];
  const me = await cw.chatworkMe().catch(() => null);
  const rooms = await cw.listRooms();
  const map = new Map<number, { accountId: number; name: string; rooms: string[] }>();
  for (const r of rooms) {
    if (r.type === 'my') continue;
    let members: cw.ChatworkMember[] = [];
    try {
      members = await cw.roomMembers(r.room_id);
    } catch (err) {
      logger.warn({ err, room: r.room_id }, 'Chatwork ルームのメンバー取得に失敗');
      continue;
    }
    for (const m of members) {
      if (me && m.account_id === me.account_id) continue;
      const cur = map.get(m.account_id) ?? { accountId: m.account_id, name: m.name, rooms: [] };
      if (cur.rooms.length < 5) cur.rooms.push(r.name);
      map.set(m.account_id, cur);
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

/** 事件専用の Chatwork ルームなら、その事件 */
export function caseForChatworkRoom(roomId: number | null | undefined) {
  if (!roomId) return null;
  return db().select().from(schema.cases).where(eq(schema.cases.chatworkRoomId, roomId)).orderBy(desc(schema.cases.updatedAt)).get() ?? null;
}

/**
 * 伝言の本文から依頼者を推定する（フルネーム → 別名 → 姓 の順。姓は 2 文字以上で、1 人にだけ一致する場合のみ）。
 * 進行中の事件があれば、その事件も返す。
 */
export function guessClientFromText(text: string): { clientId: number; caseId: number | null } | null {
  const t = text.replace(/[\s　]/g, '');
  if (!t) return null;
  const clients = db().select().from(schema.clients).where(eq(schema.clients.archived, false)).all();
  const strong = clients.filter((c) => {
    const names = [c.name, ...c.aliases].map((n) => n.replace(/[\s　]/g, '')).filter((n) => n.length >= 2);
    return names.some((n) => t.includes(n));
  });
  let hit = strong.length === 1 ? strong[0] : null;
  if (!hit && strong.length === 0) {
    const bySurname = clients.filter((c) => {
      const f = familyName(c.name).replace(/[\s　]/g, '');
      return f.length >= 2 && t.includes(f);
    });
    if (bySurname.length === 1) hit = bySurname[0];
  }
  if (!hit) return null;
  const rank: Record<string, number> = { active: 0, wrapup: 1, consultation: 2 };
  const open = db().select().from(schema.cases).where(and(eq(schema.cases.clientId, hit.id), inArray(schema.cases.status, OPEN_CASE_STATUSES))).all();
  const kase = open.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.updatedAt.localeCompare(a.updatedAt))[0];
  return { clientId: hit.id, caseId: kase?.id ?? null };
}
