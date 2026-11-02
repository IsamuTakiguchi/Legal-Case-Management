import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { listClientPersons } from './clientPersons.js';
import { googleAccount } from '../integrations/google.js';
import { clientPersonLabel } from '@lcm/shared';

/** CC の候補 1 件 */
export interface CcCandidate {
  address: string;
  /** 誰のアドレスか（「依頼者（2 つ目のアドレス）」「佐藤花子（総務部）」「このやり取りの CC」など） */
  label: string;
}

export interface CcSuggestions {
  /** はじめから入れておく CC（この宛先に前回送ったときの CC。前回 CC を外していれば空） */
  defaults: string[];
  /** 押すと CC に入る候補 */
  candidates: CcCandidate[];
}

/** 「山田 <a@x.jp>, b@y.jp」のようなヘッダーからアドレスだけを取り出す */
export function parseAddressList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v !== 'string' || !v.trim()) return [];
  return [...v.matchAll(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0]);
}

/**
 * 依頼者へのメールに付ける CC の既定と候補。
 * - 既定: 同じ宛先（To）に前回送ったメールの CC（毎回同じ人を CC に入れる運用をそのまま続けられる）
 * - 候補: 依頼者のほかのアドレス、法人の担当者・ご家族などの窓口、このやり取りで CC に入っていた人
 * 宛先（To）と自分のアドレスは除く
 */
export function ccSuggestions(opts: { clientId?: number | null; toAddress?: string | null; conversationId?: number | null }): CcSuggestions {
  const d = db();
  const to = opts.toAddress?.trim().toLowerCase() ?? '';
  const me = googleAccount()?.toLowerCase() ?? '';
  const skip = (a: string) => !a || a.toLowerCase() === to || a.toLowerCase() === me;
  const candidates: CcCandidate[] = [];
  const seen = new Set<string>();
  const add = (address: string, label: string) => {
    const key = address.trim().toLowerCase();
    if (skip(key) || seen.has(key)) return;
    seen.add(key);
    candidates.push({ address: address.trim(), label });
  };

  const client = opts.clientId ? d.select().from(schema.clients).where(eq(schema.clients.id, opts.clientId)).get() : null;
  if (client) {
    client.emails.forEach((e) => add(e, `${client.name}（依頼者）`));
    for (const p of listClientPersons(client.id)) p.emails.forEach((e) => add(e, clientPersonLabel(p)));
  }

  // 同じ宛先に送ったメール（この会話、または同じ依頼者の Gmail の会話）
  const convIds = new Set<number>();
  if (opts.conversationId) convIds.add(opts.conversationId);
  if (client && to) {
    for (const c of d
      .select({ id: schema.conversations.id, addr: schema.conversations.counterpartAddress })
      .from(schema.conversations)
      .where(and(eq(schema.conversations.clientId, client.id), eq(schema.conversations.channel, 'gmail')))
      .all()) {
      if ((c.addr ?? '').toLowerCase() === to) convIds.add(c.id);
    }
  }
  const msgs = convIds.size
    ? d
        .select({ direction: schema.messages.direction, raw: schema.messages.raw, conversationId: schema.messages.conversationId })
        .from(schema.messages)
        .where(inArray(schema.messages.conversationId, [...convIds]))
        .orderBy(desc(schema.messages.sentAt))
        .limit(200)
        .all()
    : [];
  // 既定は、こちらから送った直近のメールの CC
  const lastOut = msgs.find((m) => m.direction === 'out');
  const defaults = lastOut ? parseAddressList((lastOut.raw as { cc?: unknown } | null)?.cc).filter((a) => !skip(a)) : [];
  // このやり取りで CC に入っていた人（相手が CC を付けてきた人も含む）
  for (const m of msgs) {
    const cc = parseAddressList((m.raw as { cc?: unknown } | null)?.cc);
    cc.forEach((a) => add(a, 'これまでの CC'));
  }
  defaults.forEach((a) => add(a, '前回の CC'));
  return { defaults, candidates };
}
