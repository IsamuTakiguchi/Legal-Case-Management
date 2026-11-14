import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { storage } from '../integrations/storage.js';
import { generateStructured } from '../integrations/anthropic.js';
import { clientFolder, caseFolder } from './attachments.js';
import { logger } from '../logger.js';

/** 添付の候補にするファイルの種類 */
const ATTACHABLE = /\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|heic|txt|csv|zip)$/i;
/** フォルダを潜る深さと、見るファイルの数の上限（大きな依頼者フォルダで時間がかからないように） */
const MAX_DEPTH = 3;
const MAX_FILES = 600;
/** AI に見せる候補の数 */
const MAX_CANDIDATES = 80;

export interface SuggestedFile {
  name: string;
  path: string;
  itemId?: string;
  modifiedAt?: string;
  size?: number;
  folder: string;
  /** なぜこのファイルを選んだか（画面に出す） */
  reason: string;
}

export interface AttachmentSuggestion {
  /** 相手が求めている資料（読み取ったもの） */
  requested: string[];
  files: SuggestedFile[];
  /** 見つからなかったものなどの一言 */
  note: string;
}

const EMPTY: AttachmentSuggestion = { requested: [], files: [], note: '' };

const requestSchema = z.object({
  requested: z.boolean().describe('相手がこちらに資料・書類・ファイルの送付（提供）を求めているか'),
  items: z
    .array(z.object({ what: z.string().describe('求められている資料（例: 訴状の写し、示談書の案、通帳のコピー）'), keywords: z.array(z.string()).describe('ファイル名に含まれていそうな語（例: 訴状、示談、通帳）。2〜5 語') }))
    .describe('求められている資料ごと'),
});

const pickSchema = z.object({
  picks: z.array(z.object({ index: z.number().int().describe('候補の番号'), reason: z.string().describe('どの依頼に当たるか（短く）') })).describe('求められている資料に当たるファイル。はっきり当たるものだけ。多くても 5 件'),
  note: z.string().describe('見つからなかった資料があれば、その旨を短く。全部見つかれば空'),
});

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s　_\-・]/g, '');

/** フォルダの中のファイルを、下のフォルダまで集める（深さ・数に上限あり） */
async function collectFiles(root: string): Promise<{ name: string; path: string; itemId?: string; modifiedAt?: string; size?: number; folder: string }[]> {
  const out: { name: string; path: string; itemId?: string; modifiedAt?: string; size?: number; folder: string }[] = [];
  const walk = async (folder: string, depth: number) => {
    if (out.length >= MAX_FILES) return;
    const items = await storage()
      .list(folder)
      .catch(() => []);
    for (const i of items) {
      if (out.length >= MAX_FILES) return;
      if (i.isFolder) {
        if (depth < MAX_DEPTH) await walk(i.path, depth + 1);
      } else if (ATTACHABLE.test(i.name)) {
        out.push({ name: i.name, path: i.path, itemId: i.itemId, modifiedAt: i.modifiedAt, size: i.size, folder });
      }
    }
  };
  await walk(root, 0);
  return out;
}

/**
 * 依頼者・関係者から資料の提供を求められていたら、依頼者・事件のフォルダから当てはまりそうなファイルを探す。
 * 返信の下書きを作るときに使い、見つかったものを添付の候補にする（画面で外せる）。
 */
