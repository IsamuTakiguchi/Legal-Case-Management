import { z } from 'zod';
import { eq, and, inArray, desc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { generateStructured } from '../integrations/anthropic.js';
import { familyName, formatJaDateTime, toJstParts, OPEN_CASE_STATUSES, type EventKind } from '@lcm/shared';
import { createCalendarEvent, createHoldSet } from './court.js';
import { getSetting, businessHours, fmtHm } from './settings.js';

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
  const bh = businessHours();
  const start = fmtHm(bh.startMin);
  const end = fmtHm(bh.endMin);
  const result = await generateStructured({
    purpose: '日程の希望の読み取り',
    tier: 'light',
    system: [
      '日本の法律事務所の弁護士と依頼者・関係者のメッセージのやり取りから、面談・打合せ・WEB相談・裁判の期日などの日程を読み取ります。',
      `今日は ${today} です。「来週火曜」「明後日」「月末」などの相対表現は今日を基準に、日本時間で具体的な日付に直してください。年が書かれていなければ、今日以降で最も近い日付とします。`,
      `時刻が「午前」だけなら ${start} 以降の切りのよい時刻（10:00 など）、「午後」だけなら 14:00、時刻の言及がなければ 10:00 を仮に置き timeKnown=false にしてください。営業時間は ${start}〜${end} です。`,
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

const HM_RE = /^(\d{1,2}):(\d{2})$/;
const prefsSchema = z.object({
  found: z.boolean().describe('相手が日程の希望・都合（期間・曜日・時間帯・NG・希望日時）を述べているか'),
  earliest: z.string().nullable().describe('この日以降を希望（YYYY-MM-DD）。「来週以降」なども日付に直す。なければ null'),
  latest: z.string().nullable().describe('この日までを希望（YYYY-MM-DD）。「今月中」なども日付に直す。なければ null'),
  weekdays: z.array(z.number().int().min(0).max(6)).describe('希望の曜日（0=日,1=月,…,6=土）。「平日」は 1〜5。指定がなければ空'),
  timeRanges: z
    .array(z.object({ from: z.string().describe('HH:MM'), to: z.string().describe('HH:MM') }))
    .describe('希望の時間帯。「午前」→ 09:00-12:00、「午後」→ 13:00-17:00、「夕方以降」→ 16:00-18:00、「昼休み」→ 12:00-13:00 のように具体化。指定がなければ空'),
  avoid: z
    .array(z.object({ from: z.string().describe('ISO 8601（+09:00）'), to: z.string().describe('ISO 8601（+09:00）'), quote: z.string().describe('根拠の一節') }))
    .describe('都合が悪いと述べた日・時間帯。終日なら 00:00〜翌日 00:00'),
  requested: z
    .array(z.object({ startAt: z.string().describe('ISO 8601（+09:00）。時刻が無ければ 10:00 を仮置き'), quote: z.string().describe('根拠の一節') }))
    .describe('相手が具体的に挙げた希望日時。既に断った・過ぎたものは除く'),
  web: z.boolean().nullable().describe('WEB（Zoom 等）での実施を希望していれば true、来所を希望していれば false、不明なら null'),
  durationMinutes: z.number().int().nullable().describe('所要時間の言及があれば分。なければ null'),
  note: z.string().describe('相手の希望の要約を日本語で 1〜2 文（例: 火・木の午後を希望。9/25 は終日不可）'),
});
export type ExtractedPreferences = z.infer<typeof prefsSchema>;

/**
 * 会話から「相手の日程の希望」を読み取る（候補日の検索条件にする）。
 * 自分の提案は文脈として渡すが、抽出するのは相手の発言に基づく希望だけ。
 */
export async function extractSchedulePreferences(conversationId: number, opts: { maxMessages?: number } = {}) {
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
  const np = toJstParts(new Date());
  const today = `${np.year}年${np.month}月${np.day}日(${WD[np.weekday]})`;
  const bh = businessHours();
  const r = await generateStructured({
    purpose: '予定の抽出',
    tier: 'light',
    system: [
      '日本の法律事務所の弁護士と依頼者・関係者のメッセージのやり取りから、面談・打合せの日程について「相手（依頼者側）が述べた希望や都合」を読み取ります。',
      `今日は ${today} です。「来週」「月末」「再来週の火曜」などの相対表現は今日を基準に日本時間の日付に直してください。年が無ければ今日以降で最も近い日付とします。`,
      `事務所の営業時間は ${fmtHm(bh.startMin)}〜${fmtHm(bh.endMin)} です。時間帯の希望はこの範囲で具体化してください。`,
      '抽出するのは相手の発言に基づく希望だけです。自分（弁護士）が出した候補は、相手がそれを受けた・断ったかを判断する文脈としてだけ使ってください。',
      '相手が具体的な日時を挙げていれば requested に、都合が悪い日時を挙げていれば avoid に入れます。曖昧な希望（午後がよい、平日は難しい等）は timeRanges / weekdays / earliest / latest に反映します。',
      '本文にない情報は作らないでください。希望が読み取れなければ found=false にし、他は空・null にしてください。',
    ].join('\n'),
    user: `相手: ${who}\n自分: ${me}\n\n--- やり取り（古い順） ---\n${transcript}`,
    schema: prefsSchema,
    effort: 'medium',
    maxTokens: 2000,
  });
  const isoOk = (v: string) => !Number.isNaN(new Date(v).getTime());
  const dateOk = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const timeRanges = r.timeRanges.filter((t) => HM_RE.test(t.from) && HM_RE.test(t.to) && t.from < t.to).map((t) => ({ from: t.from.padStart(5, '0'), to: t.to.padStart(5, '0') }));
  const avoid = r.avoid.filter((a) => isoOk(a.from) && isoOk(a.to)).map((a) => ({ from: new Date(a.from).toISOString(), to: new Date(a.to).toISOString(), quote: a.quote }));
  const requested = r.requested.filter((x) => isoOk(x.startAt)).map((x) => ({ startAt: new Date(x.startAt).toISOString(), quote: x.quote }));
  const weekdays = [...new Set(r.weekdays)].sort();
  const parts: string[] = [];
  const earliest = dateOk(r.earliest);
  const latest = dateOk(r.latest);
  if (earliest && latest) parts.push(`${earliest.slice(5).replace('-', '/')}〜${latest.slice(5).replace('-', '/')}`);
  else if (earliest) parts.push(`${earliest.slice(5).replace('-', '/')} 以降`);
  else if (latest) parts.push(`${latest.slice(5).replace('-', '/')} まで`);
  if (weekdays.length) parts.push(weekdays.map((w) => WD[w]).join('・') + '曜');
  if (timeRanges.length) parts.push(timeRanges.map((t) => `${t.from}〜${t.to}`).join(' / '));
  if (requested.length) parts.push(`希望日時: ${requested.map((x) => formatJaDateTime(new Date(x.startAt))).join(' / ')}`);
  if (avoid.length) parts.push(`不可: ${avoid.map((a) => formatJaDateTime(new Date(a.from))).join(' / ')}`);
  return {
    found: r.found,
    earliest,
    latest,
    weekdays,
    timeRanges,
    avoid,
    requested,
    web: r.web,
    durationMinutes: r.durationMinutes && r.durationMinutes > 0 ? r.durationMinutes : null,
    note: r.note,
    summary: parts.join('、'),
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
