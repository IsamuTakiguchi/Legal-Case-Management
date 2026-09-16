import { sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { ftsQuery } from './inbox.js';
import { CASE_NOTE_KIND_LABEL, CHANNEL_LABEL, TASK_STATUS_LABEL, EVENT_KIND_LABEL, formatJaDateTime, type CaseNoteKind, type Channel, type TaskStatus, type EventKind } from '@lcm/shared';

/**
 * 事務所のデータを横断して探す。
 * 記録・メッセージ・事件・依頼者・タスク・予定・書式・債権者を同じ形にそろえて返し、
 * AI の回答の根拠（引用）にも、そのままの検索結果にも使う。
 */

export const SEARCH_KINDS = ['note', 'message', 'case', 'client', 'task', 'event', 'form', 'creditor'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export const SEARCH_KIND_LABEL: Record<SearchKind, string> = {
  note: '記録',
  message: 'やり取り',
  case: '事件',
  client: '依頼者',
  task: 'タスク',
  event: '予定',
  form: '書式',
  creditor: '債権者',
};

export interface SearchHit {
  kind: SearchKind;
  id: number;
  /** 一覧に出す見出し */
  title: string;
  /** 該当した箇所 */
  snippet: string;
  /** その出来事の日時（無いものは null） */
  at: string | null;
  clientName: string | null;
  caseTitle: string | null;
  /** 押したときに開く画面 */
  link: string;
  /** 当てはまり具合（大きいほど上） */
  score: number;
}

/** 質問の言い回しに出るだけで、資料を絞る役に立たない語 */
const STOP = new Set([
  'どう', 'どうなって', 'どうなっている', 'なって', 'なっている', 'ている', 'ています', 'でしょうか', 'ください', 'します', 'ですか',
  'いる', 'ある', 'した', 'する', 'して', 'どこ', 'いつ', 'だれ', '誰', 'なに', '何', '教え', '教えて', '状況', 'こと', 'もの', 'ため',
  '場合', 'について', 'に関する', 'における', '一覧', '確認', '内容',
]);

/** 検索語を切り出す。2 文字の姓（「山田」）も拾えるようにするため 2 文字から採る */
export function searchTerms(query: string): string[] {
  const out = new Set<string>();
  /** 敬称・末尾の助詞を落とす */
  const trim = (t: string) => t.replace(/(さん|様|氏|先生|について|における|に関する|の件|のこと)$/u, '').replace(/[はがをにでともへやのか]$/u, '');
  const add = (t: string) => {
    const core = trim(t.trim());
    if (core.length < 2 || STOP.has(core)) return;
    // ひらがなだけの短い語は、助詞や言い回しの断片であることが多い
    if (core.length < 3 && /^[ぁ-ん]+$/u.test(core)) return;
    out.add(core);
  };
  for (const seg of query.split(/[\s　、。,.!?！？「」『』（）()\[\]【】:：;；・\n]+/)) {
    const t = seg.trim();
    if (t.length < 2) continue;
    add(t);
    // 「山田さんの査定書はどうなっている」→「山田さん」「査定書」「どうなってい」のように助詞でも切る
    for (const w of t.split(/(?:について|における|に関する|から|まで|より|など|ので|ため|[のをにはがでともへや])/u)) add(w);
  }
  return [...out].slice(0, 12);
}

/** JSON の配列で入っている列（決定事項など）を読む。生 SQL では文字列のまま返る */
function jsonList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string' || !v.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [v];
  } catch {
    return [v];
  }
}

