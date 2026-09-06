import { and, eq, desc, sql, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { generateText } from '../integrations/anthropic.js';
import { gmailApi } from '../integrations/google.js';
import { normalizeGmailMessage } from '../channels/gmail.js';
import * as cw from '../channels/chatwork.js';
import { getSetting } from './settings.js';
import { listTemplates, fillTemplate, accessNote } from './templates.js';
import { CHANNEL_LABEL, familyName, type Channel, type DraftRequest } from '@lcm/shared';
import { logger } from '../logger.js';
import { ftsQuery } from './inbox.js';

export type StyleSample = typeof schema.styleSamples.$inferSelect;

export function addStyleSample(s: { channel: Channel; text: string; contextText?: string | null; source: string; externalId?: string | null; clientId?: number | null; sentAt?: string | null }) {
  const text = s.text.trim();
  if (text.length < 8) return;
  db()
    .insert(schema.styleSamples)
    .values({ channel: s.channel, text, contextText: s.contextText ?? null, source: s.source, externalId: s.externalId ?? null, clientId: s.clientId ?? null, sentAt: s.sentAt ?? null })
    .onConflictDoNothing()
    .run();
}

/** 過去返信の類似検索（FTS5 BM25、同一チャネル・同一依頼者を優先） */
/** チャネルごとのサンプル数 */
export function sampleCount(channel: Channel): number {
  return db().select({ id: schema.styleSamples.id }).from(schema.styleSamples).where(eq(schema.styleSamples.channel, channel)).all().length;
}

/** このチャネル専用の文体として扱えるだけのサンプルがあるか（Gmail と LINE で文体を分ける運用に対応） */
const STRICT_MIN = 5;

export function findSimilarSamples(query: string, opts: { channel?: Channel; clientId?: number | null; limit?: number }): StyleSample[] {
  const limit = opts.limit ?? 8;
  const d = db();
  const results: StyleSample[] = [];
  const seen = new Set<number>();
  // 同じチャネルのサンプルが十分あれば、他チャネルの文面は混ぜない（メールの文体が LINE に出ないように）
  const strict = !!opts.channel && sampleCount(opts.channel) >= STRICT_MIN;
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (q.length >= 3) {
    try {
      const hits = d
        .all<{ rowid: number }>(sql`SELECT rowid FROM style_samples_fts WHERE style_samples_fts MATCH ${ftsOr(q)} ORDER BY bm25(style_samples_fts) LIMIT 60`)
        .map((r) => r.rowid);
      if (hits.length) {
        const rows = d
          .select()
          .from(schema.styleSamples)
          .where(strict ? and(inArray(schema.styleSamples.id, hits), eq(schema.styleSamples.channel, opts.channel!)) : inArray(schema.styleSamples.id, hits))
          .all();
        const rank = new Map(hits.map((id, i) => [id, i]));
        rows.sort((a, b) => score(a, opts) - score(b, opts) || (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
        for (const r of rows) {
          if (results.length >= limit) break;
          results.push(r);
          seen.add(r.id);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'FTS 検索に失敗');
    }
  }
  if (results.length < limit) {
    // 同一依頼者・同一チャネルの最近の送信を補う
    const conds = [];
    if (opts.channel) conds.push(eq(schema.styleSamples.channel, opts.channel));
    const recent = d
      .select()
      .from(schema.styleSamples)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(schema.styleSamples.createdAt))
      .limit(30)
      .all()
      .sort((a, b) => score(a, opts) - score(b, opts));
    for (const r of recent) {
      if (results.length >= limit) break;
      if (!seen.has(r.id)) {
        results.push(r);
        seen.add(r.id);
      }
    }
  }
  return results;
}

function score(s: StyleSample, opts: { channel?: Channel; clientId?: number | null }): number {
  let sc = 0;
  if (opts.clientId && s.clientId === opts.clientId) sc -= 2;
  if (opts.channel && s.channel === opts.channel) sc -= 1;
  if (s.source === 'edited') sc -= 0.5;
  return sc;
}

/**
 * 文中の語を OR でつなぐ。trigram トークナイザは 3 文字以上の連続一致が必要なので、
 * 区切り文字と助詞で分割した語に加え、日本語部分は 3 文字の窓（trigram）も候補にする。
 */
function ftsOr(text: string): string {
  const segments = text.split(/[\s　、。,.!?！？「」（）()\n:：;；・]+/).filter(Boolean);
  const terms = new Set<string>();
  for (const seg of segments) {
    if (seg.length >= 3) terms.add(seg);
    for (const w of seg.split(/(?:を|の|に|は|が|で|と|も|へ|から|まで|より|など|について|ので|ため)/)) {
      if (w.length >= 3) terms.add(w);
    }
    if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(seg)) {
      for (let i = 0; i + 3 <= seg.length && terms.size < 40; i++) {
        const g = seg.slice(i, i + 3);
        if (/^[のをにはがでとも]|[のをにはがでとも]$/.test(g)) continue;
        terms.add(g);
      }
    }
  }
  const list = [...terms].slice(0, 40);
  if (list.length === 0) return ftsQuery(text);
  return list.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

export function getStyleProfile(channel: Channel | 'all' = 'all'): string {
  const row = db().select().from(schema.styleProfiles).where(eq(schema.styleProfiles.channel, channel)).get();
  return row?.profileMarkdown ?? '';
}

export function saveStyleProfile(channel: Channel | 'all', md: string) {
  db()
    .insert(schema.styleProfiles)
    .values({ channel, profileMarkdown: md, generatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: schema.styleProfiles.channel, set: { profileMarkdown: md, generatedAt: new Date().toISOString() } })
    .run();
}

/** コーパスから文体プロファイルを生成 */
export async function generateStyleProfile(channel: Channel | 'all' = 'all'): Promise<string> {
  const rows = db()
    .select()
    .from(schema.styleSamples)
    .where(channel === 'all' ? undefined : eq(schema.styleSamples.channel, channel))
    .orderBy(desc(schema.styleSamples.createdAt))
    .limit(120)
    .all();
  if (rows.length < 5) throw new Error('サンプルが少なすぎます（5 件以上必要）。送信済みメールの取込を先に実行してください。');
  const corpus = rows.map((r, i) => `--- サンプル${i + 1} (${CHANNEL_LABEL[r.channel as Channel] ?? r.channel}) ---\n${r.text.slice(0, 1200)}`).join('\n\n');
  const md = await generateText({
    system:
      'あなたは文体分析の専門家です。与えられた弁護士本人が書いたメッセージ群から、本人の文体の特徴を Markdown で簡潔にまとめます。分析結果は後で「本人らしい返信文を生成する」ための指示書として使います。',
    user: `以下は弁護士本人が依頼者等に送った実際のメッセージです。次の観点で文体プロファイルを作成してください。

1. 敬語のレベルと口調（丁寧さ、断定/婉曲の傾向）
2. 冒頭の書き出し（宛名の書き方、挨拶の有無と定型句）
3. 結びの定型句と署名の有無・形
4. 段落・改行の癖（1文ごとに改行するか、空行の使い方、箇条書きの使い方）
5. よく使う言い回し・語彙（実例を 10 個程度引用）
6. 避けている表現（絵文字、記号、カジュアルな言葉など）
7. チャネル別の違い（メール／Chatwork／LINE で長さや丁寧さが変わるか）
8. 依頼者への説明の仕方（法律用語の噛み砕き方、根拠の示し方、次のアクションの示し方）

出力は Markdown 見出し付きで 800 字程度。固有名詞（依頼者名など）は含めないでください。

${corpus}`,
    effort: 'medium',
    maxTokens: 4000,
  });
  saveStyleProfile(channel, md);
  return md;
}

const CHANNEL_RULES: Record<Channel, string> = {
  gmail: 'メールとして書く。件名は不要。冒頭に宛名（○○様）、必要に応じて結びと署名（署名は下記の署名設定があれば末尾に付ける）。',
  chatwork: 'Chatwork のチャットとして書く。宛名は「○○様」程度で簡潔に、署名は付けない。長すぎない。',
  line: 'LINE のメッセージとして書く。簡潔で読みやすく、1通 500 字以内を目安。署名は付けない。改行で読みやすく。',
};

export interface DraftContext {
  channel: Channel;
  clientName?: string | null;
  counterpartName?: string | null;
  thread: { direction: 'in' | 'out'; body: string; sentAt: string; senderName?: string | null }[];
  caseSummary?: string | null;
}

/** 本人らしい返信文の下書きを生成 */
export async function draftReply(req: DraftRequest, ctx: DraftContext, clientId?: number | null): Promise<string> {
  const templates = listTemplates();
  const lastInbound = [...ctx.thread].reverse().find((m) => m.direction === 'in');
  const surname = familyName(ctx.clientName ?? ctx.counterpartName ?? '');

  let templateNote = '';
  if (req.templateKey) {
    const t = templates.find((x) => x.key === req.templateKey);
    if (t) {
      const filled = fillTemplate(t.body, { 姓: surname, アクセス案内: accessNote(), ...req.extra });
      templateNote = `\n\n【使用するテンプレート（この文面を骨子として、必要な情報を埋め、自然に整えてください。〔〕で残っている箇所は指示や文脈から補い、分からなければ〔〕のまま残す）】\n${filled}`;
    }
  }

  const query = [req.instruction, lastInbound?.body ?? ''].join(' ');
  const samples = findSimilarSamples(query, { channel: ctx.channel, clientId, limit: 8 });
  const ownProfile = getStyleProfile(ctx.channel);
  const profile = ownProfile || getStyleProfile('all');
  const profileNote = ownProfile
    ? ''
    : `（${CHANNEL_LABEL[ctx.channel]} 専用の分析はまだありません。以下は全チャネル共通の分析なので、${CHANNEL_LABEL[ctx.channel]} の制約に合わせて長さと丁寧さを調整してください）\n`;
  const signature = ctx.channel === 'gmail' ? getSetting('signature_gmail') : '';
  const lawyer = getSetting('lawyer_name');

  const system = `あなたは弁護士${lawyer ? `（${lawyer}）` : ''}本人として、依頼者や関係者への返信文を本人の文体で作成するアシスタントです。
本人の文体プロファイルと過去の実際の返信例を忠実に再現してください。過剰に丁寧すぎたり、逆に馴れ馴れしくならないよう、プロファイルと実例に合わせます。
法的な断定や新しい事実の創作はせず、指示にない約束（日時・金額・見通し）を勝手に書かないでください。不明な点は〔要確認〕と明記します。
出力は返信本文のみ。前置きや説明、引用符は不要です。

【チャネルの制約】
${CHANNEL_RULES[ctx.channel]}
${signature ? `\n【署名（メールの末尾に付ける）】\n${signature}` : ''}

【本人の文体プロファイル（${CHANNEL_LABEL[ctx.channel]}）】
${profileNote}${profile || '（未生成。実例から推測してください）'}

【本人の過去の返信例（${CHANNEL_LABEL[ctx.channel]}${samples.some((s) => s.channel !== ctx.channel) ? '、一部は他チャネル' : ''}）】
${samples.map((s, i) => `--- 例${i + 1} ---\n${s.text.slice(0, 900)}`).join('\n\n') || '（なし）'}`;

  const threadText = ctx.thread
    .slice(-8)
    .map((m) => `[${m.direction === 'in' ? (m.senderName ?? '相手') : '自分'} ${m.sentAt.slice(0, 16).replace('T', ' ')}]\n${m.body.slice(0, 1500)}`)
    .join('\n\n');

  const user = `相手: ${ctx.clientName ?? ctx.counterpartName ?? '不明'}${surname ? `（宛名は「${surname}様」）` : ''}
${ctx.caseSummary ? `\n事件の現状メモ:\n${ctx.caseSummary}\n` : ''}
【これまでのやり取り（新しいものが下）】
${threadText || '（なし）'}

【返信の指示】
${req.instruction || '直近の相手のメッセージに対して適切に返信する'}${templateNote}`;

  const text = await generateText({ system, user, effort: 'medium', maxTokens: 4000 });
  return text;
}

/** 送信済みメッセージを学習サンプルに追加（AI 下書きから編集された場合は edited） */
export function learnFromSent(channel: Channel, finalText: string, generatedText: string | null, opts: { externalId: string; clientId?: number | null; contextText?: string | null }) {
  const source = generatedText && generatedText.trim() !== finalText.trim() ? 'edited' : generatedText ? 'accepted' : 'sent';
  if (source === 'accepted') return; // AI が生成したまま送った文は本人の文体とは限らないので学習しない
  addStyleSample({ channel, text: finalText, contextText: opts.contextText ?? null, source, externalId: opts.externalId, clientId: opts.clientId ?? null, sentAt: new Date().toISOString() });
}

/** Gmail の送信済みメールをコーパスとして取り込む */
export async function importGmailSent(opts: { maxMessages?: number; newerThanDays?: number } = {}): Promise<number> {
  const gmail = gmailApi();
  const max = opts.maxMessages ?? 300;
  const q = `in:sent newer_than:${opts.newerThanDays ?? 730}d -filename:ics`;
  let pageToken: string | undefined;
  let count = 0;
  const myProfile = await gmail.users.getProfile({ userId: 'me' });
  const me = (myProfile.data.emailAddress ?? '').toLowerCase();
  while (count < max) {
    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: Math.min(100, max - count), pageToken });
    const ids = list.data.messages ?? [];
    if (ids.length === 0) break;
    for (const m of ids) {
      if (!m.id) continue;
      const exists = db().select({ id: schema.styleSamples.id }).from(schema.styleSamples).where(and(eq(schema.styleSamples.channel, 'gmail'), eq(schema.styleSamples.externalId, m.id))).get();
      if (exists) {
        count++;
        continue;
      }
      const full = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
      const norm = normalizeGmailMessage(full.data, [me]);
      if (!norm || norm.direction !== 'out') continue;
      const body = stripQuotedReply(norm.body);
      if (body.length < 20) continue;
      addStyleSample({ channel: 'gmail', text: body, contextText: norm.subject ?? null, source: 'import', externalId: m.id, sentAt: norm.sentAt });
      count++;
    }
    pageToken = list.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  return count;
}

/** 引用部分（> や On ... wrote:）を落として自分の文だけ残す */
export function stripQuotedReply(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) break;
    if (/^(On .+ wrote:|.+年.+月.+日.+<.+@.+>:|-----Original Message-----|----- 元のメッセージ -----|\d{4}\/\d{1,2}\/\d{1,2}.+<.+@.+>)/.test(l.trim())) break;
    out.push(l);
  }
  return out.join('\n').trim();
}

