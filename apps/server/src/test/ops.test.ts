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
const { model: aiModel } = await import('../integrations/anthropic.js');

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
    // ひらがな始まりの氏名: 事件名付きなら空白で判定、形式確定後は先頭 1 文字を常にかなとみなす
    expect(parseFolderName('ひひめみこ　成年後見セミナー')).toEqual({ name: 'ひめみこ', kanaPrefix: 'ひ', caseTitle: '成年後見セミナー' });
    expect(parseFolderName('ひひめみこ')).toEqual({ name: 'ひひめみこ', kanaPrefix: null, caseTitle: null });
    expect(parseFolderName('ひひめみこ', { tightKana: true })).toEqual({ name: 'ひめみこ', kanaPrefix: 'ひ', caseTitle: null });
    expect(parseFolderName('やまだ', { tightKana: true })).toEqual({ name: 'まだ', kanaPrefix: 'や', caseTitle: null });
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

describe('Gmail 送信予約', () => {
  it('自分発で SENT も INBOX も無いメッセージ（送信予約）は取り込まない', async () => {
    const { normalizeGmailMessage } = await import('../channels/gmail.js');
    const base = {
      id: 'm1',
      threadId: 't1',
      internalDate: String(Date.now()),
      payload: { headers: [{ name: 'From', value: 'Me <me@example.com>' }, { name: 'To', value: 'client@example.com' }, { name: 'Subject', value: 'x' }], body: { data: Buffer.from('hello').toString('base64') }, mimeType: 'text/plain' },
    };
    expect(normalizeGmailMessage({ ...base, labelIds: [] }, ['me@example.com'])).toBeNull();
    expect(normalizeGmailMessage({ ...base, labelIds: ['SENT'] }, ['me@example.com'])?.direction).toBe('out');
    expect(normalizeGmailMessage({ ...base, labelIds: ['INBOX'] }, ['me@example.com'])?.direction).toBe('out');
  });
});

describe('チャネル別の文体サンプル', () => {
  it('同じチャネルのサンプルが十分あれば他チャネルの文面を混ぜない', async () => {
    const { addStyleSample, findSimilarSamples } = await import('../services/style.js');
    for (let i = 0; i < 6; i++) addStyleSample({ channel: 'gmail', text: `お世話になっております。査定書の件、承知いたしました。メール${i}`, source: 'import', externalId: `g${i}` });
    // LINE は 5 件未満 → Gmail の文面も手本に使う
    for (let i = 0; i < 3; i++) addStyleSample({ channel: 'line', text: `査定書の件、承知しました。LINE${i}`, source: 'sent', externalId: `l${i}` });
    const lineFew = findSimilarSamples('査定書の件', { channel: 'line', limit: 8 });
    expect(lineFew.some((s) => s.channel === 'gmail')).toBe(true);
    expect(lineFew[0].channel).toBe('line'); // 同一チャネルが優先
    // LINE が 5 件以上 → LINE だけ
    for (let i = 3; i < 6; i++) addStyleSample({ channel: 'line', text: `査定書の件、承知しました。LINE${i}`, source: 'sent', externalId: `l${i}` });
    const lineMany = findSimilarSamples('査定書の件', { channel: 'line', limit: 8 });
    expect(lineMany.length).toBeGreaterThan(0);
    expect(lineMany.every((s) => s.channel === 'line')).toBe(true);
    const gmail = findSimilarSamples('査定書の件', { channel: 'gmail', limit: 8 });
    expect(gmail.every((s) => s.channel === 'gmail')).toBe(true);
    db().delete(schema.styleSamples).run();
  });
});

describe('受信ファイルの扱い', () => {
  it('client_only では依頼者不明の添付を保存せず「未保存」に、manual ではすべて「未保存」にする', async () => {
    const { processAttachment, ignoreAttachment, attachmentPolicy } = await import('../services/attachments.js');
    const now = new Date().toISOString();
    const client = db().insert(schema.clients).values({ name: '添付テスト太郎', kana: 'てんぷてすとたろう' }).returning().get();
    const convNoClient = db().insert(schema.conversations).values({ channel: 'chatwork', externalThreadId: 'att-no-client', lastMessageAt: now, lastInboundAt: now }).returning().get();
    const convClient = db().insert(schema.conversations).values({ channel: 'chatwork', externalThreadId: 'att-client', clientId: client.id, lastMessageAt: now, lastInboundAt: now }).returning().get();
    const m1 = db().insert(schema.messages).values({ conversationId: convNoClient.id, channel: 'chatwork', externalId: 'att-m1', direction: 'in', sentAt: now }).returning().get();
    const m2 = db().insert(schema.messages).values({ conversationId: convClient.id, channel: 'chatwork', externalId: 'att-m2', direction: 'in', sentAt: now }).returning().get();
    const a1 = db().insert(schema.attachments).values({ messageId: m1.id, filename: 'chirashi.pdf', channelRef: { fileId: 'x' } }).returning().get();
    const a2 = db().insert(schema.attachments).values({ messageId: m2.id, filename: 'shiryo.pdf', channelRef: { fileId: 'y' } }).returning().get();
    const status = (id: number) => db().select().from(schema.attachments).where(eq(schema.attachments.id, id)).get()!.status;

    expect(attachmentPolicy()).toBe('client_only');
    await processAttachment(a1.id);
    expect(status(a1.id)).toBe('held');
    expect(db().select().from(schema.alerts).all().some((al) => al.dedupeKey === `unassigned_file:${a1.id}`)).toBe(false);

    setSetting('attachment_policy', 'manual');
    expect(attachmentPolicy()).toBe('manual');
    await processAttachment(a2.id);
    expect(status(a2.id)).toBe('held');
    expect(db().select().from(schema.attachments).where(eq(schema.attachments.id, a2.id)).get()!.clientId).toBe(client.id);

    await ignoreAttachment(a1.id);
    expect(status(a1.id)).toBe('ignored');
    await processAttachment(a1.id, { force: true });
    expect(status(a1.id)).toBe('ignored');

    setSetting('attachment_policy', 'client_only');
    db().delete(schema.attachments).where(inArray(schema.attachments.id, [a1.id, a2.id])).run();
    db().delete(schema.messages).where(inArray(schema.messages.id, [m1.id, m2.id])).run();
    db().delete(schema.conversations).where(inArray(schema.conversations.id, [convNoClient.id, convClient.id])).run();
    db().delete(schema.clients).where(eq(schema.clients.id, client.id)).run();
  });

  it('一括操作で不要・保存・再取得ができる', async () => {
    const { processAttachment, bulkAttachments } = await import('../services/attachments.js');
    const { setAdapter } = await import('../channels/registry.js');
    setAdapter('chatwork', { channel: 'chatwork', isConfigured: () => true, fetchAttachment: async () => Buffer.from('CW'), send: async () => ({ externalId: 'x', externalThreadId: 'y', sentAt: new Date().toISOString() }) });
    const now = new Date().toISOString();
    const client = db().insert(schema.clients).values({ name: '一括太郎', kana: 'いっかつたろう' }).returning().get();
    const conv = db().insert(schema.conversations).values({ channel: 'chatwork', externalThreadId: 'bulk-att', lastMessageAt: now, lastInboundAt: now }).returning().get();
    const m = db().insert(schema.messages).values({ conversationId: conv.id, channel: 'chatwork', externalId: 'bulk-att-1', direction: 'in', sentAt: now }).returning().get();
    const ids = [1, 2, 3].map((i) => db().insert(schema.attachments).values({ messageId: m.id, filename: `f${i}.pdf`, channelRef: { fileId: String(i) } }).returning().get().id);
    for (const id of ids) await processAttachment(id);
    const status = (id: number) => db().select().from(schema.attachments).where(eq(schema.attachments.id, id)).get()!.status;
    expect(ids.map(status)).toEqual(['held', 'held', 'held']);
    const r1 = await bulkAttachments([ids[0], ids[1]], 'ignore');
    expect(r1.done).toBe(2);
    expect(status(ids[0])).toBe('ignored');
    const r2 = await bulkAttachments([ids[2], ids[0]], 'save', client.id);
    expect(r2.done).toBe(1); // 不要にしたものは対象外
    expect(status(ids[2])).toBe('stored');
    db().delete(schema.attachments).where(inArray(schema.attachments.id, ids)).run();
    db().delete(schema.messages).where(eq(schema.messages.id, m.id)).run();
    db().delete(schema.conversations).where(eq(schema.conversations.id, conv.id)).run();
    db().delete(schema.clients).where(eq(schema.clients.id, client.id)).run();
  });

  it('LINE の添付は未保存でも受信時にアプリ内へ控えを取り、保存時はそこから使う', async () => {
    const { processAttachment, saveAttachment, fetchAttachmentData, listAttachments } = await import('../services/attachments.js');
    const { setAdapter } = await import('../channels/registry.js');
    let fetches = 0;
    setAdapter('line', {
      channel: 'line',
      isConfigured: () => true,
      fetchAttachment: async () => {
        fetches++;
        return Buffer.from('LINE-IMAGE');
      },
      send: async () => ({ externalId: 'x', externalThreadId: 'y', sentAt: new Date().toISOString() }),
    });
    const now = new Date().toISOString();
    const conv = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'line-stage', lastMessageAt: now, lastInboundAt: now }).returning().get();
    const m = db().insert(schema.messages).values({ conversationId: conv.id, channel: 'line', externalId: 'line-stage-1', direction: 'in', sentAt: now, body: '[画像]' }).returning().get();
    const a = db().insert(schema.attachments).values({ messageId: m.id, filename: 'image_1.jpg', mime: 'image/jpeg', channelRef: { messageId: '1', type: 'image' } }).returning().get();
    await processAttachment(a.id);
    const held = db().select().from(schema.attachments).where(eq(schema.attachments.id, a.id)).get()!;
    expect(held.status).toBe('held');
    expect((held.channelRef as { stagedFile?: string }).stagedFile).toBeTruthy();
    expect(fs.existsSync(path.join(tmp, 'attachments', (held.channelRef as { stagedFile: string }).stagedFile))).toBe(true);
    expect(fetches).toBe(1);
    expect((await fetchAttachmentData(a.id)).data.toString()).toBe('LINE-IMAGE');
    expect(fetches).toBe(1); // 控えから読むので再取得しない
    expect(listAttachments({ status: 'held', channel: 'line' }).map((x) => x.id)).toContain(a.id);
    expect(listAttachments({ status: 'held', channel: 'gmail' }).map((x) => x.id)).not.toContain(a.id);

    const client = db().insert(schema.clients).values({ name: 'LINE控え太郎', kana: 'らいんひかえたろう' }).returning().get();
    await saveAttachment(a.id, client.id);
    const stored = db().select().from(schema.attachments).where(eq(schema.attachments.id, a.id)).get()!;
    expect(stored.status).toBe('stored');
    expect(fetches).toBe(1);
    expect((stored.channelRef as { stagedFile?: string }).stagedFile).toBeUndefined();
    expect(fs.existsSync(path.join(tmp, 'clients', stored.storedPath!))).toBe(true);

    db().delete(schema.attachments).where(eq(schema.attachments.id, a.id)).run();
    db().delete(schema.messages).where(eq(schema.messages.id, m.id)).run();
    db().delete(schema.conversations).where(eq(schema.conversations.id, conv.id)).run();
    db().delete(schema.clients).where(eq(schema.clients.id, client.id)).run();
  });

  it('取得中のまま止まった添付は再処理され、件数は状態別・チャネル別に数えられる', async () => {
    const { processAttachment, requeueStuckAttachments, attachmentSummary } = await import('../services/attachments.js');
    const { setAdapter } = await import('../channels/registry.js');
    setAdapter('line', {
      channel: 'line',
      isConfigured: () => true,
      fetchAttachment: async () => Buffer.from('LINE-PHOTO'),
      send: async () => ({ externalId: 'x', externalThreadId: 'y', sentAt: new Date().toISOString() }),
    });
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const conv = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'line-stuck', lastMessageAt: now, lastInboundAt: now }).returning().get();
    const m = db().insert(schema.messages).values({ conversationId: conv.id, channel: 'line', externalId: 'line-stuck-1', direction: 'in', sentAt: now, body: '[画像]' }).returning().get();
    // 1 時間前に受信したまま pending（再起動で取得が途切れた想定）と、受信直後の pending
    const stuck = db().insert(schema.attachments).values({ messageId: m.id, filename: 'image_stuck.jpg', mime: 'image/jpeg', channelRef: { messageId: 's1', type: 'image' }, createdAt: old }).returning().get();
    const fresh = db().insert(schema.attachments).values({ messageId: m.id, filename: 'image_fresh.jpg', mime: 'image/jpeg', channelRef: { messageId: 's2', type: 'image' } }).returning().get();
    expect(attachmentSummary().byChannel.line?.pending).toBeGreaterThanOrEqual(2);

    const n = await requeueStuckAttachments(10);
    expect(n).toBe(1); // 直後のものは触らない
    const st = (id: number) => db().select().from(schema.attachments).where(eq(schema.attachments.id, id)).get()!.status;
    expect(st(stuck.id)).toBe('held'); // 依頼者未紐付けなので控えを取って未保存に
    expect(st(fresh.id)).toBe('pending');
    const sum = attachmentSummary();
    expect(sum.byChannel.line?.held).toBeGreaterThanOrEqual(1);
    expect(sum.byStatus.held).toBeGreaterThanOrEqual(sum.byChannel.line?.held ?? 0);

    await processAttachment(fresh.id);
    expect(st(fresh.id)).toBe('held');
    db().delete(schema.attachments).where(inArray(schema.attachments.id, [stuck.id, fresh.id])).run();
    db().delete(schema.messages).where(eq(schema.messages.id, m.id)).run();
    db().delete(schema.conversations).where(eq(schema.conversations.id, conv.id)).run();
  });
});

