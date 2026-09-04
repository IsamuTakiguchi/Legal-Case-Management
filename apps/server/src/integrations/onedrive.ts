import { ConfidentialClientApplication, type ICachePlugin, type TokenCacheContext, type AccountInfo } from '@azure/msal-node';
import { eq } from 'drizzle-orm';
import { env, isConfigured } from '../config.js';
import { db, schema } from '../db/index.js';
import { encrypt, decrypt } from '../crypto.js';
import { logger } from '../logger.js';

export const MS_SCOPES = ['Files.ReadWrite', 'offline_access', 'User.Read'];
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SIMPLE_UPLOAD_LIMIT = 10 * 1024 * 1024; // 10MiB 超は upload session
const CHUNK = 320 * 1024 * 20; // 320KiB の倍数

/** MSAL のトークンキャッシュを暗号化して SQLite に保存するプラグイン */
const cachePlugin: ICachePlugin = {
  async beforeCacheAccess(ctx: TokenCacheContext) {
    const row = db().select().from(schema.oauthTokens).where(eq(schema.oauthTokens.provider, 'microsoft')).get();
    if (row) {
      try {
        ctx.tokenCache.deserialize(decrypt(row.data));
      } catch (err) {
        logger.warn({ err }, 'Microsoft トークンキャッシュの復号に失敗');
      }
    }
  },
  async afterCacheAccess(ctx: TokenCacheContext) {
    if (!ctx.cacheHasChanged) return;
    const data = encrypt(ctx.tokenCache.serialize());
    const now = new Date().toISOString();
    db()
      .insert(schema.oauthTokens)
      .values({ provider: 'microsoft', data, updatedAt: now })
      .onConflictDoUpdate({ target: schema.oauthTokens.provider, set: { data, updatedAt: now } })
      .run();
  },
};

let app: ConfidentialClientApplication | null = null;
function msal(): ConfidentialClientApplication {
  if (!isConfigured('microsoft')) throw new Error('MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET が設定されていません');
  if (!app) {
    const e = env();
    app = new ConfidentialClientApplication({
      auth: { clientId: e.MS_CLIENT_ID!, clientSecret: e.MS_CLIENT_SECRET!, authority: `https://login.microsoftonline.com/${e.MS_TENANT_ID}` },
      cache: { cachePlugin },
    });
  }
  return app;
}

export function msRedirectUri(): string {
  return `${env().PUBLIC_BASE_URL.replace(/\/$/, '')}/api/auth/microsoft/callback`;
}

export async function msAuthUrl(state: string): Promise<string> {
  return msal().getAuthCodeUrl({ scopes: MS_SCOPES, redirectUri: msRedirectUri(), state, prompt: 'select_account' });
}

export async function handleMsCallback(code: string): Promise<string> {
  const result = await msal().acquireTokenByCode({ code, scopes: MS_SCOPES, redirectUri: msRedirectUri() });
  const username = result.account?.username ?? '';
  db().update(schema.oauthTokens).set({ account: username }).where(eq(schema.oauthTokens.provider, 'microsoft')).run();
  return username;
}

async function account(): Promise<AccountInfo | null> {
  const accounts = await msal().getTokenCache().getAllAccounts();
  return accounts[0] ?? null;
}

export async function isMsConnected(): Promise<boolean> {
  if (!isConfigured('microsoft')) return false;
  try {
    return !!(await account());
  } catch {
    return false;
  }
}

export function msAccount(): string | null {
  const row = db().select().from(schema.oauthTokens).where(eq(schema.oauthTokens.provider, 'microsoft')).get();
  return row?.account ?? null;
}

export function disconnectMs() {
  db().delete(schema.oauthTokens).where(eq(schema.oauthTokens.provider, 'microsoft')).run();
  app = null;
}

async function token(): Promise<string> {
  const acc = await account();
  if (!acc) throw new Error('OneDrive が未接続です。設定画面から接続してください。');
  const res = await msal().acquireTokenSilent({ account: acc, scopes: MS_SCOPES.filter((s) => s !== 'offline_access') });
  return res.accessToken;
}

