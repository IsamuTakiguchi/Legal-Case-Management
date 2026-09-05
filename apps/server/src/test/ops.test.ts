import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';
import { eq, inArray } from 'drizzle-orm';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-ops-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.STORAGE_BACKEND = 'local';
process.env.LOCAL_CLIENT_ROOT = path.join(tmp, 'clients');
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { seedDemoData, clearDemoData, demoStatus } = await import('../services/demo.js');
const { runBackup, listLocalBackups, localBackupPath } = await import('../services/backup.js');
const { isAllowedContentUrl } = await import('../channels/line.js');
const { loginLockedFor, recordLoginFailure, clearLoginFailures } = await import('../auth/index.js');
const { createApp } = await import('../index.js');
const { listCases, activeCasesForClient } = await import('../services/cases.js');
const { setSetting } = await import('../services/settings.js');
const { loginAllowedEmails } = await import('../routes/auth.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

describe('デモデータ', () => {
  it('投入して削除すると元に戻る', () => {
    const before = db().select().from(schema.clients).all().length;
    expect(demoStatus().seeded).toBe(false);
    const ids = seedDemoData();
    expect(ids.clients.length).toBe(3);
    expect(demoStatus().seeded).toBe(true);
    expect(db().select().from(schema.messages).all().length).toBeGreaterThanOrEqual(ids.messages.length);
    expect(db().select().from(schema.creditors).all().length).toBe(5);
    expect(db().select().from(schema.alerts).all().filter((a) => a.status === 'open').length).toBeGreaterThanOrEqual(5);
    // 入れ直しても二重にならない
    seedDemoData();
    expect(db().select().from(schema.clients).all().length).toBe(before + 3);
    const deleted = clearDemoData();
    expect(deleted).toBeGreaterThan(0);
    expect(demoStatus().seeded).toBe(false);
    expect(db().select().from(schema.clients).all().length).toBe(before);
    expect(db().select().from(schema.messages).all().length).toBe(0);
    expect(db().select().from(schema.creditorEvents).all().length).toBe(0);
  });
});

describe('事件の進捗区分', () => {
  it('相談・進行事件・残務処理・終了事件で絞り込め、自動割当は進行事件を優先する', () => {
    const client = db().insert(schema.clients).values({ name: '区分 太郎' }).returning().get();
    const mk = (title: string, status: string) => db().insert(schema.cases).values({ clientId: client.id, title, status }).returning().get();
    const consult = mk('相談', 'consultation');
    const active = mk('進行', 'active');
    const wrap = mk('残務', 'wrapup');
    const closed = mk('終了', 'closed');
    expect(listCases({ clientId: client.id, status: 'consultation' }).map((c) => c.id)).toEqual([consult.id]);
    expect(listCases({ clientId: client.id, status: 'wrapup' }).map((c) => c.id)).toEqual([wrap.id]);
    expect(listCases({ clientId: client.id, status: 'closed' }).map((c) => c.id)).toEqual([closed.id]);
    expect(listCases({ clientId: client.id, status: 'open' }).map((c) => c.id).sort()).toEqual([consult.id, active.id, wrap.id].sort());
    expect(activeCasesForClient(client.id)[0].id).toBe(active.id);
    db().delete(schema.cases).where(inArray(schema.cases.id, [consult.id, active.id, wrap.id, closed.id])).run();
    db().delete(schema.clients).where(eq(schema.clients.id, client.id)).run();
  });
});

describe('Google ログインの許可アドレス', () => {
  it('設定が空なら接続アカウント、設定があればその一覧（小文字化・区切り対応）', () => {
    setSetting('login_google_emails', '');
    expect(loginAllowedEmails()).toEqual([]); // 未接続
    setSetting('login_google_emails', 'Isamu.Lawyer@gmail.com\nstaff@example.com, third@example.com');
    expect(loginAllowedEmails()).toEqual(['isamu.lawyer@gmail.com', 'staff@example.com', 'third@example.com']);
    setSetting('login_google_emails', '');
  });
});

describe('バックアップ', () => {
  it('スナップショットを圧縮して保存し、世代を整理する', async () => {
    const r = await runBackup();
    expect(r.file).toMatch(/^app-\d{8}-\d{4}\.db\.gz$/);
    const p = localBackupPath(r.file);
    expect(p).toBeTruthy();
    const raw = gunzipSync(fs.readFileSync(p!));
    expect(raw.subarray(0, 15).toString()).toBe('SQLite format 3');
    expect(listLocalBackups()[0].name).toBe(r.file);
    // ローカルストレージのときは OneDrive 相当の場所にも保存される
    expect(r.remote).not.toBeNull();
    expect(fs.existsSync(path.join(tmp, 'clients', '_システム', 'バックアップ', r.file))).toBe(true);
    expect(localBackupPath('../app.db')).toBeNull();
  });
});

describe('セキュリティ', () => {
  it('LINE 外部コンテンツ URL は LINE 系ドメインの https のみ', () => {
    expect(isAllowedContentUrl('https://obs.line-scdn.net/abc')).toBe(true);
    expect(isAllowedContentUrl('http://obs.line-scdn.net/abc')).toBe(false);
    expect(isAllowedContentUrl('https://evil.example.com/line-scdn.net')).toBe(false);
    expect(isAllowedContentUrl('https://169.254.169.254/latest')).toBe(false);
    expect(isAllowedContentUrl('not a url')).toBe(false);
  });
  it('ログイン失敗が続くとロックされる', () => {
    const ip = '203.0.113.9';
    clearLoginFailures(ip);
    for (let i = 0; i < 4; i++) recordLoginFailure(ip);
    expect(loginLockedFor(ip)).toBe(0);
    recordLoginFailure(ip);
    expect(loginLockedFor(ip)).toBeGreaterThan(0);
    clearLoginFailures(ip);
    expect(loginLockedFor(ip)).toBe(0);
  });
  it('API は未認証を拒否し、セキュリティヘッダーと本文上限が効く', async () => {
    const app = createApp();
    const res = await app.request('/api/status');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-frame-options') ?? res.headers.get('content-security-policy')).toBeTruthy();
    const big = await app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(3 * 1024 * 1024) }, body: JSON.stringify({ password: 'x'.repeat(3 * 1024 * 1024) }) });
    expect(big.status).toBe(413);
    const bad = await app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
    expect(bad.status).toBe(401);
  });
});