describe('依頼者フォルダ', () => {
  it('まだ無いフォルダの一覧は「無い」と分かるエラーになり、作成すれば空の一覧になる', async () => {
    const { LocalFolderStorage, FolderNotFoundError } = await import('../integrations/storage.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-folder-'));
    const st = new LocalFolderStorage(root);
    await expect(st.list('/0.相談/お岡本翔馬')).rejects.toBeInstanceOf(FolderNotFoundError);
    await st.ensureFolder('/0.相談/お岡本翔馬');
    expect(await st.list('/0.相談/お岡本翔馬')).toEqual([]);
    await st.ensureFolder('/0.相談/お岡本翔馬'); // 2 回目は何もしない
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('候補日の検索（営業時間・移動時間・相手の希望）', () => {
  it('営業時間を 10:00 のように分で指定でき、読めない値は既定に戻る', async () => {
    const { parseHm, businessHours, fmtHm } = await import('../services/settings.js');
    expect(parseHm('10:00', 0)).toBe(600);
    expect(parseHm('9', 0)).toBe(540);
    expect(parseHm('９：３０', 0)).toBe(570);
    expect(parseHm('abc', 123)).toBe(123);
    setSetting('business_hours_start', '10:00');
    setSetting('business_hours_end', '18:00');
    expect(businessHours()).toEqual({ startMin: 600, endMin: 1080 });
    expect(fmtHm(600)).toBe('10:00');
    setSetting('business_hours_start', '18:00');
    setSetting('business_hours_end', '10:00');
    expect(businessHours()).toEqual({ startMin: 540, endMin: 1080 }); // 逆転していれば既定
    setSetting('business_hours_start', '10:00');
    setSetting('business_hours_end', '18:00');
  });

  it('外出予定の前後に移動時間を空け、相手の曜日・時間帯・NG・希望日時を反映する', async () => {
    const { pickSlots, needsTravel } = await import('../services/scheduling.js');
    setSetting('business_hours_start', '10:00');
    setSetting('business_hours_end', '18:00');
    setSetting('travel_buffer_minutes', '60');
    setSetting('slot_gap_minutes', '0');
    setSetting('slot_step_minutes', '30');
    setSetting('holidays', '');
    setSetting('office_location', '登大路総合法律事務所（奈良市登大路町5番地 修徳ビル1階）');
    expect(needsTravel({ location: '奈良地方裁判所' })).toBe(true);
    expect(needsTravel({ location: '登大路総合法律事務所' })).toBe(false);
    expect(needsTravel({ location: 'https://zoom.us/j/123' })).toBe(false);
    expect(needsTravel({ location: '' })).toBe(false);

    // 2027-01-11(月)〜01-15(金)。火曜 13:00-14:00 に裁判所の期日（外出）
    const now = new Date('2027-01-10T00:00:00+09:00');
    const from = new Date('2027-01-11T00:00:00+09:00');
    const to = new Date('2027-01-15T23:59:59+09:00');
    const court = { start: '2027-01-12T04:00:00.000Z', end: '2027-01-12T05:00:00.000Z', travel: true, title: '期日' };

    // 条件なし: 月曜 10:00 が最初の候補（営業開始が 10:00）
    const plain = pickSlots([court], { from, to, durationMinutes: 60, maxCandidates: 5, now });
    expect(plain[0].startAt).toBe('2027-01-11T01:00:00.000Z');
    expect(plain).toHaveLength(5); // 1 日 1 枠

    // 火・木の 13:00-17:00 希望、木曜は終日 NG → 火曜だけ。13:00 の期日の前後 1 時間を空けて 15:00
    const prefs = { weekdays: [2, 4], timeRanges: [{ from: '13:00', to: '17:00' }], avoid: [{ from: '2027-01-14T00:00:00+09:00', to: '2027-01-15T00:00:00+09:00' }] };
    const r = pickSlots([court], { from, to, durationMinutes: 60, maxCandidates: 5, now, preferences: prefs });
    expect(r.map((x) => x.startAt)).toEqual(['2027-01-12T06:00:00.000Z']);

    // 移動時間 0 なら期日の直後 14:00 に入る
    const r0 = pickSlots([court], { from, to, durationMinutes: 60, maxCandidates: 5, now, preferences: prefs, travelBufferMinutes: 0 });
    expect(r0.map((x) => x.startAt)).toEqual(['2027-01-12T05:00:00.000Z']);

    // 外出でない予定は移動時間を空けない
    const office = { ...court, travel: false };
    const r1 = pickSlots([office], { from, to, durationMinutes: 60, maxCandidates: 5, now, preferences: prefs });
    expect(r1.map((x) => x.startAt)).toEqual(['2027-01-12T05:00:00.000Z']);

    // 相手が挙げた希望日時（金曜 11:00）は曜日・時間帯の希望に関係なく、空いていれば最優先で候補に
    const r2 = pickSlots([court], { from, to, durationMinutes: 60, maxCandidates: 5, now, preferences: { ...prefs, requested: [{ startAt: '2027-01-15T11:00:00+09:00' }] } });
    expect(r2.map((x) => `${x.startAt}${x.requested ? '*' : ''}`)).toEqual(['2027-01-12T06:00:00.000Z', '2027-01-15T02:00:00.000Z*']);

    // 希望日時が埋まっていれば候補にしない
    const r3 = pickSlots([{ start: '2027-01-15T01:30:00.000Z', end: '2027-01-15T03:00:00.000Z' }], { from, to, durationMinutes: 60, maxCandidates: 1, now, preferences: { requested: [{ startAt: '2027-01-15T11:00:00+09:00' }] } });
    expect(r3.map((x) => x.startAt)).toEqual(['2027-01-11T01:00:00.000Z']);

    // 期間の希望（earliest）と、予定間の間隔
    const r4 = pickSlots([{ start: '2027-01-13T01:00:00.000Z', end: '2027-01-13T02:00:00.000Z' }], { from, to, durationMinutes: 60, maxCandidates: 1, now, preferences: { earliest: '2027-01-13' }, gapMinutes: 30 });
    expect(r4.map((x) => x.startAt)).toEqual(['2027-01-13T02:30:00.000Z']);
    setSetting('business_hours_start', '9:00');
    setSetting('business_hours_end', '18:00');
  });
});

describe('予定の登録・編集・削除', () => {
  it('Google 未接続ならアプリ内に保存し、同期で消されず、期日は事件の次回期日に反映される', async () => {
    const { createCalendarEvent, editCalendarEvent, removeCalendarEvent, listCalendarEvents, isLocalEventId } = await import('../services/court.js');
    const client = db().insert(schema.clients).values({ name: '予定テスト花子', kana: 'よていてすとはなこ' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '予定テスト事件', caseType: 'civil', status: 'active' }).returning().get();
    const start = new Date(Date.now() + 3 * 86400_000);
    const end = new Date(start.getTime() + 3600_000);
    const ev = await createCalendarEvent({ title: '予定テスト 第1回弁論', startAt: start.toISOString(), endAt: end.toISOString(), kind: 'hearing', clientId: client.id, caseId: kase.id, location: '奈良地方裁判所' });
    expect(isLocalEventId(ev.googleEventId)).toBe(true);
    expect(db().select().from(schema.cases).where(eq(schema.cases.id, kase.id)).get()!.nextHearingAt).toBe(start.toISOString());

    const listed = listCalendarEvents(new Date(), new Date(Date.now() + 7 * 86400_000), { clientId: client.id });
    expect(listed.map((e) => e.id)).toContain(ev.id);
    expect(listed.find((e) => e.id === ev.id)!.caseTitle).toBe('予定テスト事件');
    expect(listed.find((e) => e.id === ev.id)!.local).toBe(true);

    await expect(createCalendarEvent({ title: 'x', startAt: end.toISOString(), endAt: start.toISOString(), kind: 'other' })).rejects.toThrow('終了は開始より後');

    const later = new Date(start.getTime() + 86400_000);
    const edited = await editCalendarEvent(ev.id, { startAt: later.toISOString(), endAt: new Date(later.getTime() + 1800_000).toISOString(), title: '予定テスト 第1回弁論（変更）' });
    expect(edited!.title).toBe('予定テスト 第1回弁論（変更）');
    expect(db().select().from(schema.cases).where(eq(schema.cases.id, kase.id)).get()!.nextHearingAt).toBe(later.toISOString());

    await removeCalendarEvent(ev.id);
    expect(db().select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, ev.id)).get()).toBeUndefined();
    expect(db().select().from(schema.cases).where(eq(schema.cases.id, kase.id)).get()!.nextHearingAt).toBeNull();

    db().delete(schema.cases).where(eq(schema.cases.id, kase.id)).run();
    db().delete(schema.clients).where(eq(schema.clients.id, client.id)).run();
  });
});

describe('複数候補の仮押さえ', () => {
  it('候補をまとめて登録し、1 つを確定すると残りが消える。取消なら全部消える', async () => {
    const { createHoldSet, confirmHold, cancelHoldSet, listCalendarEvents } = await import('../services/court.js');
    const client = db().insert(schema.clients).values({ name: '仮押 太郎', kana: 'かりおし たろう' }).returning().get();
    const day = (n: number, h: number) => new Date(Date.now() + n * 86400_000 + h * 3600_000).toISOString();
    const r = await createHoldSet({ title: '打合せ', kind: 'meeting', clientId: client.id, slots: [{ startAt: day(2, 1), endAt: day(2, 2) }, { startAt: day(3, 1), endAt: day(3, 2) }, { startAt: day(4, 1), endAt: day(4, 2) }] });
    expect(r.events.length).toBe(3);
    expect(r.events[0].title).toBe('仮押 打合せ 仮');
    expect(r.events[0].status).toBe('tentative');
    expect(r.events[0].kind).toBe('hold');
    const listed = listCalendarEvents(new Date(), new Date(Date.now() + 7 * 86400_000), { clientId: client.id });
    expect(listed.filter((e) => e.sessionId === r.sessionId).length).toBe(3);
    expect(listed[0].sessionCandidates).toBe(3);

    const confirmed = await confirmHold(r.sessionId, r.events[1].id);
    expect(confirmed!.title).toBe('仮押 打合せ');
    expect(confirmed!.status).toBe('confirmed');
    expect(confirmed!.kind).toBe('meeting');
    const after = listCalendarEvents(new Date(), new Date(Date.now() + 7 * 86400_000), { clientId: client.id });
    expect(after.map((e) => e.id)).toEqual([r.events[1].id]);
    expect(after[0].sessionId).toBeNull();
    expect(db().select().from(schema.schedulingSessions).where(eq(schema.schedulingSessions.id, r.sessionId)).get()!.state).toBe('confirmed');
    await expect(confirmHold(r.sessionId, r.events[1].id)).rejects.toThrow('すでに確定');

    const r2 = await createHoldSet({ title: '相談', kind: 'consult', counterpartName: '田中', slots: [{ startAt: day(5, 1), endAt: day(5, 2) }, { startAt: day(6, 1), endAt: day(6, 2) }] });
    expect(r2.events[0].title).toBe('田中 相談 仮');
    await cancelHoldSet(r2.sessionId);
    expect(db().select().from(schema.calendarEvents).where(inArray(schema.calendarEvents.id, r2.events.map((e) => e.id))).all().length).toBe(0);

    db().delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, r.events[1].id)).run();
    db().delete(schema.schedulingSessions).where(inArray(schema.schedulingSessions.id, [r.sessionId, r2.sessionId])).run();
    db().delete(schema.clients).where(eq(schema.clients.id, client.id)).run();
  });
});

describe('会話からの予定登録', () => {
  it('確定なら 1 件を依頼者・進行中の事件に紐付けて登録し、候補なら仮押さえにする', async () => {
    const { registerScheduleFromConversation } = await import('../services/scheduleExtract.js');
    const client = db().insert(schema.clients).values({ name: '会話 花子', kana: 'かいわ はなこ' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '会話テスト事件', caseType: 'civil', status: 'active' }).returning().get();
    const now = new Date().toISOString();
    const conv = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'sched-1', clientId: client.id, counterpartName: '会話 花子', lastMessageAt: now, lastInboundAt: now }).returning().get();
    const start = new Date(Date.now() + 2 * 86400_000);
    const r = await registerScheduleFromConversation(conv.id, { mode: 'confirmed', title: '会話 打合せ', kind: 'meeting', slots: [{ startAt: start.toISOString(), endAt: new Date(start.getTime() + 3600_000).toISOString() }], location: '事務所' });
    expect(r.mode).toBe('confirmed');
    expect(r.events[0].clientId).toBe(client.id);
    expect(r.events[0].caseId).toBe(kase.id);
    expect(r.events[0].status).toBe('confirmed');
    expect(r.events[0].description).toContain(`受信箱 #${conv.id}`);

    const r2 = await registerScheduleFromConversation(conv.id, { mode: 'holds', title: '会話 打合せ', kind: 'meeting', slots: [{ startAt: start.toISOString(), endAt: new Date(start.getTime() + 3600_000).toISOString() }, { startAt: new Date(start.getTime() + 86400_000).toISOString(), endAt: new Date(start.getTime() + 86400_000 + 3600_000).toISOString() }] });
    expect(r2.mode).toBe('holds');
    expect(r2.events.length).toBe(2);
    expect(r2.events[0].title).toBe('会話 打合せ 仮');
    expect(r2.events[0].status).toBe('tentative');

    const ids = [r.events[0].id, ...r2.events.map((e) => e.id)];
    db().delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, ids)).run();
    if (r2.mode === 'holds') db().delete(schema.schedulingSessions).where(eq(schema.schedulingSessions.id, r2.sessionId)).run();
    db().delete(schema.conversations).where(eq(schema.conversations.id, conv.id)).run();
    db().delete(schema.cases).where(eq(schema.cases.id, kase.id)).run();
    db().delete(schema.clients).where(eq(schema.clients.id, client.id)).run();
  });
});