/** Chatwork の自分の発言を取り込む（各ルーム直近 100 件） */
export async function importChatworkMine(): Promise<number> {
  const me = await cw.chatworkMe();
  const rooms = await cw.listRooms();
  let count = 0;
  for (const room of rooms) {
    if (room.type === 'my') continue;
    let msgs: cw.ChatworkMessage[] = [];
    try {
      msgs = await cw.fetchRoomMessages(room.room_id);
    } catch (err) {
      logger.warn({ err, room: room.room_id }, 'Chatwork メッセージ取得に失敗');
      continue;
    }
    const client = db().select().from(schema.clients).where(eq(schema.clients.chatworkRoomId, room.room_id)).get();
    for (const m of msgs) {
      if (m.account.account_id !== me.account_id) continue;
      const body = cw.stripChatworkMarkup(m.body);
      if (body.length < 20) continue;
      addStyleSample({ channel: 'chatwork', text: body, source: 'import', externalId: m.message_id, clientId: client?.id ?? null, sentAt: new Date(m.send_time * 1000).toISOString() });
      count++;
    }
  }
  return count;
}

/** テキスト（1 行 = 1 サンプル、または空行区切り）を手動取込 */
export function importPlainText(channel: Channel, text: string): number {
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length >= 8);
  let n = 0;
  for (const b of blocks) {
    addStyleSample({ channel, text: b, source: 'manual' });
    n++;
  }
  return n;
}

