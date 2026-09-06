import { gmailApi, isGoogleConnected } from '../integrations/google.js';
import { normalizeGmailMessage, NON_PRIMARY_CATEGORIES, type GmailCategory } from '../channels/gmail.js';
import { ingestMessage } from '../services/inbox.js';
import { getSyncState, setSyncState, getSetting } from '../services/settings.js';
import { logger } from '../logger.js';

const KEY_HISTORY = 'gmail:historyId';
const KEY_ADDR = 'gmail:myAddress';

async function myAddresses(): Promise<string[]> {
  const cached = getSyncState(KEY_ADDR);
  if (cached) return cached.split(',');
  const p = await gmailApi().users.getProfile({ userId: 'me' });
  const addr = (p.data.emailAddress ?? '').toLowerCase();
  if (addr) setSyncState(KEY_ADDR, addr);
  return [addr];
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
    for (const id of ids) {
      try {
        const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        const norm = normalizeGmailMessage(full.data, mine);
        if (!norm) continue;
        // 「メインだけ」の設定なら、プロモーション／ソーシャル／新着／フォーラムに分類された受信は取り込まない
        if (primaryOnly && norm.direction === 'in' && NON_PRIMARY_CATEGORIES.includes((norm.raw as { category?: GmailCategory }).category ?? 'primary')) {
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
      const res = await gmail.users.history.list({ userId: 'me', startHistoryId, historyTypes: ['messageAdded'], pageToken, maxResults: 200 });
      for (const h of res.data.history ?? []) {
        for (const a of h.messagesAdded ?? []) if (a.message?.id) ids.add(a.message.id);
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