describe('電話記録', () => {
  it('電話番号と相手・こちらの発言を保存できる', async () => {
    const { addCaseNote } = await import('../services/cases.js');
    const client = db().insert(schema.clients).values({ name: '電話 太郎', kana: 'でんわ たろう' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '電話テスト事件', caseType: 'civil', status: 'active' }).returning().get();
    const row = await addCaseNote({ caseId: kase.id, kind: 'phone', counterpart: '相手方代理人', phone: '06-1234-5678', rawText: '和解案の提示あり', gist: null, theirSaid: ['和解案として300万円を提示', '証拠の追加提出は不要'], ourSaid: ['依頼者に持ち帰る'], decisions: [], nextActions: [], attachments: [] });
    expect(row.phone).toBe('06-1234-5678');
    expect(row.theirSaid).toEqual(['和解案として300万円を提示', '証拠の追加提出は不要']);
    expect(row.ourSaid).toEqual(['依頼者に持ち帰る']);
    db().delete(schema.caseNotes).where(eq(schema.caseNotes.id, row.id)).run();
    db().delete(schema.cases).where(eq(schema.cases.id, kase.id)).run();
    db().delete(schema.clients).where(eq(schema.clients.id, client.id)).run();
  });
});

describe('Chatwork の取込範囲', () => {
  it('自分宛だけの設定では To・全員宛・ダイレクト・自分宛タスクのメッセージだけ取り込む', async () => {
    const { chatworkInScope, isAddressedToMe } = await import('../channels/chatwork.js');
    const me = 12345;
    const other = { account_id: 999 };
    const msg = (body: string, id = 'm') => ({ body, message_id: id, account: other });
    expect(isAddressedToMe('[To:12345]瀧口さん お願いします', me)).toBe(true);
    expect(isAddressedToMe('[To:123456]別の人', me)).toBe(false);
    expect(isAddressedToMe('[toall] 皆さん', me)).toBe(true);
    // 自分のメッセージへの返信（re）
    expect(isAddressedToMe('[rp aid=12345 to=1234567-9876543210]瀧口さん 承知しました', me)).toBe(true);
    expect(isAddressedToMe('[rp aid=123456 to=1234567-9876543210]別の人への返信', me)).toBe(false);
    // all なら何でも取り込む
    expect(chatworkInScope('all', msg('雑談'), { myAccountId: me, roomType: 'group' })).toBe(true);
    // to_me
    expect(chatworkInScope('to_me', msg('雑談'), { myAccountId: me, roomType: 'group' })).toBe(false);
    expect(chatworkInScope('to_me', msg('[To:12345]瀧口さん 確認お願いします'), { myAccountId: me, roomType: 'group' })).toBe(true);
    expect(chatworkInScope('to_me', msg('[toall] 来週の予定'), { myAccountId: me, roomType: 'group' })).toBe(true);
    expect(chatworkInScope('to_me', msg('雑談'), { myAccountId: me, roomType: 'direct' })).toBe(true);
    expect(chatworkInScope('to_me', msg('タスクの本文', 'task-msg'), { myAccountId: me, roomType: 'group', taskMessageIds: new Set(['task-msg']) })).toBe(true);
    // 自分の発言は、既に取り込んだ会話がある場合だけ
    const mine = { body: '返信です', message_id: 'x', account: { account_id: me } };
    expect(chatworkInScope('to_me', mine, { myAccountId: me, roomType: 'group', conversationExists: false })).toBe(false);
    expect(chatworkInScope('to_me', mine, { myAccountId: me, roomType: 'group', conversationExists: true })).toBe(true);
  });
});

describe('仮押さえの文字入力の読み取り', () => {
  it('「12/21（月）10～11：30　13～15」を候補に分解する', async () => {
    const { parseHoldText } = await import('@lcm/shared');
    const now = new Date('2026-09-07T01:00:00+09:00');
    const r = parseHoldText('12/21（月）10～11：30　13～15', { now, defaultMinutes: 60 });
    expect(r.errors).toEqual([]);
    expect(r.slots.map((s) => s.label)).toEqual(['12/21(月) 10:00〜11:30', '12/21(月) 13:00〜15:00']);
    expect(r.slots[0].startAt).toBe(new Date('2026-12-21T10:00:00+09:00').toISOString());
    expect(r.slots[0].endAt).toBe(new Date('2026-12-21T11:30:00+09:00').toISOString());
    expect(r.slots[1].endAssumed).toBe(false);

    // 複数行・終了なし・全角・時半・年の繰り上げ
    const r2 = parseHoldText('１／８(木) １４時半\n1月9日 10:00-11:00、15', { now, defaultMinutes: 90 });
    expect(r2.errors).toEqual([]);
    expect(r2.slots.map((s) => s.label)).toEqual(['1/8(金) 14:30〜16:00', '1/9(土) 10:00〜11:00', '1/9(土) 15:00〜16:30']);
    expect(r2.slots[0].startAt).toBe(new Date('2027-01-08T14:30:00+09:00').toISOString());
    expect(r2.slots[0].endAssumed).toBe(true);

    // 日付の無い行はエラー、時刻の無い行もエラー
    const r3 = parseHoldText('10～11\n12/25 未定', { now });
    expect(r3.slots).toEqual([]);
    expect(r3.errors.length).toBe(2);
  });
});

describe('事務局メンバー（Chatwork）', () => {
  it('事務局からの伝言は未紐付け警告を出さず、本文の依頼者名で紐付け、事件専用ルームは事件に紐付く', async () => {
    const { createStaff, staffByChatworkAccount, guessClientFromText, deleteStaff } = await import('../services/staff.js');
    const { ingestMessage, linkMessage } = await import('../services/inbox.js');
    const { openAlerts } = await import('../services/alerts.js');
    const { caseTimeline } = await import('../services/cases.js');
    const staff = createStaff({ name: '事務 花子', kana: 'じむ はなこ', chatworkAccountId: 777001 });
    expect(staffByChatworkAccount(777001)?.id).toBe(staff.id);
    expect(staffByChatworkAccount(1)).toBeNull();

    const client = db().insert(schema.clients).values({ name: '伝言 太郎', kana: 'でんごん たろう' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '伝言テスト事件', caseType: 'civil', status: 'active', staffId: staff.id }).returning().get();
    expect(guessClientFromText('伝言太郎さんから電話がありました')).toEqual({ clientId: client.id, caseId: kase.id });
    expect(guessClientFromText('特に誰の話でもない')).toBeNull();

    // 全体ルームからの伝言（事務局メンバー）
    const before = openAlerts('unlinked_contact').length;
    const r = await ingestMessage(
      { channel: 'chatwork', externalThreadId: '90001', externalId: 'cw-staff-1', direction: 'in', sentAt: new Date().toISOString(), senderName: '事務 花子', senderAddress: '777001', body: '[To:1]先生 伝言 太郎さんから、来週の打合せを変更したいと電話がありました', attachments: [], identity: { channel: 'chatwork', chatworkRoomId: 90001, chatworkAccountId: 777001, displayName: '事務 花子' } },
      { processAttachments: false },
    );
    expect(openAlerts('unlinked_contact').length).toBe(before);
    expect((r.conversation.meta as { staff?: boolean }).staff).toBe(true);
    expect(r.conversation.clientId).toBeNull();
    expect(r.message.clientId).toBe(client.id);
    expect(r.message.caseId).toBe(kase.id);
    expect(caseTimeline(kase.id).some((i) => i.ref?.messageId === r.message.id && i.title.includes('伝言'))).toBe(true);

    // 手動で紐付けを外す／付け直す
    expect(linkMessage(r.message.id, { clientId: null }).caseId).toBeNull();
    expect(linkMessage(r.message.id, { caseId: kase.id }).clientId).toBe(client.id);

    // 事件専用ルーム
    db().update(schema.cases).set({ chatworkRoomId: 90002 }).where(eq(schema.cases.id, kase.id)).run();
    const r2 = await ingestMessage(
      { channel: 'chatwork', externalThreadId: '90002', externalId: 'cw-room-1', direction: 'in', sentAt: new Date().toISOString(), senderName: '事務 花子', senderAddress: '777001', body: '書面を提出しました', attachments: [], identity: { channel: 'chatwork', chatworkRoomId: 90002, chatworkAccountId: 777001, displayName: '事務 花子' } },
      { processAttachments: false },
    );
    expect(r2.conversation.clientId).toBe(client.id);
    expect(r2.message.caseId).toBe(kase.id);

    // 事務局でない相手からの受信は従来どおり未紐付けに
    const r3 = await ingestMessage(
      { channel: 'chatwork', externalThreadId: '90003', externalId: 'cw-other-1', direction: 'in', sentAt: new Date().toISOString(), senderName: '外部 次郎', senderAddress: '555', body: 'こんにちは', attachments: [], identity: { channel: 'chatwork', chatworkRoomId: 90003, chatworkAccountId: 555, displayName: '外部 次郎' } },
      { processAttachments: false },
    );
    expect(openAlerts('unlinked_contact').length).toBe(before + 1);

    const convIds = [r.conversation.id, r2.conversation.id, r3.conversation.id];
    db().delete(schema.alerts).where(eq(schema.alerts.type, 'unlinked_contact')).run();
    db().delete(schema.messages).where(inArray(schema.messages.conversationId, convIds)).run();
    db().delete(schema.conversations).where(inArray(schema.conversations.id, convIds)).run();
    deleteStaff(staff.id);
    db().delete(schema.cases).where(eq(schema.cases.id, kase.id)).run();
    db().delete(schema.clients).where(eq(schema.clients.id, client.id)).run();
  });
});

describe('事件の関係者（相手方・相手方代理人）', () => {
  it('関係者のメールからの受信は事件に紐付き、依頼者の連絡先は変わらない。手動の紐付け・解除もできる', async () => {
    const { createContact, findContactByIdentity, linkConversationToContact, unlinkConversation, deleteContact, listContacts, clientOwnConversations } = await import('../services/contacts.js');
    const { ingestMessage, listConversations, getConversation } = await import('../services/inbox.js');
    const { openAlerts } = await import('../services/alerts.js');
    const { caseTimeline } = await import('../services/cases.js');
    const client = db().insert(schema.clients).values({ name: '関係者 太郎', kana: 'かんけいしゃ たろう', emails: ['taro@example.com'] }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '損害賠償請求事件', caseType: 'civil', status: 'active' }).returning().get();
    const counsel = createContact(kase.id, { role: 'opponent_counsel', name: '相手方 弁護士', organization: '○○法律事務所', emails: ['Counsel@Example.com'] });
    expect(counsel.emails).toEqual(['counsel@example.com']);
    expect(findContactByIdentity({ channel: 'gmail', email: 'counsel@example.com' })?.contact.id).toBe(counsel.id);
    expect(findContactByIdentity({ channel: 'gmail', email: 'nobody@example.com' })).toBeNull();

    // 相手方代理人からの Gmail → 未紐付け警告を出さず、事件・依頼者・関係者に紐付く
    const before = openAlerts('unlinked_contact').length;
    const r = await ingestMessage(
      { channel: 'gmail', externalThreadId: 'thr-counsel-1', externalId: 'gm-counsel-1', direction: 'in', sentAt: new Date().toISOString(), senderName: '相手方 弁護士', senderAddress: 'counsel@example.com', subject: '和解案について', body: '和解案をお送りします', attachments: [], identity: { channel: 'gmail', email: 'counsel@example.com', displayName: '相手方 弁護士' } },
      { processAttachments: false },
    );
    expect(openAlerts('unlinked_contact').length).toBe(before);
    expect(r.conversation.contactId).toBe(counsel.id);
    expect(r.conversation.caseId).toBe(kase.id);
    expect(r.conversation.clientId).toBe(client.id);
    expect(r.message.caseId).toBe(kase.id);
    // 依頼者の連絡先は書き換わらない
    const c1 = db().select().from(schema.clients).where(eq(schema.clients.id, client.id)).get()!;
    expect(c1.emails).toEqual(['taro@example.com']);
    // 一覧・詳細に関係者情報が付く
    const listed = listConversations({ clientId: client.id }).find((x) => x.id === r.conversation.id)!;
    expect(listed.contact?.roleLabel).toBe('相手方代理人');
    expect(listed.contact?.caseTitle).toBe('損害賠償請求事件');
    expect(getConversation(r.conversation.id)?.contact?.name).toBe('相手方 弁護士');
    // 事件のタイムラインに役割付きで載る
    expect(caseTimeline(kase.id).some((i) => i.ref?.messageId === r.message.id && i.title.includes('相手方代理人'))).toBe(true);
    // 依頼者本人との会話だけを取る関数からは除かれる
    expect(clientOwnConversations(client.id).some((x) => x.id === r.conversation.id)).toBe(false);

    // 未紐付けの LINE 会話を、新しい関係者（相手方本人）として手動で紐付ける
    const r2 = await ingestMessage(
      { channel: 'line', externalThreadId: 'Uopponent1', externalId: 'ln-opp-1', direction: 'in', sentAt: new Date().toISOString(), senderName: '相手方 本人', senderAddress: 'Uopponent1', body: '示談の件で連絡しました', attachments: [], identity: { channel: 'line', lineUserId: 'Uopponent1', displayName: '相手方 本人' } },
      { processAttachments: false },
    );
    expect(openAlerts('unlinked_contact').length).toBe(before + 1);
    const opp = createContact(kase.id, { role: 'opponent', name: '相手方 本人', emails: [] });
    const linked = linkConversationToContact(r2.conversation.id, opp.id);
    expect(linked.conversation.clientId).toBe(client.id);
    expect(linked.contact.lineUserId).toBe('Uopponent1'); // LINE ID は関係者側に登録される
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, client.id)).get()!.lineUserId).toBeNull();
    expect(openAlerts('unlinked_contact').length).toBe(before);
    // 以後は自動で紐付く
    expect(findContactByIdentity({ channel: 'line', lineUserId: 'Uopponent1' })?.contact.id).toBe(opp.id);

    // 紐付け解除
    const un = unlinkConversation(r2.conversation.id);
    expect(un.clientId).toBeNull();
    expect(un.contactId).toBeNull();
    expect(db().select().from(schema.messages).where(eq(schema.messages.id, r2.message.id)).get()!.caseId).toBeNull();

    // 関係者を削除しても会話は残り、関係者の紐付けだけ外れる
    expect(listContacts(kase.id).map((x) => x.id).sort()).toEqual([counsel.id, opp.id].sort());
    deleteContact(counsel.id);
    expect(db().select().from(schema.conversations).where(eq(schema.conversations.id, r.conversation.id)).get()!.contactId).toBeNull();
    deleteContact(opp.id);

    const convIds = [r.conversation.id, r2.conversation.id];
    db().delete(schema.alerts).where(eq(schema.alerts.type, 'unlinked_contact')).run();
    db().delete(schema.messages).where(inArray(schema.messages.conversationId, convIds)).run();
    db().delete(schema.conversations).where(inArray(schema.conversations.id, convIds)).run();
    db().delete(schema.cases).where(eq(schema.cases.id, kase.id)).run();
    db().delete(schema.clients).where(eq(schema.clients.id, client.id)).run();
  });
});

