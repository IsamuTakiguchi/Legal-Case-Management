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
