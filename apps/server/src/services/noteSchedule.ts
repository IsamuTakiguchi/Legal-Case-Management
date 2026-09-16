import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { generateStructured } from '../integrations/anthropic.js';
import { findFreeSlots, type Slot } from './scheduling.js';
import { businessHours, fmtHm, getSettingInt } from './settings.js';
import { CASE_NOTE_KIND_LABEL, formatJaDateTime, toJstParts, type CaseNoteKind, type EventKind, type SchedulePreferences } from '@lcm/shared';

/**
 * 記録（電話・打合せ・期日メモ）から、次に決めるべき予定を読み取って候補日時まで出す。
 * 「次回は来週の午後で」と電話で決めた内容を、そのままカレンダーの空きに当てて仮押さえに持っていく。
 */

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const HM_RE = /^(\d{1,2}):(\d{2})$/;

const noteScheduleSchema = z.object({
  found: z.boolean().describe('この記録に「これから日程を決める予定」が書かれているか。日時が既に確定しているだけの記録や、日程の話がない記録は false'),
  content: z.string().describe('予定の内容を短く（例: 打合せ、進捗報告の打合せ、WEB相談、次回期日の打合せ）。件名の一部になる'),
  kind: z.enum(['meeting', 'consult', 'hearing', 'other']).describe('meeting=打合せ / consult=相談 / hearing=裁判所の期日 / other=その他'),
  web: z.boolean().nullable().describe('WEB 会議（Zoom 等）なら true、来所なら false、不明なら null'),
  durationMinutes: z.number().int().nullable().describe('所要時間（分）。言及がなければ null'),
  earliest: z.string().nullable().describe('この日以降（YYYY-MM-DD）。「来週」「お盆明け」なども日付に直す。なければ null'),
  latest: z.string().nullable().describe('この日まで（YYYY-MM-DD）。「今月中」「期日の 1 週間前まで」なども日付に直す。なければ null'),
  weekdays: z.array(z.number().int().min(0).max(6)).describe('希望の曜日（0=日,1=月,…,6=土）。「平日」は 1〜5。指定がなければ空'),
  timeRanges: z
    .array(z.object({ from: z.string().describe('HH:MM'), to: z.string().describe('HH:MM') }))
    .describe('希望の時間帯。「午前」→ 09:00-12:00、「午後」→ 13:00-17:00、「夕方」→ 16:00-18:00 のように具体化。指定がなければ空'),
  avoid: z
    .array(z.object({ from: z.string().describe('ISO 8601（+09:00）'), to: z.string().describe('ISO 8601（+09:00）'), quote: z.string().describe('根拠の一節') }))
    .describe('都合が悪いと書かれている日・時間帯。終日なら 00:00〜翌日 00:00'),
  requested: z
    .array(z.object({ startAt: z.string().describe('ISO 8601（+09:00）。時刻が無ければ 10:00 を仮置き'), quote: z.string().describe('根拠の一節') }))
    .describe('記録の中で具体的に挙がっている候補日時。過ぎたものは除く'),
  quote: z.string().describe('日程の話だと判断した、記録の中の一節（短く）。読み取れなければ空'),
  note: z.string().describe('読み取った内容の要約を日本語で 1〜2 文（例: 次回打合せは来週の午後を希望。9/25 は不可）'),
});

export interface NoteScheduleProposal {
  noteId: number;
  caseId: number;
  caseTitle: string | null;
  clientId: number | null;
  clientName: string | null;
  /** 日程を決めるべき予定が読み取れたか */
  found: boolean;
  /** 件名に使う内容（「打合せ」など） */
  content: string;
  kind: EventKind;
  web: boolean | null;
  durationMinutes: number;
  preferences: SchedulePreferences;
  /** 読み取った条件を 1 行にしたもの */
  summary: string;
  /** 日程の話だと判断した記録の一節 */
  quote: string;
  note: string;
  /** 候補を探した期間 */
  window: { from: string; to: string };
  /** カレンダーの空きから出した候補 */
  slots: Slot[];
  /** 候補が出せなかった理由（あれば） */
  blocked: string | null;
}