describe('バックアップからの復元', () => {
  it('バックアップの中身で DB を置き換え、復元前の状態も控えとして残す', async () => {
    const { runBackup, restoreBackup, localBackupPath, lastBackupInfo } = await import('../services/backup.js');
    const before = db().insert(schema.clients).values({ name: '復元 前子', kana: 'ふくげん まえこ' }).returning().get();
    const b = await runBackup();
    expect(localBackupPath(b.file)).toBeTruthy();
    db().insert(schema.clients).values({ name: '復元 後子', kana: 'ふくげん あとこ' }).returning().get();
    const data = fs.readFileSync(localBackupPath(b.file)!);
    const r = await restoreBackup(data, b.file);
    expect(r.clients).toBeGreaterThanOrEqual(1);
    const names = db().select({ name: schema.clients.name }).from(schema.clients).all().map((x) => x.name);
    expect(names).toContain('復元 前子');
    expect(names).not.toContain('復元 後子');
    expect(localBackupPath(r.safetyBackup)).toBeTruthy(); // 復元前の控え
    expect(lastBackupInfo().at).toBeTruthy();
    await expect(restoreBackup(Buffer.from('not a database at all'))).rejects.toThrow('SQLite');
    db().delete(schema.clients).where(eq(schema.clients.id, before.id)).run();
  });
});

describe('期日連絡', () => {
  it('期日の記録から依頼者宛の連絡文を用意し、会話が無ければ作る（AI 未設定ならテンプレート）', async () => {
    const { prepareHearingNotice, ensureClientConversation, availableChannels } = await import('../services/hearingNotice.js');
    const { setAdapter } = await import('../channels/registry.js');
    setAdapter('gmail', { channel: 'gmail', isConfigured: () => true, fetchAttachment: async () => Buffer.from(''), send: async () => ({ externalId: 'x', externalThreadId: 'y', sentAt: new Date().toISOString() }) });
    const client = db().insert(schema.clients).values({ name: '期日 連絡子', kana: 'きじつ れんらくこ', emails: ['renraku@example.com'], preferredChannel: 'gmail' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '貸金返還請求事件', caseType: 'civil', status: 'active' }).returning().get();
    expect(availableChannels(client).map((c) => c.channel)).toContain('gmail');
    const note = db()
      .insert(schema.caseNotes)
      .values({ caseId: kase.id, kind: 'court', occurredAt: new Date().toISOString(), gist: '第2回弁論。相手方から答弁書が出た。', decisions: ['次回までに反論書面を提出'], nextActions: [{ title: '反論書面の作成', due: '2027-01-20' }], createdBy: 'user' })
      .returning()
      .get();
    const next = new Date(Date.now() + 14 * 86400_000).toISOString();
    db().insert(schema.calendarEvents).values({ googleEventId: 'local-hearing-test', caseId: kase.id, clientId: client.id, kind: 'hearing', title: '期日 第3回弁論', startAt: next, endAt: new Date(new Date(next).getTime() + 3600_000).toISOString(), location: '奈良地裁 302' }).run();

    const r = await prepareHearingNotice(note.id);
    expect(r.channel).toBe('gmail');
    expect(r.to).toBe('renraku@example.com');
    expect(r.nextHearingAt).toBe(next);
    expect(r.text).toContain('期日');
    expect(r.text).toContain('答弁書');
    expect(r.text).toContain('奈良地裁');
    // 会話が無かったので仮 ID で作られる。2 回目は同じ会話
    const conv = db().select().from(schema.conversations).where(eq(schema.conversations.id, r.conversationId)).get()!;
    expect(conv.externalThreadId.startsWith('new:')).toBe(true);
    expect(conv.clientId).toBe(client.id);
    expect(ensureClientConversation(client, 'gmail').id).toBe(conv.id);
    // 連絡先が無い依頼者は明確なエラー
    const noContact = db().insert(schema.clients).values({ name: '連絡先 無太郎', kana: 'れんらくさき なしたろう' }).returning().get();
    const kase2 = db().insert(schema.cases).values({ clientId: noContact.id, title: 'テスト', caseType: 'civil', status: 'active' }).returning().get();
    const note2 = db().insert(schema.caseNotes).values({ caseId: kase2.id, kind: 'court', occurredAt: new Date().toISOString(), gist: 'x', createdBy: 'user' }).returning().get();
    await expect(prepareHearingNotice(note2.id)).rejects.toThrow('連絡先');

    db().delete(schema.calendarEvents).where(eq(schema.calendarEvents.googleEventId, 'local-hearing-test')).run();
    db().delete(schema.caseNotes).where(inArray(schema.caseNotes.id, [note.id, note2.id])).run();
    db().delete(schema.conversations).where(eq(schema.conversations.id, conv.id)).run();
    db().delete(schema.cases).where(inArray(schema.cases.id, [kase.id, kase2.id])).run();
    db().delete(schema.clients).where(inArray(schema.clients.id, [client.id, noContact.id])).run();
  });
});

describe('記録の編集', () => {
  it('種別・日時・要旨・発言・決定事項・次のアクションを差し替え、タスク化済みの結び付きは保つ', async () => {
    const { updateCaseNote } = await import('../services/cases.js');
    const client = db().insert(schema.clients).values({ name: '編集 太郎', kana: 'へんしゅう たろう' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '編集テスト事件', caseType: 'civil', status: 'active' }).returning().get();
    const note = db()
      .insert(schema.caseNotes)
      .values({ caseId: kase.id, kind: 'phone', occurredAt: '2026-09-01T01:00:00.000Z', gist: '古い要旨', theirSaid: ['a'], ourSaid: [], decisions: [], nextActions: [{ title: '書面作成', due: '2026-09-10', taskId: 42 }], createdBy: 'ai' })
      .returning()
      .get();
    const r = updateCaseNote(note.id, {
      kind: 'court',
      occurredAt: '2026-09-02T05:00:00.000Z',
      gist: ' 新しい要旨 ',
      theirSaid: ['相手方は和解案を提示', ' '],
      ourSaid: ['持ち帰って検討'],
      decisions: ['次回までに回答'],
      nextActions: [{ title: '書面作成', due: '2026-09-12' }, { title: '依頼者に連絡', due: null }],
      waitingFor: 'client',
    });
    expect(r.kind).toBe('court');
    expect(r.occurredAt).toBe('2026-09-02T05:00:00.000Z');
    expect(r.gist).toBe('新しい要旨');
    expect(r.theirSaid).toEqual(['相手方は和解案を提示']);
    expect(r.decisions).toEqual(['次回までに回答']);
    expect(r.nextActions).toEqual([{ title: '書面作成', due: '2026-09-12', taskId: 42 }, { title: '依頼者に連絡', due: null, taskId: null }]);
    expect(r.waitingFor).toBe('client');
    expect(updateCaseNote(note.id, { waitingFor: null, counterpart: '  ' }).waitingFor).toBeNull();
    expect(() => updateCaseNote(999999, { gist: 'x' })).toThrow('記録');
    db().delete(schema.caseNotes).where(eq(schema.caseNotes.id, note.id)).run();
    db().delete(schema.cases).where(eq(schema.cases.id, kase.id)).run();
    db().delete(schema.clients).where(eq(schema.clients.id, client.id)).run();
  });
});

describe('受信ファイルの名前付け替え', () => {
  it('中身の分からない名前を判定し、AI 未設定なら元の名前のまま保存する', async () => {
    const { isGenericFilename, sanitizeSuggestedName, suggestFilename } = await import('../services/fileNaming.js');
    for (const n of ['image_1234567890.jpg', 'IMG_0001.JPG', 'S__12345678.jpg', 'DSC01234.jpg', 'document.pdf', 'scan001.pdf', '写真.jpg', 'スクリーンショット 2026-09-08 12.34.56.png', '20260908_123456.jpg', '1234567.pdf', 'file_1.pdf', 'a1b2c3d4e5f6a7b8c9d0.jpg', 'video_98765.mp4', 'Photo-3.jpeg', '無題.docx']) {
      expect(isGenericFilename(n), n).toBe(true);
    }
    for (const n of ['診断書.pdf', '査定書_A社.pdf', '賃貸借契約書（写）.pdf', '給与明細_2026年8月.pdf', '事故現場写真_交差点.jpg', 'Invoice_2026-08.pdf', '山田様_陳述書案.docx', 'estimate_toyota.pdf']) {
      expect(isGenericFilename(n), n).toBe(false);
    }
    expect(sanitizeSuggestedName(' 事故現場の写真 / 交差点: 前方 ')).toBe('事故現場の写真_交差点_前方');
    expect(sanitizeSuggestedName('x'.repeat(60)).length).toBe(40);
    // AI 未設定なら提案しない（元の名前のまま）
    expect(await suggestFilename({ data: Buffer.from('x'), filename: 'image_1.jpg', mime: 'image/jpeg', context: { channel: 'line', body: '診断書を送ります' } })).toBeNull();
  });
});

describe('事務局メンバー候補', () => {
  it('取込済みメッセージの送信者から候補を出す（Chatwork 未接続でも動く）', async () => {
    const { chatworkAccountsFromMessages, listChatworkAccounts } = await import('../services/staff.js');
    const now = new Date().toISOString();
    const conv = db().insert(schema.conversations).values({ channel: 'chatwork', externalThreadId: '90010', counterpartName: '事務局ルーム', lastMessageAt: now, lastInboundAt: now }).returning().get();
    db().insert(schema.messages).values({ conversationId: conv.id, channel: 'chatwork', externalId: 'cand-1', direction: 'in', senderName: '事務 一郎', senderAddress: '888001', sentAt: now, body: 'a' }).run();
    db().insert(schema.messages).values({ conversationId: conv.id, channel: 'chatwork', externalId: 'cand-2', direction: 'in', senderName: '事務 一郎', senderAddress: '888001', sentAt: now, body: 'b' }).run();
    db().insert(schema.messages).values({ conversationId: conv.id, channel: 'chatwork', externalId: 'cand-3', direction: 'out', senderName: '自分', senderAddress: '1', sentAt: now, body: 'c' }).run();
    const c = chatworkAccountsFromMessages();
    expect(c.filter((x) => x.accountId === 888001)).toEqual([{ accountId: 888001, name: '事務 一郎', rooms: ['事務局ルーム'], source: 'messages' }]);
    const r = await listChatworkAccounts();
    expect(r.accounts.some((x) => x.accountId === 888001)).toBe(true);
    db().delete(schema.messages).where(eq(schema.messages.conversationId, conv.id)).run();
    db().delete(schema.conversations).where(eq(schema.conversations.id, conv.id)).run();
  });
});

describe('受信ファイルの対象', () => {
  it('自分の送信メッセージの添付は登録せず、Gmail のインライン画像は添付にしない', async () => {
    const { ingestMessage } = await import('../services/inbox.js');
    const { extractBodyAndAttachments } = await import('../channels/gmail.js');
    const now = new Date().toISOString();
    const r = await ingestMessage(
      { channel: 'gmail', externalThreadId: 'out-att', externalId: 'out-att-1', direction: 'out', sentAt: now, senderAddress: 'me@example.com', body: '送ります', attachments: [{ filename: '送付.pdf', ref: { messageId: 'x', attachmentId: 'y' } }], identity: { channel: 'gmail', email: 'client@example.com' } },
      { processAttachments: false },
    );
    expect(db().select().from(schema.attachments).where(eq(schema.attachments.messageId, r.message.id)).all().length).toBe(0);
    db().delete(schema.messages).where(eq(schema.messages.id, r.message.id)).run();
    db().delete(schema.conversations).where(eq(schema.conversations.id, r.conversation.id)).run();

    const parsed = extractBodyAndAttachments({
      id: 'g1',
      threadId: 't',
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { data: Buffer.from('本文').toString('base64') } },
          { mimeType: 'image/png', filename: 'logo.png', headers: [{ name: 'Content-Disposition', value: 'inline; filename="logo.png"' }, { name: 'Content-ID', value: '<logo@x>' }], body: { attachmentId: 'a1', size: 1000 } },
          { mimeType: 'image/jpeg', filename: 'photo.jpg', headers: [{ name: 'Content-Disposition', value: 'attachment; filename="photo.jpg"' }], body: { attachmentId: 'a2', size: 50000 } },
          { mimeType: 'application/pdf', filename: '資料.pdf', body: { attachmentId: 'a3', size: 2000 } },
        ],
      },
    });
    expect(parsed.attachments.map((a) => a.filename)).toEqual(['photo.jpg', '資料.pdf']);
  });
});

describe('受信箱の表示範囲', () => {
  it('inboundOnly なら自分の送信だけの会話を除く', async () => {
    const { listConversations } = await import('../services/inbox.js');
    const now = new Date().toISOString();
    const outOnly = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: 'out-only', subject: '送信のみ', lastMessageAt: now, lastOutboundAt: now }).returning().get();
    const both = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: 'both', subject: '往復', lastMessageAt: now, lastInboundAt: now, lastOutboundAt: now }).returning().get();
    expect(listConversations({ channel: 'gmail', inboundOnly: true }).map((c) => c.id)).not.toContain(outOnly.id);
    expect(listConversations({ channel: 'gmail', inboundOnly: true }).map((c) => c.id)).toContain(both.id);
    expect(listConversations({ channel: 'gmail' }).map((c) => c.id)).toContain(outOnly.id);
    db().delete(schema.conversations).where(inArray(schema.conversations.id, [outOnly.id, both.id])).run();
  });
});

