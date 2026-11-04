import { gmailApi, isGoogleConnected } from '../integrations/google.js';
import { normalizeGmailMessage, matchesAlwaysSender, NON_PRIMARY_CATEGORIES, type GmailCategory } from '../channels/gmail.js';
import { ingestMessage } from '../services/inbox.js';
import { getSyncState, setSyncState, getSetting } from '../services/settings.js';
import { logger } from '../logger.js';
import { db, schema } from '../db/index.js';

const KEY_HISTORY = 'gmail:historyId';

/**
 * Gmail の分類（メイン以外のタブ）に関係なく取り込む送信元か。
 * 設定「必ず取り込む送信元」に加え、登録済みの依頼者・窓口（担当者）・事件の関係者のアドレスからのメールも必ず取り込む
 * （依頼者からのメールが「新着」などに分類されて落ちるのを防ぐ）
 */
export function isAlwaysIngestSender(email: string | null | undefined): boolean {
  const e = (email ?? '').trim().toLowerCase();
  if (!e) return false;
  if (matchesAlwaysSender(e)) return true;
  const has = (list: string[] | null | undefined) => (list ?? []).some((x) => x.trim().toLowerCase() === e);
  const d = db();
  if (d.select({ emails: schema.clients.emails }).from(schema.clients).all().some((c) => has(c.emails))) return true;
  if (d.select({ emails: schema.clientPersons.emails }).from(schema.clientPersons).all().some((p) => has(p.emails))) return true;
  return d.select({ emails: schema.caseContacts.emails }).from(schema.caseContacts).all().some((k) => has(k.emails));
}
const KEY_ADDR = 'gmail:myAddresses';

/** 設定「自分のメールアドレス」（別名・他アカウント）を小文字の配列にする */
export function configuredMyAddresses(): string[] {
  return (getSetting('my_email_addresses') || '')
    .split(/[\s,、]+/)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.includes('@'));
}

/**
 * 自分の送信元とみなすアドレス: Gmail のプロフィール＋送信者名として登録した別名（send-as）＋設定で追加したもの。
 * 別名や他のアカウントから送った控えが「受信」として取り込まれないようにする。1 日ごとに取り直す
 */
export async function myAddresses(opts: { refresh?: boolean } = {}): Promise<string[]> {
  const extra = configuredMyAddresses();
  const cached = getSyncState(KEY_ADDR);
  if (cached && !opts.refresh) {
    try {
      const j = JSON.parse(cached) as { addrs: string[]; at: string };
      if (Date.now() - Date.parse(j.at) < 86400_000) return [...new Set([...j.addrs, ...extra])];
    } catch {
      /* 旧形式（アドレスのカンマ区切り）は作り直す */
    }
  }
  const gmail = gmailApi();
  const addrs = new Set<string>();
  try {
    const p = await gmail.users.getProfile({ userId: 'me' });
    const addr = (p.data.emailAddress ?? '').toLowerCase();
    if (addr) addrs.add(addr);
  } catch (err) {
    logger.warn({ err }, 'Gmail プロフィールの取得に失敗');
  }
  try {
    const sa = await gmail.users.settings.sendAs.list({ userId: 'me' });
    for (const x of sa.data.sendAs ?? []) {
      const a = (x.sendAsEmail ?? '').toLowerCase();
      if (a) addrs.add(a);
    }
  } catch (err) {
    logger.warn({ err }, 'Gmail の送信者名（別名）の取得に失敗（プロフィールのアドレスだけで判定します）');
  }
  if (addrs.size) setSyncState(KEY_ADDR, JSON.stringify({ addrs: [...addrs], at: new Date().toISOString() }));
  return [...new Set([...addrs, ...extra])];
}

/** Gmail のメッセージを取り込む。primaryOnly ならメイン以外のタブの受信は取り込まない（必ず取り込む送信元は除く） */
async function ingestGmailIds(ids: string[], mine: string[], opts: { primaryOnly: boolean }): Promise<{ ingested: number; skipped: number }> {
  const gmail = gmailApi();
  let ingested = 0;
  let skipped = 0;
  for (const id of ids) {
    try {
      const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const norm = normalizeGmailMessage(full.data, mine);
      if (!norm) continue;
      // 「メインだけ」の設定なら、プロモーション／ソーシャル／新着／フォーラムに分類された受信は取り込まない。
      // ただし、必ず取り込む送信元（設定のもの・登録済みの依頼者や関係者）からのものは取り込む
      if (
        opts.primaryOnly &&
        norm.direction === 'in' &&
        NON_PRIMARY_CATEGORIES.includes((norm.raw as { category?: GmailCategory }).category ?? 'primary') &&
        !isAlwaysIngestSender(norm.senderAddress)
      ) {
        skipped++;
        continue;
      }
      const r = await ingestMessage(norm);
      if (r.isNew) ingested++;
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 404) continue;
      logger.warn({ err, id }, 'Gmail メッセージ取得に失敗');
    }
  }
  return { ingested, skipped };
}

