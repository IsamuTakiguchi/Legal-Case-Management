import { z } from 'zod';
import { eq, and, inArray, desc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { generateStructured } from '../integrations/anthropic.js';
import { familyName, formatJaDateTime, toJstParts, OPEN_CASE_STATUSES, type EventKind } from '@lcm/shared';
import { createCalendarEvent, createHoldSet } from './court.js';
import { getSetting } from './settings.js';

/**
 * 会話（LINE / Chatwork / Gmail）の日程調整のやり取りを読み取り、
 * 確定した日時 1 件、または未確定の候補日時（複数）を取り出す。
 */
const extractSchema = z.object({
  status: z.enum(['confirmed', 'candidates', 'none']).describe('confirmed=日時が 1 つに確定している / candidates=候補が挙がっているが未確定 / none=日程の話がない'),
  content: z.string().describe('予定の内容を短く（例: 打合せ、新規相談、WEB相談、電話打合せ、第2回期日）。件名の一部になる'),
  kind: z.enum(['meeting', 'consult', 'hearing']).describe('meeting=打合せ / consult=相談（新規相談・WEB相談） / hearing=裁判所の期日'),
  web: z.boolean().describe('Zoom や Google Meet など WEB 会議での実施か'),
  durationMinutes: z.number().int().describe('所要時間（分）。言及がなければ 60'),
  location: z.string().nullable().describe('場所の言及があればそのまま。なければ null'),
  slots: z
    .array(
      z.object({
        startAt: z.string().describe('開始日時。ISO 8601 で日本時間のオフセット付き（例: 2026-09-10T14:00:00+09:00）'),
        timeKnown: z.boolean().describe('時刻が本文に明示されていたか（false なら仮の時刻）'),
        quote: z.string().describe('根拠となった本文の一節（短く）'),
        by: z.enum(['counterpart', 'me']).describe('その日時を言い出したのが相手か自分か'),
      }),
    )
    .describe('確定なら 1 件、候補なら挙がっている順に複数。日程の話がなければ空'),
  note: z.string().describe('判断の根拠や注意点を日本語で 1〜2 文（例: 相手は火曜午後を希望、時刻は未指定）'),
});
export type ExtractedSchedule = z.infer<typeof extractSchema>;

const WD = ['日', '月', '火', '水', '木', '金', '土'];

export async function extractScheduleFromConversation(conversationId: number, opts: { maxMessages?: number } = {}) {
  const d = db();
  const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get();
  if (!conv) throw new Error('会話が見つかりません');
  const client = conv.clientId ? d.select().from(schema.clients).where(eq(schema.clients.id, conv.clientId)).get() : null;
  const msgs = d
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(desc(schema.messages.sentAt))
    .limit(opts.maxMessages ?? 20)
    .all()
    .reverse();
  if (msgs.length === 0) throw new Error('メッセージがありません');
  const me = getSetting('lawyer_name') || '自分';
  const who = client?.name ?? conv.counterpartName ?? '相手';
  const transcript = msgs
    .map((m) => {
      const p = toJstParts(new Date(m.sentAt));
      const when = `${p.year}/${p.month}/${p.day}(${WD[p.weekday]}) ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
      const speaker = m.direction === 'out' ? `${me}（自分）` : (m.senderName ?? who);
      return `[${when}] ${speaker}:\n${m.body.slice(0, 1500)}`;
    })
    .join('\n\n');
  const now = new Date();
  const np = toJstParts(now);
  const today = `${np.year}年${np.month}月${np.day}日(${WD[np.weekday]})`;
  const start = getSetting('business_hours_start') || '9';
  const end = getSetting('business_hours_end') || '18';
  const result = await generateStructured({
    system: [
      '日本の法律事務所の弁護士と依頼者・関係者のメッセージのやり取りから、面談・打合せ・WEB相談・裁判の期日などの日程を読み取ります。',
      `今日は ${today} です。「来週火曜」「明後日」「月末」などの相対表現は今日を基準に、日本時間で具体的な日付に直してください。年が書かれていなければ、今日以降で最も近い日付とします。`,
      `時刻が「午前」だけなら ${start}:00 以降の切りのよい時刻（10:00 など）、「午後」だけなら 14:00、時刻の言及がなければ 10:00 を仮に置き timeKnown=false にしてください。営業時間は ${start}:00〜${end}:00 です。`,
      '双方が同じ日時で合意している（「その日でお願いします」「承知しました」など）場合だけ confirmed とし、片方が候補を出しただけ、または相手が別の候補を出した状態は candidates とします。',
      '候補は本文に出てきた順に、重複せずすべて挙げてください。過去の日時や、すでに断られた候補は含めません。',
      '本文にない情報は作らないでください。',
    ].join('\n'),
    user: `相手: ${who}\n自分: ${me}\n\n--- やり取り（古い順） ---\n${transcript}`,
    schema: extractSchema,
    effort: 'medium',
    maxTokens: 2000,
  });
  const durationMinutes = result.durationMinutes > 0 ? result.durationMinutes : 60;
  const slots = result.slots
    .map((s) => {
      const startAt = new Date(s.startAt);
      if (Number.isNaN(startAt.getTime())) return null;
      return { startAt: startAt.toISOString(), endAt: new Date(startAt.getTime() + durationMinutes * 60_000).toISOString(), timeKnown: s.timeKnown, quote: s.quote, by: s.by };
    })
    .filter((s): s is NonNullable<typeof s> => !!s);
  const content = result.content.trim() || (result.kind === 'hearing' ? '期日' : result.kind === 'consult' ? (result.web ? 'WEB相談' : '相談') : '打合せ');
  const counterpartName = client ? familyName(client.name) : familyName(conv.counterpartName ?? who);
  return {
    ...result,
    durationMinutes,
    content,
    slots,
    clientId: conv.clientId,
    clientName: client?.name ?? null,
    counterpartName,
    /** 登録時の件名（確定用） */
    title: `${counterpartName} ${content}`.trim(),
    summary: slots.length ? slots.map((s) => `${formatJaDateTime(new Date(s.startAt))}〜`).join(' / ') : '',
  };
}

export interface RegisterScheduleInput {
  mode: 'confirmed' | 'holds';
  title: string;
  kind: EventKind;
  slots: { startAt: string; endAt: string }[];
  location?: string | null;
  description?: string | null;
  caseId?: number | null;
}

/** 抽出結果（ユーザーが確認・修正したもの）をカレンダーへ登録 */
export async function registerScheduleFromConversation(conversationId: number, input: RegisterScheduleInput) {
  const d = db();
  const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get();
  if (!conv) throw new Error('会話が見つかりません');
  if (!input.slots.length) throw new Error('日時がありません');
  const client = conv.clientId ? d.select().from(schema.clients).where(eq(schema.clients.id, conv.clientId)).get() : null;
  let caseId = input.caseId ?? null;
  if (!caseId && client) {
    const rank: Record<string, number> = { active: 0, wrapup: 1, consultation: 2 };
    const open = d.select().from(schema.cases).where(and(eq(schema.cases.clientId, client.id), inArray(schema.cases.status, OPEN_CASE_STATUSES))).all();
    caseId = open.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))[0]?.id ?? null;
  }
  const description = [input.description ?? '', `会話から登録（受信箱 #${conversationId}）`].filter(Boolean).join('\n');
  if (input.mode === 'confirmed') {
    const sl = input.slots[0];
    const row = await createCalendarEvent({
      title: input.title,
      startAt: sl.startAt,
      endAt: sl.endAt,
      kind: input.kind === 'hold' ? 'meeting' : input.kind,
      clientId: client?.id ?? null,
      caseId,
      location: input.location ?? null,
      description,
    });
    return { mode: 'confirmed' as const, events: [row] };
  }
  const who = client ? familyName(client.name) : familyName(conv.counterpartName ?? '');
  const content = input.title.replace(new RegExp(`^${who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`), '').replace(/\s*仮$/, '').trim() || input.title;
  const r = await createHoldSet({
    title: content,
    kind: input.kind === 'hold' ? 'meeting' : input.kind,
    clientId: client?.id ?? null,
    caseId,
    counterpartName: client ? null : who,
    location: input.location ?? null,
    description,
    slots: input.slots,
  });
  return { mode: 'holds' as const, sessionId: r.sessionId, events: r.events };
}