describe('受信箱の一括操作', () => {
  it('対応済み・アーカイブ・解除をまとめて適用できる', async () => {
    const { bulkUpdateConversations, listConversations } = await import('../services/inbox.js');
    const now = new Date().toISOString();
    const a = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: 'bulk-a', lastMessageAt: now, lastInboundAt: now, needsReply: true, unread: 2 }).returning().get();
    const b = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: 'bulk-b', lastMessageAt: now, lastInboundAt: now, needsReply: true, unread: 1 }).returning().get();
    expect(bulkUpdateConversations([a.id, b.id], 'resolve')).toBe(2);
    const a1 = db().select().from(schema.conversations).where(eq(schema.conversations.id, a.id)).get()!;
    expect(a1.needsReply).toBe(false);
    expect(a1.unread).toBe(0);
    expect(bulkUpdateConversations([b.id], 'archive')).toBe(1);
    expect(listConversations({ channel: 'gmail' }).map((c) => c.id)).not.toContain(b.id);
    expect(listConversations({ channel: 'gmail', archived: true }).map((c) => c.id)).toContain(b.id);
    expect(bulkUpdateConversations([b.id], 'unarchive')).toBe(1);
    expect(listConversations({ channel: 'gmail' }).map((c) => c.id)).toContain(b.id);
    expect(bulkUpdateConversations([], 'archive')).toBe(0);
    db().delete(schema.conversations).where(inArray(schema.conversations.id, [a.id, b.id])).run();
  });
});

describe('Gmail の取込範囲', () => {
  it('ラベルからタブを判定し、「メインだけ」なら一覧から除外する', async () => {
    const { gmailCategory } = await import('../channels/gmail.js');
    const { listConversations } = await import('../services/inbox.js');
    expect(gmailCategory(['INBOX', 'CATEGORY_PERSONAL'])).toBe('primary');
    expect(gmailCategory(['INBOX', 'CATEGORY_PROMOTIONS'])).toBe('promotions');
    expect(gmailCategory(['SENT'])).toBe('primary');
    const promo = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: 'promo-1', subject: 'セール', lastMessageAt: new Date().toISOString(), meta: { category: 'promotions' } }).returning().get();
    const main = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: 'main-1', subject: '相談', lastMessageAt: new Date().toISOString(), meta: { category: 'primary' } }).returning().get();
    setSetting('gmail_categories', 'all');
    expect(listConversations({ channel: 'gmail' }).map((c) => c.id)).toEqual(expect.arrayContaining([promo.id, main.id]));
    setSetting('gmail_categories', 'primary');
    const ids = listConversations({ channel: 'gmail' }).map((c) => c.id);
    expect(ids).toContain(main.id);
    expect(ids).not.toContain(promo.id);
    setSetting('gmail_categories', 'all');
    db().delete(schema.conversations).where(inArray(schema.conversations.id, [promo.id, main.id])).run();
  });

  it('区分の無い取込済み会話は保存済みラベルから判定し直せる', async () => {
    const { recategorizeConversations } = await import('../channels/gmail.js');
    const { listConversations } = await import('../services/inbox.js');
    const now = new Date().toISOString();
    const promo = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: 'old-promo', subject: 'セール', lastMessageAt: now, lastInboundAt: now, meta: { counterpartEmail: 'shop@example.com' } }).returning().get();
    const main = db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: 'old-main', subject: '相談', lastMessageAt: now, lastInboundAt: now, meta: {} }).returning().get();
    db().insert(schema.messages).values({ conversationId: promo.id, channel: 'gmail', externalId: 'old-promo-1', direction: 'in', sentAt: now, raw: { labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] } }).run();
    db().insert(schema.messages).values({ conversationId: main.id, channel: 'gmail', externalId: 'old-main-1', direction: 'in', sentAt: now, raw: { labelIds: ['INBOX', 'CATEGORY_PERSONAL'] } }).run();
    const r = await recategorizeConversations();
    expect(r.checked).toBeGreaterThanOrEqual(2);
    expect((db().select().from(schema.conversations).where(eq(schema.conversations.id, promo.id)).get()!.meta as { category?: string }).category).toBe('promotions');
    expect((db().select().from(schema.conversations).where(eq(schema.conversations.id, main.id)).get()!.meta as { category?: string }).category).toBe('primary');
    setSetting('gmail_categories', 'primary');
    const ids = listConversations({ channel: 'gmail' }).map((c) => c.id);
    expect(ids).not.toContain(promo.id);
    expect(ids).toContain(main.id);
    setSetting('gmail_categories', 'all');
    db().delete(schema.messages).where(inArray(schema.messages.conversationId, [promo.id, main.id])).run();
    db().delete(schema.conversations).where(inArray(schema.conversations.id, [promo.id, main.id])).run();
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
    expect(r.file).toMatch(/^app-\d{8}-\d{4}(?:\d{2})?\.db\.gz$/);
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

describe('送信予約', () => {
  it('予約・変更・取消ができ、時刻が来たものだけジョブが送る（未設定チャネルは失敗→再試行→要確認）', async () => {
    const { scheduleMessage, listScheduled, updateScheduled, cancelScheduled, runDueScheduled, dispatchScheduled, recoverStuckScheduled } = await import('../services/scheduledSend.js');
    const { setAdapter } = await import('../channels/registry.js');
    // 送信を差し替え: ok=false の間は失敗させる
    let sendOk = false;
    const sentTexts: string[] = [];
    setAdapter('line', {
      channel: 'line',
      isConfigured: () => true,
      fetchAttachment: async () => Buffer.from(''),
      send: async (m) => {
        if (!sendOk) throw new Error('line が未設定です（テスト）');
        sentTexts.push(m.text);
        return { externalId: `sched-${sentTexts.length}`, externalThreadId: 'U-sched-test', sentAt: new Date().toISOString() };
      },
    });
    const conv = db()
      .insert(schema.conversations)
      .values({ channel: 'line', externalThreadId: 'U-sched-test', subject: null, counterpartName: '予約 太郎', lastMessageAt: new Date().toISOString() })
      .returning()
      .get();
    const base = { text: 'こんにちは', attachmentIds: [], driveFiles: [], draftId: null, createWaitingTask: false };
    // 過去の時刻は拒否
    expect(() => scheduleMessage(conv.id, base, new Date(Date.now() - 3600_000).toISOString())).toThrow(/過去/);
    const future = new Date(Date.now() + 3600_000).toISOString();
    const s1 = scheduleMessage(conv.id, base, future);
    expect(s1.status).toBe('pending');
    expect(listScheduled({ conversationId: conv.id }).map((x) => x.id)).toEqual([s1.id]);
    expect(listScheduled({ conversationId: conv.id })[0].conversation.counterpartName).toBe('予約 太郎');
    // まだ時刻が来ていないので送らない
    expect(await runDueScheduled()).toEqual({ sent: 0, failed: 0 });
    // 変更（本文と時刻）
    const later = new Date(Date.now() + 7200_000).toISOString();
    const s1b = updateScheduled(s1.id, { scheduledAt: later, text: '改めてご連絡します' });
    expect(s1b.scheduledAt).toBe(later);
    expect(s1b.text).toBe('改めてご連絡します');
    expect((db().select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.id, s1.id)).get()!.payload as { text: string }).text).toBe('改めてご連絡します');
    // 取消
    expect(cancelScheduled(s1.id).status).toBe('cancelled');
    expect(listScheduled({ conversationId: conv.id })).toEqual([]);
    expect(() => updateScheduled(s1.id, { text: 'x' })).toThrow();

    // 時刻が来たものはジョブが拾う。LINE 未設定なので失敗し、3 回目まで再試行してから要確認に上げる
    const due = scheduleMessage(conv.id, base, new Date(Date.now() - 30_000).toISOString());
    const alertsBefore = db().select().from(schema.alerts).all().filter((a) => a.type === 'scheduled_send_failed').length;
    for (let i = 1; i <= 2; i++) {
      expect(await runDueScheduled()).toEqual({ sent: 0, failed: 1 });
      const row = db().select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.id, due.id)).get()!;
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(i);
      expect(row.error).toMatch(/未設定/);
    }
    expect(await runDueScheduled()).toEqual({ sent: 0, failed: 1 });
    const failed = db().select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.id, due.id)).get()!;
    expect(failed.status).toBe('failed');
    expect(failed.attempts).toBe(3);
    expect(db().select().from(schema.alerts).all().filter((a) => a.type === 'scheduled_send_failed').length).toBe(alertsBefore + 1);
    // 失敗したものはもうジョブが拾わない
    expect(await runDueScheduled()).toEqual({ sent: 0, failed: 0 });
    // 「今すぐ送る」は失敗したものも対象にでき、送れれば送信済みになって会話にも残る
    sendOk = true;
    const r = await dispatchScheduled(due.id, { force: true });
    expect(r.ok).toBe(true);
    expect(sentTexts).toEqual(['こんにちは']);
    const sentRow = db().select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.id, due.id)).get()!;
    expect(sentRow.status).toBe('sent');
    expect(sentRow.sentMessageId).toBeTruthy();
    expect(db().select().from(schema.messages).where(eq(schema.messages.id, sentRow.sentMessageId!)).get()?.direction).toBe('out');
    expect(() => cancelScheduled(due.id)).toThrow(/送信済み/);
    // 時刻が来たものは通常どおりジョブが送る
    const ok = scheduleMessage(conv.id, { ...base, text: '時刻どおり' }, new Date(Date.now() - 1000).toISOString());
    expect(await runDueScheduled()).toEqual({ sent: 1, failed: 0 });
    expect(sentTexts.at(-1)).toBe('時刻どおり');
    expect(db().select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.id, ok.id)).get()!.status).toBe('sent');
    sendOk = false;
    // 予定時刻から 6 時間以上経ったものは送らずに失敗にする
    const stale = scheduleMessage(conv.id, base, new Date(Date.now() + 60_000).toISOString());
    db().update(schema.scheduledMessages).set({ scheduledAt: new Date(Date.now() - 7 * 3600_000).toISOString() }).where(eq(schema.scheduledMessages.id, stale.id)).run();
    await runDueScheduled();
    const staleRow = db().select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.id, stale.id)).get()!;
    expect(staleRow.status).toBe('failed');
    expect(staleRow.error).toMatch(/6 時間/);
    // 再起動で sending のまま残ったものは pending に戻る
    db().update(schema.scheduledMessages).set({ status: 'sending' }).where(eq(schema.scheduledMessages.id, stale.id)).run();
    expect(recoverStuckScheduled()).toBe(1);
    expect(db().select().from(schema.scheduledMessages).where(eq(schema.scheduledMessages.id, stale.id)).get()!.status).toBe('pending');
    // 同時に走っても二重に送らない（片方だけが sending を取れる）
    db().update(schema.scheduledMessages).set({ status: 'sending' }).where(eq(schema.scheduledMessages.id, stale.id)).run();
    const dup = await dispatchScheduled(stale.id);
    expect(dup.ok).toBe(false);
    expect(dup.ok === false && dup.error).toMatch(/送信中/);
  });

  it('毎分のジョブは何もしなかった回を履歴に残さず、古い履歴は整理される', async () => {
    const { JOBS, runJob, pruneJobRuns } = await import('../jobs/index.js');
    const job = JOBS.find((j) => j.name === 'scheduledSend')!;
    const before = db().select().from(schema.jobRuns).all().filter((r) => r.name === 'scheduledSend').length;
    const r = await runJob(job);
    expect(r.ok).toBe(true);
    expect(db().select().from(schema.jobRuns).all().filter((x) => x.name === 'scheduledSend').length).toBe(before);
    db().insert(schema.jobRuns).values({ name: 'old', startedAt: new Date(Date.now() - 100 * 86400_000).toISOString() }).run();
    expect(pruneJobRuns(60)).toBeGreaterThanOrEqual(1);
    expect(db().select().from(schema.jobRuns).all().some((x) => x.name === 'old')).toBe(false);
  });

  it('API: scheduledAt 付きの送信は予約として保存され、一覧・取消ができる', async () => {
    const app = createApp();
    const { setPassword } = await import('../auth/index.js');
    setPassword('sched-test-password');
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'sched-test-password' }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const conv = db()
      .insert(schema.conversations)
      .values({ channel: 'chatwork', externalThreadId: '9999', subject: null, counterpartName: 'API 予約', lastMessageAt: new Date().toISOString() })
      .returning()
      .get();
    const at = new Date(Date.now() + 3600_000).toISOString();
    const res = await app.request(`/api/conversations/${conv.id}/send`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ text: '予約テスト', scheduledAt: at }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scheduled: { id: number; status: string; scheduledAt: string } };
    expect(body.scheduled.status).toBe('pending');
    expect(body.scheduled.scheduledAt).toBe(at);
    const list = (await (await app.request('/api/scheduled-messages', { headers: { cookie } })).json()) as { id: number }[];
    expect(list.some((x) => x.id === body.scheduled.id)).toBe(true);
    const detail = (await (await app.request(`/api/conversations/${conv.id}`, { headers: { cookie } })).json()) as { scheduled: { id: number }[] };
    expect(detail.scheduled.map((x) => x.id)).toEqual([body.scheduled.id]);
    const del = await app.request(`/api/scheduled-messages/${body.scheduled.id}`, { method: 'DELETE', headers: { cookie } });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { status: string }).status).toBe('cancelled');
  });
});

