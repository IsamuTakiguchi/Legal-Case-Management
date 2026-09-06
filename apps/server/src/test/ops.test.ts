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

describe('依頼者フォルダの区分レイアウト', () => {
  it('区分フォルダを推定し、依頼者フォルダを区分付きに解決する', async () => {
    const { guessStatusFolders, saveStatusFolderMap, resolveAllClientFolders, defaultClientFolderRel, clientFolderParents, clientEffectiveStatus } = await import('../services/clientFolders.js');
    const { clientFolder } = await import('../services/attachments.js');
    const g = guessStatusFolders(['0.相談', '1.進行事件', '2.残務処理', '3.終了事件', '4.その他（顧問等）']);
    expect(g.map).toEqual({ consultation: '0.相談', active: '1.進行事件', wrapup: '2.残務処理', closed: '3.終了事件' });
    expect(g.extras).toEqual(['4.その他（顧問等）']);

    // ローカルストレージ上に区分フォルダと依頼者フォルダを用意
    const root = path.join(tmp, 'clients');
    for (const p of ['1.進行事件/山田 花子', '3.終了事件/田中 一郎', '4.その他（顧問等）/株式会社スズキ商事']) fs.mkdirSync(path.join(root, p), { recursive: true });
    saveStatusFolderMap(g.map, g.extras);
    expect(clientFolderParents()).toEqual(['0.相談', '1.進行事件', '2.残務処理', '3.終了事件', '4.その他（顧問等）']);

    const yamada = db().insert(schema.clients).values({ name: '山田花子' }).returning().get();
    const tanaka = db().insert(schema.clients).values({ name: '田中 一郎', onedriveFolderPath: '田中 一郎' }).returning().get();
    const suzuki = db().insert(schema.clients).values({ name: '株式会社スズキ商事' }).returning().get();
    const nobody = db().insert(schema.clients).values({ name: '存在しない' }).returning().get();
    const r = await resolveAllClientFolders();
    expect(r.updated).toBe(3);
    expect(r.missing).toEqual(['存在しない']);
    const get = (id: number) => db().select().from(schema.clients).where(eq(schema.clients.id, id)).get()!;
    expect(get(yamada.id).onedriveFolderPath).toBe('1.進行事件/山田 花子');
    expect(get(tanaka.id).onedriveFolderPath).toBe('3.終了事件/田中 一郎');
    expect(get(suzuki.id).onedriveFolderPath).toBe('4.その他（顧問等）/株式会社スズキ商事');
    expect(clientFolder(get(yamada.id))).toBe('/1.進行事件/山田 花子');

    // 未解決の依頼者は実効区分のフォルダに新規作成される（事件なし → 相談）
    expect(clientEffectiveStatus(nobody.id)).toBe('consultation');
    expect(defaultClientFolderRel({ id: nobody.id, name: '存在しない' })).toBe('0.相談/存在しない');
    db().insert(schema.cases).values({ clientId: nobody.id, title: 'x', status: 'active' }).run();
    expect(defaultClientFolderRel({ id: nobody.id, name: '存在しない' })).toBe('1.進行事件/存在しない');

    saveStatusFolderMap({}, []);
    expect(clientFolderParents()).toEqual(['']);
    db().delete(schema.cases).where(eq(schema.cases.clientId, nobody.id)).run();
    db().delete(schema.clients).where(inArray(schema.clients.id, [yamada.id, tanaka.id, suzuki.id, nobody.id])).run();
  });
});

