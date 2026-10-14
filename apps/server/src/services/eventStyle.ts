import { desc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { familyName } from '@lcm/shared';
import { logger } from '../logger.js';

/**
 * 予定の件名・場所の書き方を学ぶ。
 * 記録や会話から予定を登録するとき、AI の案（件名の内容・場所）を本人が直して登録したら、その直し方を残す。
 * 次に同じ案が出たら同じように直し（applyEventStyle）、AI にも手本として渡す（eventStyleHints）。
 * 例: 内容「次回期日（損害賠償請求事件）」・場所「双方ウェブ」→ 内容「WEB裁判（損害賠償請求事件）」・場所「ブース」
 */

type ExampleRow = typeof schema.eventStyleExamples.$inferSelect;

/** 比べるときの形（全角・半角、空白の違いを無視） */
const norm = (s: string | null | undefined) =>
  (s ?? '')
    .normalize('NFKC')
    .replace(/[\s　]+/g, '')
    .trim();

/** 末尾の括弧書き（事件名など）。入れ子の括弧も 1 つとして扱う */
function parenOf(content: string): string {
  return /（[^（）]*(?:（[^（）]*）[^（）]*)*）\s*$/.exec(content)?.[0]?.trim() ?? '';
}

/** 括弧書きを除いた内容（「次回期日（損害賠償請求事件）」→「次回期日」） */
export function coreOf(content: string): string {
  const p = parenOf(content);
  return (p ? content.slice(0, content.lastIndexOf(p)) : content).trim();
}

/** 件名から、先頭の依頼者名（会話の表示名も）と末尾の「仮」を除いた内容 */
export function contentOfTitle(title: string, clientName: string | (string | null | undefined)[] | null): string {
  let t = title.trim().replace(/[\s　]*仮$/, '');
  const given = (Array.isArray(clientName) ? clientName : [clientName]).map((n) => n?.trim()).filter((n): n is string => !!n);
  if (given.length) {
    const names = given.flatMap((n) => [n, n.replace(/[\s　]+/g, ''), familyName(n)]).filter(Boolean).sort((a, b) => b.length - a.length);
    for (const n of names) {
      if (t.startsWith(n)) {
        t = t.slice(n.length);
        break;
      }
    }
  }
  return t.replace(/^[\s　]+/, '').trim();
}

/** 直して登録したら、その直し方を残す（直していなければ何もしない） */
export function recordEventStyle(input: {
  source: 'note' | 'conversation';
  kind: string;
  clientId?: number | null;
  clientName: string | (string | null | undefined)[] | null;
  proposedTitle?: string | null;
  finalTitle: string;
  proposedLocation?: string | null;
  finalLocation?: string | null;
}): boolean {
  if (!input.proposedTitle) return false;
  const proposedContent = contentOfTitle(input.proposedTitle, input.clientName);
  const finalContent = contentOfTitle(input.finalTitle, input.clientName);
  const proposedLocation = input.proposedLocation?.trim() || null;
  const finalLocation = input.finalLocation?.trim() || null;
  const contentChanged = norm(coreOf(proposedContent)) !== norm(coreOf(finalContent));
  const locationChanged = norm(proposedLocation) !== norm(finalLocation);
  if (!proposedContent || !finalContent || (!contentChanged && !locationChanged)) return false;
  db()
    .insert(schema.eventStyleExamples)
    .values({ source: input.source, kind: input.kind, proposedContent, finalContent, proposedLocation, finalLocation, clientId: input.clientId ?? null })
    .run();
  logger.info({ kind: input.kind, from: [proposedContent, proposedLocation], to: [finalContent, finalLocation] }, '予定の件名・場所の直し方を覚えました');
  return true;
}

function recentExamples(limit = 300): ExampleRow[] {
  return db().select().from(schema.eventStyleExamples).orderBy(desc(schema.eventStyleExamples.id)).limit(limit).all();
}

/**
 * 覚えた直し方を、AI の案に当てる。
 * - 内容: 同じ種別で、内容（括弧書きを除く）と場所が前と同じ案なら、前に直したとおりの内容にする（今回の括弧書きは残す）
 * - 場所: 前と同じ場所の案なら、前に直したとおりの場所にする
 * いちばん新しい直し方を使う
 */
export function applyEventStyle(input: { kind: string; content: string; location: string | null }): { content: string; location: string | null; applied: boolean } {
  const rows = recentExamples();
  const core = norm(coreOf(input.content));
  const loc = norm(input.location);
  let content = input.content;
  let location = input.location;
  let applied = false;
  const hit = rows.find((r) => r.kind === input.kind && norm(coreOf(r.proposedContent)) === core && norm(r.proposedLocation) === loc && norm(coreOf(r.finalContent)) !== core);
  if (hit) {
    const paren = parenOf(input.content);
    // 前に直したとき括弧書きを消していたら、今回も付けない
    const keepParen = !!parenOf(hit.finalContent) || !parenOf(hit.proposedContent);
    content = `${coreOf(hit.finalContent)}${keepParen ? paren : ''}`;
    applied = true;
  }
  if (loc) {
    // 同じ種別の直し方を優先し、無ければ種別を問わず同じ場所の直し方を使う
    const matches = (r: ExampleRow) => norm(r.proposedLocation) === loc && norm(r.finalLocation) !== loc;
    const lh = rows.find((r) => r.kind === input.kind && matches(r)) ?? rows.find(matches);
    if (lh) {
      location = lh.finalLocation;
      applied = true;
    }
  }
  return { content, location, applied };
}

/** AI に渡す手本（新しい順に、重複を除いて） */
export function eventStyleHints(limit = 8): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const r of recentExamples(100)) {
    const key = `${r.kind}|${norm(coreOf(r.proposedContent))}|${norm(r.proposedLocation)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const from = `「${coreOf(r.proposedContent)}」${r.proposedLocation ? `（場所「${r.proposedLocation}」）` : ''}`;
    const to = `「${coreOf(r.finalContent)}」${r.finalLocation !== r.proposedLocation ? `、場所は「${r.finalLocation ?? '（空）'}」` : ''}`;
    lines.push(`・${from} → ${to}`);
    if (lines.length >= limit) break;
  }
  return lines.length ? `本人はカレンダーの件名・場所を次のように直して登録しています。同じような予定は、この書き方に合わせてください（括弧書きの事件名などはそのまま）。\n${lines.join('\n')}` : '';
}