describe('未紐付けの連絡先の表示', () => {
  it('見えない文字だけの名前は空扱いにし、警告には相手・本文の抜粋・受信日時が入り、続報で更新される', async () => {
    const { cleanDisplayName, excerpt, raiseUnlinkedContact } = await import('../services/identity.js');
    const { ingestMessage } = await import('../services/inbox.js');
    expect(cleanDisplayName('\uFE0E\uFE0E')).toBeNull();
    expect(cleanDisplayName(' \u200B ')).toBeNull();
    expect(cleanDisplayName('山田\uFE0F 太郎')).toBe('山田 太郎');
    expect(excerpt('[To:123]瀧口先生\n\nお世話になります。', 10)).toBe('瀧口先生 お世話にな…');

    // 名前が取れない LINE の相手からの受信
    const r1 = await ingestMessage({
      channel: 'line',
      externalThreadId: 'Uabcdef123456',
      externalId: 'line-unlinked-1',
      direction: 'in',
      sentAt: '2026-09-08T17:31:00.000Z',
      senderName: '\uFE0E\uFE0E',
      body: '先生、先日の件でご相談があります。明日お電話してもよろしいでしょうか。',
      attachments: [],
      identity: { channel: 'line', lineUserId: 'Uabcdef123456', displayName: '\uFE0E\uFE0E' },
    });
    expect(r1.conversation.counterpartName).toBeNull();
    const a1 = db().select().from(schema.alerts).all().find((a) => a.dedupeKey === 'unlinked:line:Uabcdef123456')!;
    expect(a1.title).toBe('LINE公式: 名前が取得できない LINE の相手（ID 末尾 …123456）');
    expect(a1.body).toContain('「先生、先日の件でご相談があります。');
    expect(a1.body).toContain('受信: 9/9(水) 02:31');
    expect((a1.payload as { preview: string; messageCount: number }).messageCount).toBe(1);

    // 2 通目（今度は名前が取れた）: 会話の名前が入り、警告は最新の内容に更新される
    await ingestMessage({
      channel: 'line',
      externalThreadId: 'Uabcdef123456',
      externalId: 'line-unlinked-2',
      direction: 'in',
      sentAt: '2026-09-08T18:00:00.000Z',
      senderName: '鈴木 花子',
      body: '写真を送ります',
      attachments: [],
      identity: { channel: 'line', lineUserId: 'Uabcdef123456', displayName: '鈴木 花子' },
    });
    const conv = db().select().from(schema.conversations).where(eq(schema.conversations.id, r1.conversation.id)).get()!;
    expect(conv.counterpartName).toBe('鈴木 花子');
    const a2 = db().select().from(schema.alerts).where(eq(schema.alerts.id, a1.id)).get()!;
    expect(a2.status).toBe('open');
    expect(a2.title).toBe('LINE公式: 鈴木 花子');
    expect(a2.body).toContain('「写真を送ります」');
    expect(a2.body).toContain('この相手からの受信 2 件');
    expect((a2.payload as { messageCount: number; displayName: string }).messageCount).toBe(2);

    // Gmail: 名前とアドレス、件名
    raiseUnlinkedContact(r1.conversation.id, { channel: 'gmail', email: 'taro@example.com' }, '田中 太郎', { body: 'はじめまして', sentAt: '2026-09-09T00:00:00.000Z', subject: '相談のお願い' });
    const g = db().select().from(schema.alerts).all().find((a) => a.dedupeKey === 'unlinked:gmail:taro@example.com')!;
    expect(g.title).toBe('Gmail: 田中 太郎（taro@example.com）「相談のお願い」');

    // 旧形式の警告（抜粋なし）は起動時の作り直しで新しい表示になる
    const { refreshUnlinkedAlerts } = await import('../services/identity.js');
    const { upsertAlert } = await import('../services/alerts.js');
    db().update(schema.alerts).set({ status: 'resolved' }).where(eq(schema.alerts.id, a1.id)).run();
    const old = upsertAlert({ type: 'unlinked_contact', dedupeKey: 'unlinked:line:old-style', title: '未紐付けの連絡先: ︎︎（line）', body: '依頼者に紐付けると…', payload: { conversationId: r1.conversation.id, identity: { channel: 'line', lineUserId: 'Uabcdef123456' }, displayName: '︎︎' } });
    expect(refreshUnlinkedAlerts()).toBe(1);
    const fixed = db().select().from(schema.alerts).where(eq(schema.alerts.id, old.id)).get()!;
    expect(fixed.title).toBe('LINE公式: 鈴木 花子');
    expect(fixed.body).toContain('「写真を送ります」');
    expect(refreshUnlinkedAlerts()).toBe(0);
  });
});

describe('会話の最終日時', () => {
  it('後から拾った古い発言では最終日時を巻き戻さず、未読・要返信も変えない。巻き戻っていたものは起動時に直る', async () => {
    const { ingestMessage, repairConversationTimes, markRead } = await import('../services/inbox.js');
    const base = { channel: 'chatwork' as const, externalThreadId: '424242', attachments: [], identity: { channel: 'chatwork' as const, chatworkRoomId: 424242, chatworkAccountId: 77, displayName: '事務 花子' }, senderName: '事務 花子', subject: 'テストルーム' };
    // 最新の発言（Webhook で先に届く）
    const r1 = await ingestMessage({ ...base, externalId: 'cw-new', direction: 'in', sentAt: '2026-09-09T01:00:00.000Z', body: '最新の連絡です' });
    markRead(r1.conversation.id);
    // ポーリングが後からさかのぼって拾った 1 週間前の発言
    await ingestMessage({ ...base, externalId: 'cw-old', direction: 'in', sentAt: '2026-09-02T01:00:00.000Z', body: '先週の連絡' });
    let c = db().select().from(schema.conversations).where(eq(schema.conversations.id, r1.conversation.id)).get()!;
    expect(c.lastMessageAt).toBe('2026-09-09T01:00:00.000Z');
    expect(c.lastInboundAt).toBe('2026-09-09T01:00:00.000Z');
    expect(c.unread).toBe(0);
    // 自分の古い発言も要返信を消さない
    await ingestMessage({ ...base, externalId: 'cw-old-out', direction: 'out', sentAt: '2026-09-01T01:00:00.000Z', body: '先々週の返信', senderName: '自分' });
    c = db().select().from(schema.conversations).where(eq(schema.conversations.id, r1.conversation.id)).get()!;
    expect(c.needsReply).toBe(true);
    expect(c.lastOutboundAt).toBe('2026-09-01T01:00:00.000Z');
    // 新しい発言は従来どおり
    await ingestMessage({ ...base, externalId: 'cw-newer', direction: 'in', sentAt: '2026-09-09T02:00:00.000Z', body: 'さらに新しい連絡' });
    c = db().select().from(schema.conversations).where(eq(schema.conversations.id, r1.conversation.id)).get()!;
    expect(c.lastMessageAt).toBe('2026-09-09T02:00:00.000Z');
    expect(c.unread).toBe(1);
    // 旧版で巻き戻っていた会話は起動時の修復で直る
    db().update(schema.conversations).set({ lastMessageAt: '2026-09-02T01:00:00.000Z', lastInboundAt: '2026-09-02T01:00:00.000Z' }).where(eq(schema.conversations.id, c.id)).run();
    expect(repairConversationTimes()).toBeGreaterThanOrEqual(1);
    c = db().select().from(schema.conversations).where(eq(schema.conversations.id, r1.conversation.id)).get()!;
    expect(c.lastMessageAt).toBe('2026-09-09T02:00:00.000Z');
    expect(c.lastInboundAt).toBe('2026-09-09T02:00:00.000Z');
    expect(repairConversationTimes()).toBe(0);
  });
});

describe('タスクの一括処理と、記録からのタスク化の単位', () => {
  it('チェックしたタスクをまとめて完了・状態変更・催促・削除でき、削除は記録との結び付きも外す', async () => {
    const { createTask, bulkUpdateTasks, listTasks } = await import('../services/tasks.js');
    const { addCaseNote } = await import('../services/cases.js');
    const client = db().insert(schema.clients).values({ name: '一括 太郎', emails: [], aliases: [] }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '一括テスト事件', caseType: 'general_civil', status: 'active' }).returning().get();
    const t1 = await createTask({ title: 'A', clientId: client.id, caseId: kase.id, conversationId: null, status: 'open', followUpAt: null, note: null, syncToChatwork: false });
    const t2 = await createTask({ title: 'B', clientId: client.id, caseId: kase.id, conversationId: null, status: 'waiting_client', followUpAt: null, note: null, syncToChatwork: false });
    const t3 = await createTask({ title: 'C', clientId: client.id, caseId: kase.id, conversationId: null, status: 'open', followUpAt: null, note: null, syncToChatwork: false });
    expect(bulkUpdateTasks([t1.id, t2.id], 'done')).toEqual({ updated: 2 });
    const done = listTasks({ status: 'done', caseId: kase.id });
    expect(done.map((t) => t.title).sort()).toEqual(['A', 'B']);
    expect(done.every((t) => t.completedAt)).toBe(true);
    // すでに同じ状態のものは数えない
    expect(bulkUpdateTasks([t1.id, t3.id], 'done')).toEqual({ updated: 1 });
    expect(bulkUpdateTasks([t1.id, t2.id, t3.id], 'waiting_other')).toEqual({ updated: 3 });
    // 催促は返信待ちのものだけ
    const before = db().select().from(schema.tasks).where(eq(schema.tasks.id, t1.id)).get()!.followUpAt;
    expect(bulkUpdateTasks([t1.id], 'open')).toEqual({ updated: 1 });
    expect(bulkUpdateTasks([t1.id, t2.id], 'nudge')).toEqual({ updated: 1 });
    expect(db().select().from(schema.tasks).where(eq(schema.tasks.id, t2.id)).get()!.lastNudgedAt).toBeTruthy();
    expect(before).toBeTruthy();
    // 記録からタスク化したものを削除すると、記録側の taskId が外れる
    const note = await addCaseNote(
      { caseId: kase.id, kind: 'phone', rawText: 'x', theirSaid: [], ourSaid: [], decisions: [], nextActions: [{ title: '書面を送る', due: null }], attachments: [], waitingFor: 'none' },
      { createTasks: 'each' },
    );
    const taskId = note.nextActions[0].taskId!;
    expect(taskId).toBeTruthy();
    expect(bulkUpdateTasks([taskId, 999999], 'delete')).toEqual({ updated: 1 });
    expect(db().select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get()).toBeUndefined();
    expect(db().select().from(schema.caseNotes).where(eq(schema.caseNotes.id, note.id)).get()!.nextActions[0].taskId).toBeNull();
  });

  it('記録の次のアクションを 1 つのタスクにまとめられ、タスク化する項目を選べる', async () => {
    const { addCaseNote } = await import('../services/cases.js');
    const client = db().insert(schema.clients).values({ name: 'まとめ 花子', emails: [], aliases: [] }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: 'まとめテスト事件', caseType: 'general_civil', status: 'active' }).returning().get();
    const actions = [
      { title: '依頼者に和解案を説明する', due: '2026-09-12' },
      { title: '相手方へ回答する', due: '2026-09-18' },
      { title: '証拠を整理する', due: null },
    ];
    const single = await addCaseNote(
      { caseId: kase.id, kind: 'phone', rawText: 'x', gist: '和解案 300 万円の提示あり', theirSaid: [], ourSaid: [], decisions: [], nextActions: actions, attachments: [], waitingFor: 'none' },
      { createTasks: 'single', taskIndexes: [0, 1] },
    );
    const ids = single.nextActions.map((a) => a.taskId ?? null);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).toBeNull();
    const task = db().select().from(schema.tasks).where(eq(schema.tasks.id, ids[0]!)).get()!;
    expect(task.title).toBe('依頼者に和解案を説明する ほか 1 件');
    expect(task.note).toContain('・相手方へ回答する（期限 2026-09-18）');
    expect(task.note).toContain('和解案 300 万円の提示あり');
    expect(task.followUpAt).toBe(new Date('2026-09-12T09:00:00+09:00').toISOString());
    // 1 件だけ選ぶと「ほか」は付かない
    const one = await addCaseNote(
      { caseId: kase.id, kind: 'memo', rawText: 'y', theirSaid: [], ourSaid: [], decisions: [], nextActions: actions, attachments: [], waitingFor: 'none' },
      { createTasks: 'single', taskIndexes: [2] },
    );
    const t2 = db().select().from(schema.tasks).where(eq(schema.tasks.id, one.nextActions[2].taskId!)).get()!;
    expect(t2.title).toBe('証拠を整理する');
    // アクションごと（選んだものだけ）
    const each = await addCaseNote(
      { caseId: kase.id, kind: 'memo', rawText: 'z', theirSaid: [], ourSaid: [], decisions: [], nextActions: actions, attachments: [], waitingFor: 'none' },
      { createTasks: 'each', taskIndexes: [1, 2] },
    );
    expect(each.nextActions[0].taskId ?? null).toBeNull();
    expect(each.nextActions[1].taskId).toBeTruthy();
    expect(each.nextActions[2].taskId).toBeTruthy();
    expect(each.nextActions[1].taskId).not.toBe(each.nextActions[2].taskId);
  });
});

describe('メニューの件数', () => {
  it('受信箱の要返信・未完了タスク・要確認の数を返す', async () => {
    const { navCounts } = await import('../routes/settings.js');
    const { createTask } = await import('../services/tasks.js');
    const before = navCounts();
    await createTask({ title: '件数テスト', clientId: null, caseId: null, conversationId: null, status: 'open', followUpAt: null, note: null, syncToChatwork: false });
    db().insert(schema.conversations).values({ channel: 'gmail', externalThreadId: 'nav-count-1', subject: null, counterpartName: 'x', lastMessageAt: new Date().toISOString(), needsReply: true }).run();
    db().insert(schema.alerts).values({ type: 'line_quota', dedupeKey: 'nav-count-alert', title: 'x', payload: {} }).run();
    const after = navCounts();
    expect(after.tasks).toBe(before.tasks + 1);
    expect(after.inbox).toBe(before.inbox + 1);
    expect(after.alerts).toBe(before.alerts + 1);
  });
});