/**
 * チャネル別プロファイルの自動更新。サンプルが 5 件以上あり、未生成か、生成後に 10 件以上増えていれば作り直す。
 */
export async function refreshStyleProfiles(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const profiles = new Map(db().select().from(schema.styleProfiles).all().map((p) => [p.channel, p.generatedAt]));
  for (const ch of ['all', 'gmail', 'line', 'chatwork'] as const) {
    const rows = db()
      .select({ createdAt: schema.styleSamples.createdAt })
      .from(schema.styleSamples)
      .where(ch === 'all' ? undefined : eq(schema.styleSamples.channel, ch))
      .all();
    if (rows.length < 5) {
      out[ch] = `skip (${rows.length} 件)`;
      continue;
    }
    const gen = profiles.get(ch);
    const added = gen ? rows.filter((r) => r.createdAt > gen).length : rows.length;
    if (gen && added < 10) {
      out[ch] = `up to date (+${added})`;
      continue;
    }
    try {
      await generateStyleProfile(ch);
      out[ch] = `generated (${rows.length} 件)`;
    } catch (err) {
      out[ch] = `error: ${String((err as Error).message ?? err).slice(0, 100)}`;
    }
  }
  return out;
}

export function styleStats() {
  const rows = db().select({ channel: schema.styleSamples.channel, source: schema.styleSamples.source }).from(schema.styleSamples).all();
  const byChannel: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const r of rows) {
    byChannel[r.channel] = (byChannel[r.channel] ?? 0) + 1;
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
  }
  const profiles = db().select({ channel: schema.styleProfiles.channel, generatedAt: schema.styleProfiles.generatedAt }).from(schema.styleProfiles).all();
  return { total: rows.length, byChannel, bySource, profiles };
}