/**
 * 取り込まれなかったメールを、送信元を指定して取り込み直す（直近 days 日分）。
 * 「メインだけ」の設定で落ちたものも含めて取り込む（取り込み済みのものは重ねて入らない）
 */
export async function refetchGmailFrom(sender: string, days = 30): Promise<{ found: number; ingested: number }> {
  const s = sender.trim().toLowerCase().replace(/^@/, '');
  // Gmail の検索に渡すので、アドレス・ドメインに使う文字だけ受け付ける
  if (!/^[a-z0-9._%+-]*@?[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) throw new Error('メールアドレスか、ドメイン（例: example.jp）を入れてください');
  if (!isGoogleConnected()) throw new Error('Google に接続されていません');
  const gmail = gmailApi();
  const mine = await myAddresses();
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const list = await gmail.users.messages.list({ userId: 'me', maxResults: 100, q: `from:${s} newer_than:${Math.max(1, Math.min(365, days))}d -in:spam -in:trash -in:draft`, pageToken });
    for (const m of list.data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = list.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < 500);
  const r = await ingestGmailIds(ids.reverse(), mine, { primaryOnly: false });
  logger.info({ sender: s, found: ids.length, ingested: r.ingested }, 'Gmail を送信元で取り込み直しました');
  return { found: ids.length, ingested: r.ingested };
}

/**
 * Gmail をポーリングして新着を取り込む。
 * history.list を使い、historyId が失効していたら直近分を messages.list で再同期する。
 */
export async function pollGmail(): Promise<{ ingested: number; skipped?: number; mode: string }> {
  if (!isGoogleConnected()) return { ingested: 0, mode: 'disconnected' };
  const gmail = gmailApi();
  const mine = await myAddresses();
  const startHistoryId = getSyncState(KEY_HISTORY);
  const primaryOnly = getSetting('gmail_categories') === 'primary';
  let ingested = 0;
  let skipped = 0;

  const ingestIds = async (ids: string[]) => {
    const r = await ingestGmailIds(ids, mine, { primaryOnly });
    ingested += r.ingested;
    skipped += r.skipped;
  };

  const fullSync = async (): Promise<string> => {
    const list = await gmail.users.messages.list({ userId: 'me', maxResults: 50, q: 'newer_than:3d -in:spam -in:trash -in:draft' });
    const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
    await ingestIds(ids.reverse());
    const prof = await gmail.users.getProfile({ userId: 'me' });
    return String(prof.data.historyId ?? '');
  };

  if (!startHistoryId) {
    const hid = await fullSync();
    if (hid) setSyncState(KEY_HISTORY, hid);
    return { ingested, skipped, mode: 'initial' };
  }

  try {
    let pageToken: string | undefined;
    let latest = startHistoryId;
    const ids = new Set<string>();
    do {
      // labelAdded も見る: 送信予約が実際に送られると SENT ラベルが付くので、その時点で取り込む
      const res = await gmail.users.history.list({ userId: 'me', startHistoryId, historyTypes: ['messageAdded', 'labelAdded'], pageToken, maxResults: 200 });
      for (const h of res.data.history ?? []) {
        for (const a of h.messagesAdded ?? []) if (a.message?.id) ids.add(a.message.id);
        for (const l of h.labelsAdded ?? []) if (l.message?.id && (l.labelIds ?? []).includes('SENT')) ids.add(l.message.id);
      }
      if (res.data.historyId) latest = String(res.data.historyId);
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    await ingestIds([...ids]);
    setSyncState(KEY_HISTORY, latest);
    return { ingested, skipped, mode: 'history' };
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 404) {
      logger.warn('Gmail historyId が失効したため再同期します');
      const hid = await fullSync();
      if (hid) setSyncState(KEY_HISTORY, hid);
      return { ingested, skipped, mode: 'resync' };
    }
    throw err;
  }
}