async function graph<T = unknown>(path: string, init: RequestInit = {}, raw = false): Promise<T> {
  const t = await token();
  const url = path.startsWith('http') ? path : `${GRAPH}${path}`;
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${t}`, ...((init.headers as Record<string, string>) ?? {}) } });
  if (res.status === 429 || res.status === 503) {
    const wait = Number(res.headers.get('retry-after') ?? '2');
    await new Promise((r) => setTimeout(r, Math.min(wait, 30) * 1000));
    return graph<T>(path, init, raw);
  }
  if (!res.ok) throw new Error(`Graph API エラー ${res.status} ${path}: ${await res.text()}`);
  if (raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface DriveItem {
  id: string;
  name: string;
  size?: number;
  webUrl?: string;
  eTag?: string;
  lastModifiedDateTime?: string;
  folder?: { childCount: number };
  file?: { mimeType?: string };
  parentReference?: { path?: string; id?: string };
  deleted?: unknown;
}

function encodePath(p: string): string {
  return p
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

export function joinPath(...parts: (string | undefined | null)[]): string {
  return (
    '/' +
    parts
      .filter((p): p is string => !!p)
      .map((p) => p.replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
      .join('/')
  );
}

export async function listChildren(folderPath: string): Promise<DriveItem[]> {
  const items: DriveItem[] = [];
  let url = folderPath === '/' || folderPath === '' ? `/me/drive/root/children?$top=200` : `/me/drive/root:/${encodePath(folderPath)}:/children?$top=200`;
  while (url) {
    const page = await graph<{ value: DriveItem[]; '@odata.nextLink'?: string }>(url);
    items.push(...page.value);
    url = page['@odata.nextLink'] ?? '';
  }
  return items;
}

export async function getItemByPath(p: string): Promise<DriveItem | null> {
  try {
    return await graph<DriveItem>(`/me/drive/root:/${encodePath(p)}`);
  } catch (err) {
    if (String(err).includes('エラー 404')) return null;
    throw err;
  }
}

export async function getItem(id: string): Promise<DriveItem> {
  return graph<DriveItem>(`/me/drive/items/${id}`);
}

export async function ensureFolder(p: string): Promise<DriveItem> {
  const existing = await getItemByPath(p);
  if (existing) return existing;
  const parts = p.replace(/^\/+|\/+$/g, '').split('/');
  const name = parts.pop()!;
  const parent = parts.length ? '/' + parts.join('/') : '/';
  if (parent !== '/') await ensureFolder(parent);
  const url = parent === '/' ? `/me/drive/root/children` : `/me/drive/root:/${encodePath(parent)}:/children`;
  try {
    return await graph<DriveItem>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
    });
  } catch (err) {
    const again = await getItemByPath(p);
    if (again) return again;
    throw err;
  }
}

export async function uploadFile(folderPath: string, filename: string, data: Buffer, conflict: 'rename' | 'replace' = 'rename'): Promise<DriveItem> {
  await ensureFolder(folderPath);
  const target = `${encodePath(folderPath)}/${encodeURIComponent(filename)}`;
  if (data.length <= SIMPLE_UPLOAD_LIMIT) {
    return graph<DriveItem>(`/me/drive/root:/${target}:/content?@microsoft.graph.conflictBehavior=${conflict}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(data),
    });
  }
  const session = await graph<{ uploadUrl: string }>(`/me/drive/root:/${target}:/createUploadSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': conflict, name: filename } }),
  });
  let offset = 0;
  let last: DriveItem | null = null;
  while (offset < data.length) {
    const end = Math.min(offset + CHUNK, data.length);
    const chunk = data.subarray(offset, end);
    const res = await fetch(session.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Length': String(chunk.length), 'Content-Range': `bytes ${offset}-${end - 1}/${data.length}` },
      body: new Uint8Array(chunk),
    });
    if (!res.ok) throw new Error(`アップロードセッション失敗 ${res.status}: ${await res.text()}`);
    if (res.status === 201 || res.status === 200) last = (await res.json()) as DriveItem;
    offset = end;
  }
  if (!last) throw new Error('アップロード結果を取得できませんでした');
  return last;
}

export async function downloadFile(itemId: string): Promise<Buffer> {
  const res = await graph<Response>(`/me/drive/items/${itemId}/content`, {}, true);
  return Buffer.from(await res.arrayBuffer());
}

export async function moveItem(itemId: string, newFolderPath: string, newName?: string): Promise<DriveItem> {
  const folder = await ensureFolder(newFolderPath);
  return graph<DriveItem>(`/me/drive/items/${itemId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentReference: { id: folder.id }, ...(newName ? { name: newName } : {}), '@microsoft.graph.conflictBehavior': 'rename' }),
  });
}

export async function createShareLink(itemId: string, opts: { scope: 'anonymous' | 'organization'; expiresAt?: Date }): Promise<string> {
  const body: Record<string, unknown> = { type: 'view', scope: opts.scope };
  if (opts.expiresAt && opts.scope === 'anonymous') body.expirationDateTime = opts.expiresAt.toISOString();
  const res = await graph<{ link: { webUrl: string } }>(`/me/drive/items/${itemId}/createLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.link.webUrl;
}

/** delta でフォルダ配下の変更を再帰的に取得する */
export async function deltaChildren(folderPath: string, deltaLink?: string | null): Promise<{ items: DriveItem[]; deltaLink: string }> {
  const items: DriveItem[] = [];
  let url = deltaLink ?? `/me/drive/root:/${encodePath(folderPath)}:/delta?$top=500`;
  let next = '';
  while (url) {
    const page = await graph<{ value: DriveItem[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }>(url);
    items.push(...page.value);
    if (page['@odata.deltaLink']) next = page['@odata.deltaLink'];
    url = page['@odata.nextLink'] ?? '';
  }
  return { items, deltaLink: next };
}

export async function meProfile(): Promise<{ displayName?: string; mail?: string; userPrincipalName?: string }> {
  return graph('/me');
}

/** 接続情報の変更後にクライアントを作り直す */
export function resetMsalClient() {
  app = null;
}