describe('API 利用料', () => {
  it('モデルごとの単価で料金を計算し、月ごと・用途ごとにまとめる', async () => {
    const { costUsd, recordUsage, usageSummary, monthRange, currentMonthJst } = await import('../services/apiCost.js');
    // Opus 5: 入力 5 ドル・出力 25 ドル・キャッシュ書込 6.25・読出 0.5（100 万トークンあたり）
    expect(costUsd('claude-opus-5', { input: 1_000_000, output: 0, cacheWrite: 0, cacheRead: 0 })).toEqual({ usd: 5, estimated: false });
    expect(costUsd('claude-opus-5', { input: 0, output: 100_000, cacheWrite: 0, cacheRead: 0 }).usd).toBeCloseTo(2.5, 6);
    expect(costUsd('claude-sonnet-5', { input: 1_000_000, output: 1_000_000, cacheWrite: 0, cacheRead: 0 }).usd).toBeCloseTo(12, 6);
    expect(costUsd('claude-fable-5-1', { input: 0, output: 0, cacheWrite: 0, cacheRead: 1_000_000 }).usd).toBeCloseTo(0.25, 6);
    // 料金表に無いモデルは Opus 5 の単価で概算し、その旨を返す
    expect(costUsd('claude-unknown-9', { input: 1_000_000, output: 0, cacheWrite: 0, cacheRead: 0 })).toEqual({ usd: 5, estimated: true });
    const month = currentMonthJst();
    const before = usageSummary(month).total.usd;
    recordUsage({ model: 'claude-opus-5', purpose: '返信の下書き', tokens: { input: 2000, output: 500, cacheWrite: 1000, cacheRead: 3000 } });
    recordUsage({ model: 'claude-opus-5', purpose: '記録の整理（電話メモなど）', tokens: { input: 1000, output: 200, cacheWrite: 0, cacheRead: 0 } });
    const s = usageSummary(month);
    // 2000*5 + 500*25 + 1000*6.25 + 3000*0.5 = 30,250 μドル、1000*5 + 200*25 = 10,000 μドル
    expect(s.total.usd - before).toBeCloseTo(0.04025, 6);
    expect(s.total.calls).toBeGreaterThanOrEqual(2);
    expect(s.byPurpose.find((p) => p.key === '返信の下書き')!.usd).toBeCloseTo(0.03025, 6);
    expect(s.byModel[0].key).toBe('claude-opus-5');
    expect(s.history[0].month).toBe(month);
    expect(s.history.length).toBe(6);
    expect(s.rate).toBe(150);
    // 月の範囲は JST（9 月 1 日 0:00 JST = 8 月 31 日 15:00 UTC）
    expect(monthRange('2026-09')).toEqual({ from: '2026-08-31T15:00:00.000Z', to: '2026-09-30T15:00:00.000Z' });
  });
});

describe('返信待ちの期限', () => {
  it('送信時に「いつまで待つか」を指定すると、その期限で返信待ちタスクを作る', async () => {
    const { sendToConversation } = await import('../services/send.js');
    const { setAdapter } = await import('../channels/registry.js');
    setAdapter('line', { channel: 'line', isConfigured: () => true, fetchAttachment: async () => Buffer.from(''), send: async () => ({ externalId: `wait-${Date.now()}`, externalThreadId: 'U-wait-test', sentAt: new Date().toISOString() }) });
    const conv = db().insert(schema.conversations).values({ channel: 'line', externalThreadId: 'U-wait-test', subject: null, counterpartName: '待ち 太郎', lastMessageAt: new Date().toISOString() }).returning().get();
    const until = new Date(Date.now() + 14 * 86400_000).toISOString();
    await sendToConversation(conv.id, { text: 'ご確認ください', attachmentIds: [], driveFiles: [], draftId: null, createWaitingTask: true, waitingFollowUpAt: until });
    const task = db().select().from(schema.tasks).all().find((t) => t.conversationId === conv.id)!;
    expect(task.status).toBe('waiting_client');
    expect(task.followUpAt).toBe(until);
    // 期限は後から個別に変えられる
    const { updateTask } = await import('../services/tasks.js');
    const later = new Date(Date.now() + 30 * 86400_000).toISOString();
    expect(updateTask(task.id, { followUpAt: later }).followUpAt).toBe(later);
    // API から期限だけ送っても状態（返信待ち）は変わらない（schema の既定値 status: open が混ざらない）
    const app = createApp();
    const { setPassword } = await import('../auth/index.js');
    setPassword('deadline-test-password');
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'deadline-test-password' }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const later2 = new Date(Date.now() + 45 * 86400_000).toISOString();
    const res = await app.request(`/api/tasks/${task.id}`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ followUpAt: later2 }) });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { status: string; followUpAt: string };
    expect(updated.status).toBe('waiting_client');
    expect(updated.followUpAt).toBe(later2);
    // 対応中のタスクは期日（dueAt）を API から変えられる
    const { createTask } = await import('../services/tasks.js');
    const open = await createTask({ title: '期日テスト', clientId: null, caseId: null, conversationId: null, status: 'open', followUpAt: null, note: null, syncToChatwork: false });
    const due = new Date(Date.now() + 5 * 86400_000).toISOString();
    const res2 = await app.request(`/api/tasks/${open.id}`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ dueAt: due }) });
    expect(res2.status).toBe(200);
    const u2 = (await res2.json()) as { status: string; dueAt: string | null };
    expect(u2.status).toBe('open');
    expect(u2.dueAt).toBe(due);
  });
});

describe('タスクの紐付け', () => {
  it('事件を指定すると依頼者も合わせ、依頼者を別の人に変えると他人の事件は外れる', async () => {
    const { createTask, updateTask } = await import('../services/tasks.js');
    const a = db().insert(schema.clients).values({ name: '紐付け A', emails: [], aliases: [] }).returning().get();
    const b = db().insert(schema.clients).values({ name: '紐付け B', emails: [], aliases: [] }).returning().get();
    const ka = db().insert(schema.cases).values({ clientId: a.id, title: 'A の事件', caseType: 'general_civil', status: 'active' }).returning().get();
    const t = await createTask({ title: '紐付けテスト', clientId: null, caseId: null, conversationId: null, status: 'open', followUpAt: null, note: null, syncToChatwork: false });
    const t1 = updateTask(t.id, { caseId: ka.id });
    expect(t1.caseId).toBe(ka.id);
    expect(t1.clientId).toBe(a.id);
    const t2 = updateTask(t.id, { clientId: b.id });
    expect(t2.clientId).toBe(b.id);
    expect(t2.caseId).toBeNull();
    const t3 = updateTask(t.id, { clientId: a.id, caseId: ka.id });
    expect(t3.clientId).toBe(a.id);
    expect(t3.caseId).toBe(ka.id);
  });
});

describe('LINE の友だちからの紐付け', () => {
  it('友だち追加で要確認に出て、一覧から依頼者に紐付けられ、既存の会話も付く', async () => {
    const { upsertLineFriend, raiseLineFollowed, listLineFriends, linkLineFriendToClient, markLineUnfollowed, backfillLineFriends } = await import('../services/lineFriends.js');
    const { ingestMessage } = await import('../services/inbox.js');
    // 友だち追加（まだメッセージなし）
    upsertLineFriend({ userId: 'Ufriend000000000000000000000000001', displayName: '友だち 一郎', pictureUrl: null, source: 'follow' });
    raiseLineFollowed('Ufriend000000000000000000000000001', '友だち 一郎');
    const alert = db().select().from(schema.alerts).all().find((a) => a.dedupeKey === 'line_followed:Ufriend000000000000000000000000001')!;
    expect(alert.type).toBe('line_followed');
    expect(alert.title).toBe('LINE 友だち追加: 友だち 一郎');
    const list = listLineFriends({ unlinkedOnly: true });
    const f = list.find((x) => x.userId === 'Ufriend000000000000000000000000001')!;
    expect(f.displayName).toBe('友だち 一郎');
    expect(f.client).toBeNull();
    expect(f.conversationId).toBeNull();
    // 依頼者に紐付け → 依頼者の lineUserId が入り、通知が消える
    const client = db().insert(schema.clients).values({ name: '友だち 一郎', emails: [], aliases: [] }).returning().get();
    linkLineFriendToClient('Ufriend000000000000000000000000001', client.id);
    expect(db().select().from(schema.clients).where(eq(schema.clients.id, client.id)).get()!.lineUserId).toBe('Ufriend000000000000000000000000001');
    expect(db().select().from(schema.alerts).where(eq(schema.alerts.id, alert.id)).get()!.status).toBe('resolved');
    expect(listLineFriends({ unlinkedOnly: true }).some((x) => x.userId === 'Ufriend000000000000000000000000001')).toBe(false);
    // 紐付け後に届いた LINE は最初から依頼者の会話になる
    const r = await ingestMessage({ channel: 'line', externalThreadId: 'Ufriend000000000000000000000000001', externalId: 'friend-msg-1', direction: 'in', sentAt: new Date().toISOString(), senderName: '友だち 一郎', body: 'はじめまして', attachments: [], identity: { channel: 'line', lineUserId: 'Ufriend000000000000000000000000001', displayName: '友だち 一郎' } });
    expect(r.conversation.clientId).toBe(client.id);
    // 別の依頼者には付けられない
    const other = db().insert(schema.clients).values({ name: '別の 人', emails: [], aliases: [] }).returning().get();
    expect(() => linkLineFriendToClient('Ufriend000000000000000000000000001', other.id)).toThrow(/すでに/);
    // 先に会話がある相手を紐付けると会話も依頼者に付く
    const r2 = await ingestMessage({ channel: 'line', externalThreadId: 'Ufriend000000000000000000000000002', externalId: 'friend-msg-2', direction: 'in', sentAt: new Date().toISOString(), senderName: '友だち 二郎', body: 'こんにちは', attachments: [], identity: { channel: 'line', lineUserId: 'Ufriend000000000000000000000000002', displayName: '友だち 二郎' } });
    expect(r2.conversation.clientId).toBeNull();
    expect(backfillLineFriends()).toBeGreaterThanOrEqual(1);
    const f2 = listLineFriends({ unlinkedOnly: true }).find((x) => x.userId === 'Ufriend000000000000000000000000002')!;
    expect(f2.displayName).toBe('友だち 二郎');
    expect(f2.conversationId).toBe(r2.conversation.id);
    const c2 = db().insert(schema.clients).values({ name: '友だち 二郎', emails: [], aliases: [] }).returning().get();
    const linked = linkLineFriendToClient('Ufriend000000000000000000000000002', c2.id);
    expect(linked.conversationId).toBe(r2.conversation.id);
    expect(db().select().from(schema.conversations).where(eq(schema.conversations.id, r2.conversation.id)).get()!.clientId).toBe(c2.id);
    // ブロックされたら一覧から消える
    markLineUnfollowed('Ufriend000000000000000000000000002');
    expect(listLineFriends().some((x) => x.userId === 'Ufriend000000000000000000000000002')).toBe(false);
    // 依頼者の新規登録画面で友だちを選んでも、通知が消え、既存の会話が付く
    const app = createApp();
    const { setPassword } = await import('../auth/index.js');
    setPassword('line-friend-test');
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'line-friend-test' }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    upsertLineFriend({ userId: 'Ufriend000000000000000000000000003', displayName: '友だち 三郎', source: 'follow' });
    raiseLineFollowed('Ufriend000000000000000000000000003', '友だち 三郎');
    const res = await app.request('/api/clients', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: '友だち 三郎', lineUserId: 'Ufriend000000000000000000000000003' }) });
    expect(res.status).toBe(200);
    const made = (await res.json()) as { id: number; lineUserId: string };
    expect(made.lineUserId).toBe('Ufriend000000000000000000000000003');
    expect(db().select().from(schema.alerts).all().find((a) => a.dedupeKey === 'line_followed:Ufriend000000000000000000000000003')!.status).toBe('resolved');
    // 同じ友だちを別の依頼者に付けようとすると 400 系で断られる
    const dup = await app.request('/api/clients', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: '重複', lineUserId: 'Ufriend000000000000000000000000003' }) });
    expect(dup.status).toBeGreaterThanOrEqual(400);
    expect(db().select().from(schema.clients).all().some((c) => c.name === '重複')).toBe(false);
  });
});

describe('自分の送信の判定', () => {
  it('別名アドレスからのメールは送信扱いになり、誤って受信になっていたものは判定し直しで直る', async () => {
    const { normalizeGmailMessage } = await import('../channels/gmail.js');
    const { ingestMessage, refixOwnMessages } = await import('../services/inbox.js');
    const { configuredMyAddresses } = await import('../jobs/gmailPoll.js');
    const { setSetting } = await import('../services/settings.js');
    const base = { id: 'g1', threadId: 't-own-1', labelIds: ['INBOX'], internalDate: String(Date.now()), payload: { headers: [{ name: 'From', value: '瀧口 <info@example.com>' }, { name: 'To', value: 'client@example.org' }, { name: 'Subject', value: 'ご連絡' }], mimeType: 'text/plain', body: { data: Buffer.from('本文').toString('base64') } } } as never;
    expect(normalizeGmailMessage(base, ['takiguchi@gmail.com'])!.direction).toBe('in');
    expect(normalizeGmailMessage(base, ['takiguchi@gmail.com', 'info@example.com'])!.direction).toBe('out');
    setSetting('my_email_addresses', 'Info@Example.com, other@example.jp');
    expect(configuredMyAddresses()).toEqual(['info@example.com', 'other@example.jp']);
    // 誤って受信として取り込まれていた自分の控え
    const r = await ingestMessage({ channel: 'gmail', externalThreadId: 't-own-2', externalId: 'g-own-2', direction: 'in', sentAt: new Date().toISOString(), senderName: '瀧口', senderAddress: 'info@example.com', subject: 'ご連絡', body: 'こちらから送った控え', attachments: [], identity: { channel: 'gmail', email: 'info@example.com' } });
    expect(r.conversation.needsReply).toBe(true);
    const alertBefore = db().select().from(schema.alerts).all().find((a) => a.dedupeKey === 'unlinked:gmail:info@example.com');
    expect(alertBefore?.status).toBe('open');
    const fixed = refixOwnMessages(configuredMyAddresses());
    expect(fixed.fixed).toBeGreaterThanOrEqual(1);
    const conv = db().select().from(schema.conversations).where(eq(schema.conversations.id, r.conversation.id)).get()!;
    expect(conv.needsReply).toBe(false);
    expect(conv.lastInboundAt).toBeNull();
    expect(conv.unread).toBe(0);
    expect(db().select().from(schema.messages).where(eq(schema.messages.id, r.message.id)).get()!.direction).toBe('out');
    expect(db().select().from(schema.alerts).where(eq(schema.alerts.id, alertBefore!.id)).get()!.status).toBe('resolved');
    setSetting('my_email_addresses', '');
  });
});