/** 記録の中身を、読み取りに渡す 1 つの文章にする */
function noteText(n: typeof schema.caseNotes.$inferSelect): string {
  const parts: string[] = [];
  const p = toJstParts(new Date(n.occurredAt));
  parts.push(`種別: ${CASE_NOTE_KIND_LABEL[n.kind as CaseNoteKind] ?? n.kind}`);
  parts.push(`日時: ${p.year}年${p.month}月${p.day}日(${WD[p.weekday]}) ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`);
  if (n.counterpart) parts.push(`相手: ${n.counterpart}`);
  if (n.gist) parts.push(`要旨: ${n.gist}`);
  if (n.theirSaid.length) parts.push(`相手が言ったこと:\n${n.theirSaid.map((t) => `・${t}`).join('\n')}`);
  if (n.ourSaid.length) parts.push(`こちらが言ったこと:\n${n.ourSaid.map((t) => `・${t}`).join('\n')}`);
  if (n.decisions.length) parts.push(`決定事項: ${n.decisions.join(' / ')}`);
  if (n.nextActions.length) parts.push(`次のアクション:\n${n.nextActions.map((a) => `・${a.title}${a.due ? `（${a.due} まで）` : ''}`).join('\n')}`);
  if (n.rawText) parts.push(`元メモ:\n${n.rawText.slice(0, 3000)}`);
  return parts.join('\n');
}

/** YYYY-MM-DD を日本時間のその日の 0 時として読む */
function jstDay(day: string, endOfDay = false): Date {
  return new Date(`${day}T${endOfDay ? '23:59' : '00:00'}:00+09:00`);
}

