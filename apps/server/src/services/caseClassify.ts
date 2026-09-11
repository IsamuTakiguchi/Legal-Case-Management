import { z } from 'zod';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { generateStructured } from '../integrations/anthropic.js';
import { isConfigured } from '../config.js';
import { OPEN_CASE_STATUSES } from '@lcm/shared';
import { logger } from '../logger.js';

/**
 * 同じ依頼者に複数の事件が並行しているとき、メッセージがどの事件の話かを判定して message.caseId に入れる。
 * 事件が 1 件だけなら判定しない（従来どおり依頼者の全メッセージがその事件に出る）
 */
const classifySchema = z.object({
  caseId: z.number().int().nullable().describe('このメッセージが主に関係する事件の ID。どの事件か判断できない、または複数の事件にまたがるなら null'),
  confidence: z.enum(['high', 'medium', 'low']).describe('判定の確度。本文に事件名・相手方名・事件番号・固有の話題があれば high、文脈からの推測なら medium、根拠が薄ければ low'),
  reason: z.string().describe('判定の根拠を日本語で 1 文'),
});
export type CaseClassification = z.infer<typeof classifySchema> & { candidates: number[] };

type Classifier = (input: { message: typeof schema.messages.$inferSelect; context: string; cases: { id: number; title: string; caseType: string; stage: string | null; summary: string | null; courtName: string | null; caseNumber: string | null }[] }) => Promise<z.infer<typeof classifySchema>>;

let classifier: Classifier = async ({ message, context, cases }) => {
  const list = cases
    .map((c) => `- ID ${c.id}: ${c.title}（${c.caseType}${c.stage ? ` / 段階: ${c.stage}` : ''}${c.courtName ? ` / ${c.courtName}` : ''}${c.caseNumber ? ` ${c.caseNumber}` : ''}）${c.summary ? `\n  現状: ${c.summary.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`)
    .join('\n');
  return generateStructured({
    purpose: '事件の振り分け',
    system: [
      '法律事務所の事務補助者として、依頼者とのメッセージが、その依頼者の複数の事件のどれに関するものかを判定します。',
      '本文にある事件名・相手方の名前・裁判所・事件番号・固有の話題（離婚、相続、交通事故、破産など）を手がかりにします。',
      '判断できないとき、挨拶や日程調整だけで事件を特定できないとき、複数の事件にまたがるときは caseId を null にします。推測で決めつけないでください。',
    ].join('\n'),
    user: `依頼者の事件:\n${list}\n\n--- 直前のやり取り（参考） ---\n${context || '（なし）'}\n\n--- 判定するメッセージ（${message.direction === 'in' ? '依頼者から' : '弁護士から'}） ---\n${message.body.slice(0, 2500)}`,
    schema: classifySchema,
    effort: 'low',
    maxTokens: 600,
  });
};

let customClassifier = false;
/** テスト用に判定関数を差し替える */
export function setCaseClassifier(fn: Classifier | null) {
  if (fn) {
    classifier = fn;
    customClassifier = true;
  }
}
function classifierAvailable(): boolean {
  return customClassifier || isConfigured('anthropic');
}

export function openCasesForClient(clientId: number) {
  return db()
    .select()
    .from(schema.cases)
    .where(and(eq(schema.cases.clientId, clientId), inArray(schema.cases.status, OPEN_CASE_STATUSES)))
    .all();
}

/** 1 件のメッセージを判定して事件を入れる。事件が 2 件未満なら何もしない */
export async function classifyMessageCase(messageId: number, opts: { force?: boolean } = {}): Promise<CaseClassification | null> {
  const d = db();
  const m = d.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
  if (!m) return null;
  if (m.caseId && !opts.force) return null;
  const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, m.conversationId)).get();
  const clientId = m.clientId ?? conv?.clientId ?? null;
  if (!conv || !clientId || conv.contactId) return null;
  const cases = openCasesForClient(clientId);
  if (cases.length < 2) return null;
  // 直前のやり取り（事件が決まっているものは事件名を添える）
  const recent = d
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conv.id))
    .orderBy(desc(schema.messages.sentAt))
    .limit(6)
    .all()
    .filter((x) => x.id !== m.id)
    .reverse();
  const context = recent
    .map((x) => {
      const k = x.caseId ? cases.find((c) => c.id === x.caseId) : null;
      return `[${x.direction === 'in' ? '依頼者' : '弁護士'}${k ? ` / 事件: ${k.title}` : ''}] ${x.body.replace(/\s+/g, ' ').slice(0, 300)}`;
    })
    .join('\n');
  const r = await classifier({ message: m, context, cases: cases.map((c) => ({ id: c.id, title: c.title, caseType: c.caseType, stage: c.stage, summary: c.summary, courtName: c.courtName, caseNumber: c.caseNumber })) });
  const valid = r.caseId && cases.some((c) => c.id === r.caseId) ? r.caseId : null;
  if (valid && r.confidence !== 'low') {
    d.update(schema.messages).set({ caseId: valid, clientId }).where(eq(schema.messages.id, m.id)).run();
    logger.info({ messageId: m.id, caseId: valid, confidence: r.confidence }, 'メッセージを事件に振り分けました');
  }
  return { ...r, caseId: valid && r.confidence !== 'low' ? valid : null, candidates: cases.map((c) => c.id) };
}

/** 受信・送信のたびに裏で判定する（依頼者に事件が 2 件以上あるときだけ AI を使う） */
export function maybeClassifyInBackground(messageId: number, clientId: number | null) {
  if (!clientId || !classifierAvailable()) return;
  if (openCasesForClient(clientId).length < 2) return;
  setImmediate(() => {
    classifyMessageCase(messageId).catch((err) => logger.warn({ err, messageId }, 'メッセージの事件判定に失敗'));
  });
}

/** 依頼者のメッセージをまとめて振り分け直す（未確定のものだけ、all で確定済みも含めて判定し直す） */
export async function classifyClientMessages(clientId: number, opts: { all?: boolean; limit?: number } = {}): Promise<{ checked: number; assigned: number; skipped: string | null }> {
  const cases = openCasesForClient(clientId);
  if (cases.length < 2) return { checked: 0, assigned: 0, skipped: '進行中の事件が 2 件未満のため振り分けは不要です' };
  if (!classifierAvailable()) return { checked: 0, assigned: 0, skipped: 'AI（Anthropic）が未設定です' };
  const d = db();
  const convIds = d
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(and(eq(schema.conversations.clientId, clientId), isNull(schema.conversations.contactId)))
    .all()
    .map((x) => x.id);
  if (!convIds.length) return { checked: 0, assigned: 0, skipped: null };
  const msgs = d
    .select()
    .from(schema.messages)
    .where(opts.all ? inArray(schema.messages.conversationId, convIds) : and(inArray(schema.messages.conversationId, convIds), isNull(schema.messages.caseId)))
    .orderBy(desc(schema.messages.sentAt))
    .limit(opts.limit ?? 200)
    .all();
  let assigned = 0;
  for (const m of msgs) {
    const r = await classifyMessageCase(m.id, { force: !!opts.all });
    if (r?.caseId) assigned++;
  }
  return { checked: msgs.length, assigned, skipped: null };
}