export async function suggestRequestedFiles(conversationId: number): Promise<AttachmentSuggestion> {
  const d = db();
  const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get();
  if (!conv) return EMPTY;
  // 関係者との会話なら、その関係者の事件の依頼者
  const contact = conv.contactId ? d.select().from(schema.caseContacts).where(eq(schema.caseContacts.id, conv.contactId)).get() : null;
  const caseId = conv.caseId ?? contact?.caseId ?? null;
  const kase = caseId ? d.select().from(schema.cases).where(eq(schema.cases.id, caseId)).get() : null;
  const clientId = conv.clientId ?? kase?.clientId ?? null;
  const client = clientId ? d.select().from(schema.clients).where(eq(schema.clients.id, clientId)).get() : null;
  if (!client) return EMPTY;

  // 最後にこちらが送ったあとに届いたもの（無ければ直近の受信）
  const recent = d.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).orderBy(desc(schema.messages.sentAt)).limit(10).all();
  const inbound: string[] = [];
  for (const m of recent) {
    if (m.direction === 'out') break;
    inbound.unshift(m.body);
  }
  if (!inbound.length) return EMPTY;
  const text = inbound.join('\n---\n').slice(0, 4000);

  const req = await generateStructured({
    purpose: '資料の提供依頼の読み取り',
    tier: 'light',
    system: '法律事務所に届いたメッセージを読み、相手が事務所に資料・書類・ファイルを送ってほしい（提供してほしい）と頼んでいるかを判定します。相手が自分から資料を送ってきた・送ると言っているだけのものは、頼まれていないとします。',
    user: `メッセージ:\n${text}`,
    schema: requestSchema,
    effort: 'low',
    maxTokens: 800,
  });
  if (!req.requested || !req.items.length) return EMPTY;
  const requested = req.items.map((i) => i.what);

  // 事件のフォルダ（事件ごとにあれば）と依頼者フォルダの両方を見る
  const roots = [...new Set([...(kase ? [caseFolder(client, kase)] : []), clientFolder(client)])];
  const all: Awaited<ReturnType<typeof collectFiles>> = [];
  for (const r of roots) for (const f of await collectFiles(r)) if (!all.some((x) => x.path === f.path)) all.push(f);
  if (!all.length) return { requested, files: [], note: '依頼者のフォルダにファイルが見つかりませんでした' };

  // ファイル名・場所に依頼の語が入っているものを先に（同じなら新しい順）、AI に見せる数を絞る
  const keys = req.items.flatMap((i) => [i.what, ...i.keywords]).map(norm).filter((k) => k.length >= 2);
  const score = (f: { name: string; path: string }) => keys.reduce((n, k) => n + (norm(f.name).includes(k) ? 3 : norm(f.path).includes(k) ? 1 : 0), 0);
  const ranked = all
    .map((f) => ({ f, s: score(f) }))
    .sort((a, b) => b.s - a.s || (b.f.modifiedAt ?? '').localeCompare(a.f.modifiedAt ?? ''))
    .slice(0, MAX_CANDIDATES)
    .map((x) => x.f);

  const list = ranked.map((f, i) => `${i}: ${f.path.replace(clientFolder(client), '（依頼者フォルダ）')}${f.modifiedAt ? `（更新 ${f.modifiedAt.slice(0, 10)}）` : ''}`).join('\n');
  const pick = await generateStructured({
    purpose: '提供を求められた資料のファイル選び',
    tier: 'light',
    system: '法律事務所の事務補助者として、相手が求めている資料に当たるファイルを、依頼者フォルダのファイル一覧から選びます。ファイル名・フォルダ名から、はっきり当たると言えるものだけを選びます。迷うものや、同じ資料の古い版は選びません（新しいほうを選ぶ）。',
    user: `求められている資料:\n${req.items.map((i) => `・${i.what}`).join('\n')}\n\nメッセージ（抜粋）:\n${text.slice(0, 1500)}\n\nファイル一覧（番号: 場所）:\n${list}`,
    schema: pickSchema,
    effort: 'low',
    maxTokens: 1000,
  });
  const seen = new Set<number>();
  const files: SuggestedFile[] = [];
  for (const p of pick.picks) {
    const f = ranked[p.index];
    if (!f || seen.has(p.index) || files.length >= 5) continue;
    seen.add(p.index);
    files.push({ ...f, reason: p.reason });
  }
  logger.info({ conversationId, requested: requested.length, candidates: ranked.length, picked: files.length }, '資料の提供依頼に添付の候補を探しました');
  return { requested, files, note: pick.note?.trim() ?? '' };
}

/** 依頼者に紐付いた会話か（添付の候補を探せるか）を簡単に確かめる */
export function canSuggestFiles(conversationId: number): boolean {
  const conv = db()
    .select({ clientId: schema.conversations.clientId, contactId: schema.conversations.contactId, caseId: schema.conversations.caseId })
    .from(schema.conversations)
    .where(and(eq(schema.conversations.id, conversationId)))
    .get();
  return !!(conv && (conv.clientId || conv.contactId || conv.caseId));
}