export async function proposeScheduleFromNote(
  noteId: number,
  opts: { durationMinutes?: number | null; maxCandidates?: number; from?: string | null; to?: string | null } = {},
): Promise<NoteScheduleProposal> {
  const d = db();
  const n = d.select().from(schema.caseNotes).where(eq(schema.caseNotes.id, noteId)).get();
  if (!n) throw new Error('記録が見つかりません');
  const kase = d.select().from(schema.cases).where(eq(schema.cases.id, n.caseId)).get();
  const clientId = n.clientId ?? kase?.clientId ?? null;
  const client = clientId ? (d.select().from(schema.clients).where(eq(schema.clients.id, clientId)).get() ?? null) : null;

  const np = toJstParts(new Date());
  const today = `${np.year}年${np.month}月${np.day}日(${WD[np.weekday]})`;
  const bh = businessHours();
  const r = await generateStructured({
    purpose: '記録からの日程調整',
    tier: 'light',
    system: [
      '日本の法律事務所の弁護士が残した事件の記録（電話・打合せ・期日のメモ）から、「これから日程を決める必要のある予定」と、その希望条件を読み取ります。',
      `今日は ${today} です。「来週」「月末」「再来週の火曜」などの相対表現は今日を基準に日本時間の日付に直してください。年が無ければ今日以降で最も近い日付とします。`,
      `事務所の営業時間は ${fmtHm(bh.startMin)}〜${fmtHm(bh.endMin)} です。時間帯の希望はこの範囲で具体化してください。`,
      '記録に書かれていることだけを使います。書かれていない希望を作らないでください。',
      '日時がすでに確定していて調整の必要がないもの（「次回期日は 10 月 11 日 13 時 30 分に決まった」など）は found=false にします。これから決めるもの（「次回の打合せは来週の午後で調整」「改めて日程を相談」など）だけ found=true にします。',
      '読み取れなければ found=false にし、ほかは空・null にしてください。',
    ].join('\n'),
    user: `依頼者: ${client?.name ?? '（不明）'}\n事件: ${kase?.title ?? '（不明）'}\n\n--- 記録 ---\n${noteText(n)}`,
    schema: noteScheduleSchema,
    effort: 'medium',
    maxTokens: 2000,
  });

  const isoOk = (v: string) => !Number.isNaN(new Date(v).getTime());
  const dateOk = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const earliest = dateOk(r.earliest);
  const latest = dateOk(r.latest);
  const weekdays = [...new Set(r.weekdays)].sort();
  // 「9:30」のように 1 桁で来ることがあるので、0 埋めしてから前後を比べる（"9:30" < "11:30" は文字列だと偽になる）
  const timeRanges = r.timeRanges
    .filter((t) => HM_RE.test(t.from) && HM_RE.test(t.to))
    .map((t) => ({ from: t.from.padStart(5, '0'), to: t.to.padStart(5, '0') }))
    .filter((t) => t.from < t.to);
  const avoid = r.avoid.filter((a) => isoOk(a.from) && isoOk(a.to)).map((a) => ({ from: new Date(a.from).toISOString(), to: new Date(a.to).toISOString(), quote: a.quote }));
  // 過ぎた候補は出さない
  const now = Date.now();
  const requested = r.requested.filter((x) => isoOk(x.startAt) && new Date(x.startAt).getTime() > now).map((x) => ({ startAt: new Date(x.startAt).toISOString(), quote: x.quote }));
  const preferences: SchedulePreferences = { earliest, latest, weekdays, timeRanges, avoid, requested };

  const durationMinutes = Math.min(480, Math.max(15, opts.durationMinutes ?? r.durationMinutes ?? getSettingInt('default_meeting_minutes', 60)));
  // 探す期間: 希望の下限（なければ明日）から、希望の上限（なければ 3 週間先）まで
  const from = opts.from ? new Date(opts.from) : new Date(Math.max(Date.now() + 86400_000, earliest ? jstDay(earliest).getTime() : 0));
  const to = opts.to ? new Date(opts.to) : latest ? jstDay(latest, true) : new Date(from.getTime() + 21 * 86400_000);

  const parts: string[] = [];
  if (earliest && latest) parts.push(`${earliest.slice(5).replace('-', '/')}〜${latest.slice(5).replace('-', '/')}`);
  else if (earliest) parts.push(`${earliest.slice(5).replace('-', '/')} 以降`);
  else if (latest) parts.push(`${latest.slice(5).replace('-', '/')} まで`);
  if (weekdays.length) parts.push(`${weekdays.map((w) => WD[w]).join('・')}曜`);
  if (timeRanges.length) parts.push(timeRanges.map((t) => `${t.from}〜${t.to}`).join(' / '));
  if (requested.length) parts.push(`希望日時: ${requested.map((x) => formatJaDateTime(new Date(x.startAt))).join(' / ')}`);
  if (avoid.length) parts.push(`不可: ${avoid.map((a) => formatJaDateTime(new Date(a.from))).join(' / ')}`);

  let slots: Slot[] = [];
  let blocked: string | null = null;
  if (r.found) {
    try {
      slots = await findFreeSlots({ from, to, durationMinutes, maxCandidates: opts.maxCandidates ?? 5, preferences });
      if (slots.length === 0) blocked = 'その条件で空いている時間が見つかりませんでした。期間や所要時間を広げてみてください';
    } catch (err) {
      // Google 未接続などで空きが読めないときも、読み取った条件だけは返して手で入れられるようにする
      blocked = `カレンダーの空きを取得できませんでした（${(err as Error).message}）。候補は手で入力できます`;
    }
  }

  return {
    noteId: n.id,
    caseId: n.caseId,
    caseTitle: kase?.title ?? null,
    clientId,
    clientName: client?.name ?? null,
    found: r.found,
    content: r.content.trim() || '打合せ',
    kind: (r.kind === 'other' ? 'meeting' : r.kind) as EventKind,
    web: r.web,
    durationMinutes,
    preferences,
    summary: parts.join('、'),
    quote: r.quote,
    note: r.note,
    window: { from: from.toISOString(), to: to.toISOString() },
    slots,
    blocked,
  };
}