describe('Chatwork の返信・引用', () => {
  it('返信は [rp] タグ、引用は [qt] タグを付けて送り、会話には返信先が結び付いて表示される', async () => {
    const { parseChatworkReplyTo, chatworkReplyPrefix, chatworkQuoteBlock, normalizeChatworkMessage } = await import('../channels/chatwork.js');
    const { sendToConversation } = await import('../services/send.js');
    const { ingestMessage, getConversation } = await import('../services/inbox.js');
    const { setAdapter } = await import('../channels/registry.js');
    expect(parseChatworkReplyTo('[rp aid=123 to=555-999][pname:123]さん\n了解です')).toEqual({ accountId: 123, messageId: '999' });
    expect(chatworkReplyPrefix(555, { accountId: 123, messageId: '999' })).toBe('[rp aid=123 to=555-999][pname:123]さん\n');
    expect(chatworkQuoteBlock({ accountId: 123, sendTimeUnix: 1700000000, body: '見積です' })).toBe('[qt][qtmeta aid=123 time=1700000000]見積です[/qt]\n');
    const sent: string[] = [];
    setAdapter('chatwork', { channel: 'chatwork', isConfigured: () => true, fetchAttachment: async () => Buffer.from(''), send: async (m) => { sent.push(m.text); return { externalId: `90000${sent.length}`, externalThreadId: '777001', sentAt: new Date().toISOString() }; } });
    // 相手の発言（Chatwork の生データ付き）
    const norm = normalizeChatworkMessage(777001, { message_id: '424242', account: { account_id: 4242, name: '事務 花子' }, body: '見積を送りました', send_time: 1700000000, update_time: 0 } as never, 1);
    const r = await ingestMessage(norm);
    // 返信＋引用で送信
    await sendToConversation(r.conversation.id, { text: '確認しました', attachmentIds: [], driveFiles: [], draftId: null, createWaitingTask: false, replyToMessageId: r.message.id, quoteMessageId: r.message.id });
    expect(sent[0]).toBe('[rp aid=4242 to=777001-424242][pname:4242]さん\n[qt][qtmeta aid=4242 time=1700000000]見積を送りました[/qt]\n確認しました');
    const conv = getConversation(r.conversation.id)!;
    const mine = conv.messages.find((m) => m.direction === 'out')!;
    expect(mine.replyTo?.id).toBe(r.message.id);
    expect(mine.replyTo?.excerpt).toBe('見積を送りました');
    expect(mine.body).not.toContain('[rp');
    // 相手からの返信（[rp] タグ）も返信先が結び付く
    const norm2 = normalizeChatworkMessage(777001, { message_id: '424243', account: { account_id: 4242, name: '事務 花子' }, body: '[rp aid=1 to=777001-900001][pname:1]さん\nありがとうございます', send_time: 1700000100, update_time: 0 } as never, 1);
    const r2 = await ingestMessage(norm2);
    const conv2 = getConversation(r.conversation.id)!;
    const reply = conv2.messages.find((m) => m.id === r2.message.id)!;
    expect(reply.replyTo?.id).toBe(mine.id);
    // 別の会話のメッセージは返信先にできない
    await expect(sendToConversation(r.conversation.id, { text: 'x', attachmentIds: [], driveFiles: [], draftId: null, createWaitingTask: false, replyToMessageId: 999999 })).rejects.toThrow();
  });
});

describe('複数事件のメッセージ振り分け', () => {
  it('事件が 2 件ある依頼者のメッセージは AI 判定で事件に振り分けられ、タイムラインは事件ごとに分かれる', async () => {
    const { setCaseClassifier, classifyMessageCase, classifyClientMessages } = await import('../services/caseClassify.js');
    const { ingestMessage, linkMessage } = await import('../services/inbox.js');
    const { caseTimeline } = await import('../services/cases.js');
    const { sendToConversation } = await import('../services/send.js');
    const { setAdapter } = await import('../channels/registry.js');
    const client = db().insert(schema.clients).values({ name: '並行 太郎', emails: ['heikou@example.com'], aliases: [] }).returning().get();
    const divorce = db().insert(schema.cases).values({ clientId: client.id, title: '離婚調停事件', caseType: 'divorce', status: 'active' }).returning().get();
    const traffic = db().insert(schema.cases).values({ clientId: client.id, title: '交通事故損害賠償請求事件', caseType: 'traffic', status: 'active' }).returning().get();
    // 判定関数を差し替え: 本文に「調停」があれば離婚、「保険」があれば交通事故、それ以外は不明
    setCaseClassifier(async ({ message, cases }) => {
      const t = message.body;
      const pick = t.includes('調停') ? cases.find((c) => c.title.includes('離婚')) : t.includes('保険') ? cases.find((c) => c.title.includes('交通')) : null;
      return { caseId: pick?.id ?? null, confidence: pick ? 'high' : 'low', reason: 'テスト' };
    });
    const base = { channel: 'gmail' as const, externalThreadId: 't-multi-1', attachments: [], identity: { channel: 'gmail' as const, email: 'heikou@example.com' }, senderName: '並行 太郎', senderAddress: 'heikou@example.com', subject: 'ご連絡' };
    const m1 = await ingestMessage({ ...base, externalId: 'multi-1', direction: 'in', sentAt: '2026-09-10T01:00:00.000Z', body: '調停の期日の件でご相談です' });
    const m2 = await ingestMessage({ ...base, externalId: 'multi-2', direction: 'in', sentAt: '2026-09-10T02:00:00.000Z', body: '保険会社から連絡がありました' });
    const m3 = await ingestMessage({ ...base, externalId: 'multi-3', direction: 'in', sentAt: '2026-09-10T03:00:00.000Z', body: 'ありがとうございます' });
    expect(m1.conversation.clientId).toBe(client.id);
    // 裏の判定は非同期なので、ここでは明示的に判定する
    await classifyMessageCase(m1.message.id);
    await classifyMessageCase(m2.message.id);
    const r3 = await classifyMessageCase(m3.message.id);
    expect(r3?.caseId).toBeNull();
    const byId = (id: number) => db().select().from(schema.messages).where(eq(schema.messages.id, id)).get()!;
    expect(byId(m1.message.id).caseId).toBe(divorce.id);
    expect(byId(m2.message.id).caseId).toBe(traffic.id);
    expect(byId(m3.message.id).caseId).toBeNull();
    // タイムライン: 離婚には調停の話と未確定、交通事故には保険の話と未確定
    const tDiv = caseTimeline(divorce.id).filter((x) => x.type.startsWith('message:'));
    const tTra = caseTimeline(traffic.id).filter((x) => x.type.startsWith('message:'));
    expect(tDiv.map((x) => x.ref!.messageId).sort()).toEqual([m1.message.id, m3.message.id].sort());
    expect(tTra.map((x) => x.ref!.messageId).sort()).toEqual([m2.message.id, m3.message.id].sort());
    expect(tDiv.find((x) => x.ref!.messageId === m3.message.id)!.title).toContain('事件未確定');
    expect(tDiv.find((x) => x.ref!.messageId === m1.message.id)!.title).not.toContain('事件未確定');
    // 手動で未確定のものを交通事故に付けると、離婚側から消える
    linkMessage(m3.message.id, { caseId: traffic.id });
    expect(caseTimeline(divorce.id).some((x) => x.ref?.messageId === m3.message.id)).toBe(false);
    // 返信は返信先の事件を引き継ぐ
    setAdapter('gmail', { channel: 'gmail', isConfigured: () => true, fetchAttachment: async () => Buffer.from(''), send: async () => ({ externalId: `multi-out-${Date.now()}`, externalThreadId: 't-multi-1', sentAt: new Date().toISOString() }) });
    const out = await sendToConversation(m1.conversation.id, { text: '承知しました', attachmentIds: [], driveFiles: [], draftId: null, createWaitingTask: false, replyToMessageId: m1.message.id });
    expect(byId(out.messageId).caseId).toBe(divorce.id);
    // まとめて振り分け（未確定だけ）
    const m4 = await ingestMessage({ ...base, externalId: 'multi-4', direction: 'in', sentAt: '2026-09-10T04:00:00.000Z', body: '次回の調停はいつですか' });
    const bulk = await classifyClientMessages(client.id);
    expect(bulk.checked).toBeGreaterThanOrEqual(1);
    expect(byId(m4.message.id).caseId).toBe(divorce.id);
    // 事件が 1 件だけの依頼者では判定しない
    const single = db().insert(schema.clients).values({ name: '単独 花子', emails: [], aliases: [] }).returning().get();
    db().insert(schema.cases).values({ clientId: single.id, title: '単独事件', caseType: 'general_civil', status: 'active' }).run();
    expect(await classifyClientMessages(single.id)).toMatchObject({ checked: 0, assigned: 0 });
  });
});

describe('受信ファイルの二重保存の防止', () => {
  it('同時に取得しても 1 つしか保存されず、途中で止まった後の再取得でも同じファイルを増やさない', async () => {
    const { processAttachment } = await import('../services/attachments.js');
    const { setAdapter } = await import('../channels/registry.js');
    const { extractDownloadIds } = await import('../channels/chatwork.js');
    const { ingestMessage } = await import('../services/inbox.js');
    const { setSetting } = await import('../services/settings.js');
    setSetting('attachment_policy', 'client_only');
    setSetting('attachment_smart_names', '0');
    let fetches = 0;
    setAdapter('chatwork', {
      channel: 'chatwork',
      isConfigured: () => true,
      fetchAttachment: async () => {
        fetches++;
        // 取得に時間がかかる状況を作り、同時実行を起こす
        await new Promise((r) => setTimeout(r, 30));
        return Buffer.from('DUPLICATE-TEST-BODY');
      },
      send: async () => ({ externalId: 'x', externalThreadId: 'y', sentAt: new Date().toISOString() }),
    });
    const client = db().insert(schema.clients).values({ name: '二重 太郎', kana: 'にじゅうたろう', emails: [], aliases: [] }).returning().get();
    const now = new Date().toISOString();
    const conv = db().insert(schema.conversations).values({ channel: 'chatwork', externalThreadId: 'dup-room', clientId: client.id, lastMessageAt: now, lastInboundAt: now }).returning().get();
    const msg = db().insert(schema.messages).values({ conversationId: conv.id, channel: 'chatwork', externalId: 'dup-msg-1', direction: 'in', sentAt: now }).returning().get();
    const att = db().insert(schema.attachments).values({ messageId: msg.id, filename: '見積書.pdf', channelRef: { roomId: 1, fileId: 1 } }).returning().get();
    // 受信時の保存とジョブの再取得が重なった状況
    await Promise.all([processAttachment(att.id), processAttachment(att.id)]);
    expect(fetches).toBe(1);
    const saved = db().select().from(schema.attachments).where(eq(schema.attachments.id, att.id)).get()!;
    expect(saved.status).toBe('stored');
    expect(saved.processingAt).toBeNull();
    const folder = path.dirname(path.join(tmp, 'clients', saved.storedPath!));
    const names = () => fs.readdirSync(folder).filter((n) => n.includes('見積書'));
    expect(names().length).toBe(1);
    // アップロードは済んだが記録できずに終わった状況（処理中の印が残ったまま・未保存）
    db().update(schema.attachments).set({ status: 'pending', storedPath: null, driveItemId: null, processingAt: new Date(Date.now() - 30 * 60_000).toISOString() }).where(eq(schema.attachments.id, att.id)).run();
    await processAttachment(att.id);
    expect(fetches).toBe(2); // 取得はやり直すが
    expect(names().length).toBe(1); // 同じ内容なので保存は増えない
    expect(db().select().from(schema.attachments).where(eq(schema.attachments.id, att.id)).get()!.status).toBe('stored');

    // Chatwork の本文に同じファイルが 2 回書かれていても 1 件
    expect(extractDownloadIds('[download:55]見積書.pdf[/download]\n引用: [download:55]見積書.pdf[/download]')).toEqual([{ fileId: 55, filename: '見積書.pdf' }]);
    // 受信時も同じファイルは 1 行だけ登録する
    const r = await ingestMessage(
      {
        channel: 'chatwork',
        externalThreadId: 'dup-room',
        externalId: 'dup-msg-2',
        direction: 'in',
        sentAt: new Date().toISOString(),
        senderName: '二重 太郎',
        body: '資料です',
        attachments: [
          { filename: '契約書.pdf', ref: { roomId: 1, fileId: 9 } },
          { filename: '契約書.pdf', ref: { roomId: 1, fileId: 9 } },
        ],
        identity: { channel: 'chatwork', chatworkRoomId: 1, chatworkAccountId: 2 },
      },
      { processAttachments: false },
    );
    expect(db().select().from(schema.attachments).where(eq(schema.attachments.messageId, r.message.id)).all().length).toBe(1);
    setSetting('attachment_smart_names', '1');
  });
});


describe('AI モデルの選択', () => {
  it('未設定なら環境変数の既定、設定すればそのモデル、軽い処理は別に選べる', () => {
    setSetting('ai_model', '');
    setSetting('ai_model_light', '');
    expect(aiModel()).toBe('claude-opus-5');
    expect(aiModel('light')).toBe('claude-opus-5');

    // 主モデルだけ変えると軽い処理もそれに従う
    setSetting('ai_model', 'claude-sonnet-5');
    expect(aiModel()).toBe('claude-sonnet-5');
    expect(aiModel('light')).toBe('claude-sonnet-5');

    // 軽い処理だけ安いモデルに回す
    setSetting('ai_model', 'claude-opus-5');
    setSetting('ai_model_light', 'claude-sonnet-5');
    expect(aiModel()).toBe('claude-opus-5');
    expect(aiModel('light')).toBe('claude-sonnet-5');

    // 知らないモデル名は既定に戻す（設定ミスで止まらないように）
    setSetting('ai_model', 'gpt-9');
    setSetting('ai_model_light', 'gpt-9');
    expect(aiModel()).toBe('claude-opus-5');
    expect(aiModel('light')).toBe('claude-opus-5');

    setSetting('ai_model', '');
    setSetting('ai_model_light', '');
  });
});