describe('一括登録と削除', () => {
  it('区分付き候補から依頼者と事件を作り、削除で関連も消える', async () => {
    const { applyImport, guessCaseType, deleteClient, parseFolderName, detectFolderNameFormat } = await import('../services/clientImport.js');
    const { clientFolderName } = await import('../services/clientFolders.js');
    const { setSetting: set } = await import('../services/settings.js');
    // 先頭かな（並び順用）は氏名から外し、読みの頭文字として保持
    expect(parseFolderName('や 山田太郎')).toEqual({ name: '山田太郎', kanaPrefix: 'や', caseTitle: null });
    expect(parseFolderName('や_山田太郎_離婚')).toEqual({ name: '山田太郎', kanaPrefix: 'や', caseTitle: null });
    expect(parseFolderName('や山田太郎')).toEqual({ name: '山田太郎', kanaPrefix: 'や', caseTitle: null });
    expect(parseFolderName('す 株式会社スズキ商事')).toEqual({ name: '株式会社スズキ商事', kanaPrefix: 'す', caseTitle: null });
    expect(parseFolderName('山田太郎')).toEqual({ name: '山田太郎', kanaPrefix: null, caseTitle: null });
    expect(parseFolderName('やまだ')).toEqual({ name: 'やまだ', kanaPrefix: null, caseTitle: null });
    // 事務所の形式: ひらがな 1 文字＋氏名＋全角空白＋事件名
    expect(parseFolderName('し塩見海斗　損害賠償請求（交通事故）')).toEqual({ name: '塩見海斗', kanaPrefix: 'し', caseTitle: '損害賠償請求（交通事故）' });
    expect(parseFolderName('か株式会社カトウ　破産申立')).toEqual({ name: '株式会社カトウ', kanaPrefix: 'か', caseTitle: '破産申立' });
    expect(parseFolderName('や山田花子 離婚調停')).toEqual({ name: '山田花子', kanaPrefix: 'や', caseTitle: '離婚調停' });
    expect(guessCaseType('損害賠償請求（交通事故）')).toBe('traffic');
    expect(detectFolderNameFormat(['や 山田太郎', 'さ 佐藤花子', 'た_田中', '株式会社ABC'])).toBe('{kana} {name}');
    expect(detectFolderNameFormat(['し塩見海斗　損害賠償請求（交通事故）', 'か株式会社カトウ　破産申立', 'や山田花子'])).toBe('{kana}{name}　{case}');
    expect(detectFolderNameFormat(['山田太郎', '佐藤花子'])).toBe('');
    set('client_folder_name_format', '{kana} {name}');
    expect(clientFolderName({ name: '山田太郎', kana: 'やまだ たろう' })).toBe('や 山田太郎');
    expect(clientFolderName({ name: '山田太郎', kana: null })).toBe('山田太郎');
    set('client_folder_name_format', '{kana}{name}　{case}');
    expect(clientFolderName({ name: '塩見海斗', kana: 'しおみ' }, '損害賠償請求（交通事故）')).toBe('し塩見海斗　損害賠償請求（交通事故）');
    expect(clientFolderName({ name: '塩見海斗', kana: 'しおみ' }, null)).toBe('し塩見海斗');
    set('client_folder_name_format', '');
    expect(clientFolderName({ name: '山田太郎', kana: 'や' })).toBe('山田太郎');
    expect(guessCaseType('山田太郎_離婚調停')).toBe('divorce');
    expect(guessCaseType('株式会社ABC 破産')).toBe('bankruptcy_corp');
    expect(guessCaseType('佐藤 交通事故')).toBe('traffic');
    expect(guessCaseType('鈴木')).toBe('general_civil');
    const r = applyImport([
      { name: '山田太郎', folderPath: '1.進行事件/山田太郎_離婚調停', caseStatus: 'active', caseTitle: '山田太郎_離婚調停', caseType: 'divorce' },
      { name: '田中一郎', folderPath: '3.終了事件/田中一郎', caseStatus: 'closed', caseTitle: '田中一郎' },
      { name: '鈴木', folderPath: '鈴木' },
    ]);
    expect(r).toEqual({ created: 3, updated: 0, casesCreated: 2 });
    const yamada = db().select().from(schema.clients).where(eq(schema.clients.name, '山田太郎')).get()!;
    const cases = db().select().from(schema.cases).where(eq(schema.cases.clientId, yamada.id)).all();
    expect(cases).toHaveLength(1);
    expect(cases[0].status).toBe('active');
    expect(cases[0].caseType).toBe('divorce');
    // 再実行しても事件は増えない
    applyImport([{ name: '山田太郎', folderPath: '1.進行事件/山田太郎_離婚調停', existingClientId: yamada.id, caseStatus: 'active', caseTitle: '山田太郎_離婚調停' }]);
    expect(db().select().from(schema.cases).where(eq(schema.cases.clientId, yamada.id)).all()).toHaveLength(1);
    expect(deleteClient(yamada.id)).toBe(true);
    expect(db().select().from(schema.cases).where(eq(schema.cases.clientId, yamada.id)).all()).toHaveLength(0);
    expect(deleteClient(yamada.id)).toBe(false);
    for (const n of ['田中一郎', '鈴木']) {
      const c = db().select().from(schema.clients).where(eq(schema.clients.name, n)).get();
      if (c) deleteClient(c.id);
    }
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