/** LIKE のワイルドカードを打ち消す */
function likeArg(t: string): string {
  return `%${t.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** 本文のうち、検索語の周りだけを切り出す */
function snippetAround(body: string, terms: string[], width = 140): string {
  const text = body.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const at = terms.map((t) => text.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
  if (at < 0) return text.length > width ? `${text.slice(0, width)}…` : text;
  const start = Math.max(0, at - Math.floor(width / 3));
  const cut = text.slice(start, start + width);
  return `${start > 0 ? '…' : ''}${cut}${start + width < text.length ? '…' : ''}`;
}

/** 当てはまった検索語の数で点を付ける。新しいものほど少し上に */
function score(terms: string[], haystack: string, at: string | null): number {
  const text = haystack.toLowerCase();
  let hits = 0;
  for (const t of terms) if (text.includes(t.toLowerCase())) hits++;
  if (hits === 0) return 0;
  // 新しさは差を付けすぎない（古い記録が埋もれないように）
  const days = at ? (Date.now() - new Date(at).getTime()) / 86400_000 : 3650;
  const fresh = Number.isFinite(days) ? Math.max(0, 1 - Math.min(days, 3650) / 3650) : 0;
  return hits * 10 + fresh;
}

/** trigram の索引で引ける語（3 文字以上）だけを使った FTS 検索 */
function ftsIds(table: 'messages_fts' | 'case_notes_fts', terms: string[], limit: number): number[] {
  const long = terms.filter((t) => t.length >= 3);
  if (long.length === 0) return [];
  const q = long.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
  try {
    const rows =
      table === 'messages_fts'
        ? db().all<{ rowid: number }>(sql`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${q} ORDER BY bm25(messages_fts) LIMIT ${limit}`)
        : db().all<{ rowid: number }>(sql`SELECT rowid FROM case_notes_fts WHERE case_notes_fts MATCH ${q} ORDER BY bm25(case_notes_fts) LIMIT ${limit}`);
    return rows.map((r) => r.rowid);
  } catch {
    // 検索語の形によっては FTS が式として受け付けないことがある。そのときは LIKE 側に任せる
    return [];
  }
}

export interface SearchOptions {
  kinds?: SearchKind[];
  /** 返す件数 */
  limit?: number;
  /** 1 種類あたりの上限（1 種類で埋め尽くさないため） */
  perKind?: number;
}

export function searchAll(query: string, opts: SearchOptions = {}): SearchHit[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const d = db();
  const want = (k: SearchKind) => !opts.kinds?.length || opts.kinds.includes(k);
  const perKind = opts.perKind ?? 8;
  const hits: SearchHit[] = [];

  // 名前を引くための対応表（どの種類からも依頼者名・事件名を出せるように）
  const clients = d.select({ id: schema.clients.id, name: schema.clients.name, kana: schema.clients.kana, aliases: schema.clients.aliases, notes: schema.clients.notes }).from(schema.clients).all();
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const cases = d
    .select({ id: schema.cases.id, title: schema.cases.title, clientId: schema.cases.clientId, summary: schema.cases.summary, policy: schema.cases.policy, stage: schema.cases.stage, courtName: schema.cases.courtName, caseNumber: schema.cases.caseNumber })
    .from(schema.cases)
    .all();
  const caseById = new Map(cases.map((c) => [c.id, c]));

  const push = (h: Omit<SearchHit, 'score'>, haystack: string) => {
    const s = score(terms, haystack, h.at);
    if (s > 0) hits.push({ ...h, score: s });
  };

  if (want('client')) {
    for (const c of clients) {
      push(
        {
          kind: 'client',
          id: c.id,
          title: c.name,
          snippet: snippetAround([c.kana, ...(c.aliases ?? []), c.notes ?? ''].filter(Boolean).join(' / '), terms),
          at: null,
          clientName: c.name,
          caseTitle: null,
          link: `/clients/${c.id}`,
        },
        [c.name, c.kana ?? '', ...(c.aliases ?? []), c.notes ?? ''].join(' '),
      );
    }
  }

  if (want('case')) {
    for (const c of cases) {
      const body = [c.summary ?? '', c.policy ?? '', c.stage ?? ''].filter(Boolean).join(' / ');
      push(
        {
          kind: 'case',
          id: c.id,
          title: c.title,
          snippet: snippetAround(body || [c.courtName, c.caseNumber].filter(Boolean).join(' '), terms),
          at: null,
          clientName: clientName.get(c.clientId) ?? null,
          caseTitle: c.title,
          link: `/cases/${c.id}`,
        },
        [c.title, body, c.courtName ?? '', c.caseNumber ?? '', clientName.get(c.clientId) ?? ''].join(' '),
      );
    }
  }

  if (want('note')) {
    const ids = ftsIds('case_notes_fts', terms, 200);
    const like = terms.map(likeArg);
    // 生 SQL の結果は列名がそのまま返るので、使う列に別名を付けておく
    const rows = d.all<{ id: number; caseId: number; clientId: number | null; kind: string; counterpart: string | null; occurredAt: string; gist: string | null; rawText: string | null; decisions: string | null }>(
      sql`SELECT id, case_id AS caseId, client_id AS clientId, kind, counterpart, occurred_at AS occurredAt, gist, raw_text AS rawText, decisions
          FROM case_notes WHERE ${ids.length ? sql`id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) OR ` : sql``}
          ${sql.join(like.map((l) => sql`gist LIKE ${l} ESCAPE '\\' OR raw_text LIKE ${l} ESCAPE '\\' OR decisions LIKE ${l} ESCAPE '\\' OR counterpart LIKE ${l} ESCAPE '\\'`), sql` OR `)}
          ORDER BY occurred_at DESC LIMIT 200`,
    );
    for (const n of rows) {
      const kase = caseById.get(n.caseId);
      // 決定事項は JSON の配列。生 SQL では文字列のまま返るので読み解く
      const decisions = jsonList(n.decisions).join(' / ');
      const body = [n.gist ?? '', decisions, n.rawText ?? ''].filter(Boolean).join('\n');
      push(
        {
          kind: 'note',
          id: n.id,
          title: `${CASE_NOTE_KIND_LABEL[n.kind as CaseNoteKind] ?? n.kind}の記録${n.counterpart ? `・${n.counterpart}` : ''}`,
          snippet: snippetAround(body, terms),
          at: n.occurredAt,
          clientName: clientName.get(n.clientId ?? kase?.clientId ?? -1) ?? null,
          caseTitle: kase?.title ?? null,
          link: `/cases/${n.caseId}#note-${n.id}`,
        },
        [body, n.counterpart ?? ''].join(' '),
      );
    }
  }

  if (want('message')) {
    const ids = ftsIds('messages_fts', terms, 300);
    const like = terms.map(likeArg);
    const rows = d.all<{ id: number; conversationId: number; clientId: number | null; caseId: number | null; channel: string; direction: string; senderName: string | null; body: string; sentAt: string }>(
      sql`SELECT id, conversation_id AS conversationId, client_id AS clientId, case_id AS caseId, channel, direction, sender_name AS senderName, body, sent_at AS sentAt
          FROM messages WHERE ${ids.length ? sql`id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) OR ` : sql``}
          ${sql.join(like.map((l) => sql`body LIKE ${l} ESCAPE '\\' OR sender_name LIKE ${l} ESCAPE '\\'`), sql` OR `)}
          ORDER BY sent_at DESC LIMIT 300`,
    );
    for (const m of rows) {
      const kase = m.caseId ? caseById.get(m.caseId) : null;
      push(
        {
          kind: 'message',
          id: m.id,
          title: `${CHANNEL_LABEL[m.channel as Channel] ?? m.channel}・${m.direction === 'out' ? '送信' : `受信${m.senderName ? `（${m.senderName}）` : ''}`}`,
          snippet: snippetAround(m.body, terms),
          at: m.sentAt,
          clientName: clientName.get(m.clientId ?? -1) ?? null,
          caseTitle: kase?.title ?? null,
          link: `/inbox/${m.conversationId}`,
        },
        [m.body, m.senderName ?? ''].join(' '),
      );
    }
  }

  if (want('task')) {
    for (const t of d.select().from(schema.tasks).all()) {
      const kase = t.caseId ? caseById.get(t.caseId) : null;
      push(
        {
          kind: 'task',
          id: t.id,
          title: `${t.title}（${TASK_STATUS_LABEL[t.status as TaskStatus] ?? t.status}）`,
          snippet: snippetAround(t.note ?? '', terms),
          at: t.followUpAt ?? t.createdAt,
          clientName: clientName.get(t.clientId ?? kase?.clientId ?? -1) ?? null,
          caseTitle: kase?.title ?? null,
          link: t.caseId ? `/cases/${t.caseId}` : t.conversationId ? `/inbox/${t.conversationId}` : '/tasks',
        },
        [t.title, t.note ?? ''].join(' '),
      );
    }
  }

  if (want('event')) {
    for (const e of d.select().from(schema.calendarEvents).all()) {
      const kase = e.caseId ? caseById.get(e.caseId) : null;
      push(
        {
          kind: 'event',
          id: e.id,
          title: `${e.title}（${EVENT_KIND_LABEL[e.kind as EventKind] ?? e.kind}）`,
          snippet: `${formatJaDateTime(new Date(e.startAt))}${e.location ? `・${e.location}` : ''}${e.description ? ` ${snippetAround(e.description, terms)}` : ''}`,
          at: e.startAt,
          clientName: clientName.get(e.clientId ?? kase?.clientId ?? -1) ?? null,
          caseTitle: kase?.title ?? null,
          link: '/calendar',
        },
        [e.title, e.description ?? '', e.location ?? ''].join(' '),
      );
    }
  }

  if (want('form')) {
    for (const f of d.select().from(schema.formTemplates).all()) {
      push(
        {
          kind: 'form',
          id: f.id,
          title: f.name,
          snippet: snippetAround(f.extractedText ?? f.path, terms),
          at: f.modifiedAt,
          clientName: null,
          caseTitle: null,
          link: '/forms',
        },
        [f.name, f.path, f.extractedText?.slice(0, 4000) ?? ''].join(' '),
      );
    }
  }

  if (want('creditor')) {
    for (const cr of d.select().from(schema.creditors).all()) {
      const kase = caseById.get(cr.caseId);
      push(
        {
          kind: 'creditor',
          id: cr.id,
          title: `${cr.name}（債権者）`,
          snippet: snippetAround([cr.stage ?? '', cr.nextAction ?? '', cr.note ?? ''].filter(Boolean).join(' / '), terms),
          at: cr.lastContactAt,
          clientName: clientName.get(kase?.clientId ?? -1) ?? null,
          caseTitle: kase?.title ?? null,
          link: kase ? `/cases/${kase.id}` : '/cases',
        },
        [cr.name, cr.kana ?? '', cr.note ?? '', cr.nextAction ?? '', cr.contactPerson ?? ''].join(' '),
      );
    }
  }

  // 1 種類で埋まらないよう、種類ごとに上限を設けてから全体で並べ替える
  const byKind = new Map<SearchKind, SearchHit[]>();
  for (const h of hits.sort((a, b) => b.score - a.score)) {
    const list = byKind.get(h.kind) ?? [];
    if (list.length >= perKind) continue;
    list.push(h);
    byKind.set(h.kind, list);
  }
  return [...byKind.values()]
    .flat()
    .sort((a, b) => b.score - a.score || (b.at ?? '').localeCompare(a.at ?? ''))
    .slice(0, opts.limit ?? 30);
}

/** 検索結果を、AI に読ませる番号付きの一覧にする */
export function hitsAsContext(hits: SearchHit[]): string {
  return hits
    .map((h, i) => {
      const who = [h.clientName, h.caseTitle].filter(Boolean).join(' / ');
      const when = h.at ? formatJaDateTime(new Date(h.at)) : '';
      return `[${i + 1}] ${SEARCH_KIND_LABEL[h.kind]}｜${h.title}${who ? `｜${who}` : ''}${when ? `｜${when}` : ''}\n${h.snippet}`;
    })
    .join('\n\n');
}

export { ftsQuery };
