import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ExcelJS from 'exceljs';
import { classifyEventTitle, familyName, titleMentionsClient, addBusinessDays, formatJaDateTime, jstDate, inferDocType, isDebtIssue } from '@lcm/shared';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-domain-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.STORAGE_BACKEND = 'local';
process.env.LOCAL_CLIENT_ROOT = path.join(tmp, 'clients');
process.env.DATA_DIR = tmp;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { importExcel, previewExcel, guessMapping, creditorDashboard, updateCreditor, addCreditorEvent, checkCreditorOverdue, exportExcel } = await import('../services/creditors.js');
const { extractText, buildDocx, anonymize } = await import('../services/forms.js');
const { checkPostEvents } = await import('../services/court.js');
const { openAlerts } = await import('../services/alerts.js');
const { fillTemplate, DEFAULT_TEMPLATES } = await import('../services/templates.js');
const { storedFilename, sanitizeFilename } = await import('../services/attachments.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

describe('共有ユーティリティ', () => {
  it('カレンダータイトルの分類', () => {
    expect(classifyEventTitle('山田 第3回口頭弁論期日')).toBe('hearing');
    expect(classifyEventTitle('田中 打合せ')).toBe('meeting');
    expect(classifyEventTitle('佐藤 WEB相談')).toBe('consult');
    expect(classifyEventTitle('佐藤 新規相談 仮')).toBe('hold');
    expect(classifyEventTitle('歯医者')).toBe('other');
  });
  it('姓の抽出と依頼者名の一致', () => {
    expect(familyName('山田 太郎')).toBe('山田');
    expect(familyName('山田太郎')).toBe('山田');
    expect(titleMentionsClient('山田 期日', ['山田 太郎', '山田'])).toBe(true);
    expect(titleMentionsClient('鈴木 期日', ['山田 太郎'])).toBe(false);
  });
  it('営業日加算（土日スキップ）と日本語日時', () => {
    const fri = jstDate(2026, 9, 4, 10, 0); // 金曜
    const d = addBusinessDays(fri, 3);
    expect(formatJaDateTime(d)).toBe('9月9日(水)10時');
    expect(formatJaDateTime(jstDate(2026, 4, 10, 14, 30))).toBe('4月10日(金)14時30分');
  });
  it('文書種別と借金判定', () => {
    expect(inferDocType('20240101_答弁書_最終.docx')).toBe('答弁書');
    expect(inferDocType('メモ.txt')).toBeNull();
    expect(isDebtIssue('自己破産を考えています')).toBe(true);
  });
  it('ファイル名の整形', () => {
    expect(sanitizeFilename('a/b:c*.pdf')).toBe('a_b_c_.pdf');
    expect(storedFilename('line', '2026-09-04T00:00:00.000Z', '写真.jpg')).toBe('20260904_line_写真.jpg');
  });
  it('テンプレート差し込み', () => {
    const t = DEFAULT_TEMPLATES.find((x) => x.key === 'web_confirm')!;
    const out = fillTemplate(t.body, { 姓: '山田', 日時: '4月10日14時', URL: 'https://zoom.us/j/1' });
    expect(out).toContain('山田様');
    expect(out).toContain('4月10日14時');
    expect(out).not.toContain('{{');
  });
});

describe('債権者管理', () => {
  let caseId: number;
  it('Excel の列推定と取込', async () => {
    const client = db().insert(schema.clients).values({ name: '甲社', aliases: [], emails: [] }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, caseType: 'bankruptcy_corp', title: '甲社 破産' }).returning().get();
    caseId = kase.id;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('一覧');
    ws.addRow(['債権者名', '住所', '電話番号', 'メールアドレス', '債権額', '備考']);
    ws.addRow(['A銀行', '東京都千代田区1-1', '03-0000-0000', 'a@bank.example', '1,200,000', 'メイン']);
    ws.addRow(['B商事', '大阪市北区2-2', '', 'b@corp.example', 300000, '']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const preview = await previewExcel(buf);
    expect(preview.headers).toEqual(['債権者名', '住所', '電話番号', 'メールアドレス', '債権額', '備考']);
    const mapping = guessMapping(preview.headers);
    expect(mapping.name).toBe(0);
    expect(mapping.email).toBe(3);
    expect(mapping.claimAmount).toBe(4);
    const r = await importExcel(caseId, buf, mapping);
    expect(r).toEqual({ created: 2, updated: 0 });
    const again = await importExcel(caseId, buf, mapping);
    expect(again).toEqual({ created: 0, updated: 2 });
    const rows = db().select().from(schema.creditors).all();
    expect(rows.find((x) => x.name === 'A銀行')?.claimAmount).toBe(1200000);
    expect(rows.find((x) => x.name === 'A銀行')?.stage).toBe('受任通知送付');
  });
  it('段階更新・イベント・ダッシュボード・期限超過', async () => {
    const a = db().select().from(schema.creditors).where(eq(schema.creditors.name, 'A銀行')).get()!;
    updateCreditor(a.id, { stage: '債権調査票送付', nextAction: '回答待ち', nextActionDue: '2020-01-01' });
    addCreditorEvent({ creditorId: a.id, channel: 'phone', direction: 'out', summary: '担当者に電話', attachments: [] });
    const dash = creditorDashboard(caseId);
    expect(dash.total).toBe(2);
    expect(dash.byStage['債権調査票送付']).toBe(1);
    expect(dash.overdue.length).toBe(1);
    expect(checkCreditorOverdue()).toBe(1);
    expect(openAlerts('creditor_overdue').length).toBe(1);
    const out = await exportExcel(caseId);
    expect(out.length).toBeGreaterThan(1000);
  });
});

describe('書式ライブラリ', () => {
  it('docx を生成して本文抽出できる', async () => {
    const docx = await buildDocx('答弁書', '第1 請求の趣旨に対する答弁\n1 原告の請求を棄却する。');
    const text = await extractText('答弁書.docx', docx);
    expect(text).toContain('請求の趣旨に対する答弁');
    expect(text).toContain('AI 下書き');
  });
  it('伏字化', () => {
    const t = anonymize('依頼者 山田太郎（〒630-8213 奈良県奈良市登大路5番地）電話 0742-23-8710 mail: a@b.example', ['山田太郎']);
    expect(t).not.toContain('山田太郎');
    expect(t).not.toContain('0742-23-8710');
    expect(t).not.toContain('a@b.example');
  });
});

describe('期日終了後の確認', () => {
  it('次回期日がなければアラート、あれば出ない', () => {
    const client = db().insert(schema.clients).values({ name: '乙 一郎', aliases: [], emails: [] }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '乙 損害賠償' }).returning().get();
    db().insert(schema.calendarEvents).values({ googleEventId: 'e1', clientId: client.id, caseId: kase.id, kind: 'hearing', title: '乙 第1回弁論', startAt: '2026-08-01T01:00:00.000Z', endAt: '2026-08-01T02:00:00.000Z' }).run();
    expect(checkPostEvents()).toBe(1);
    expect(openAlerts('next_hearing_missing').length).toBe(1);
    db().insert(schema.calendarEvents).values({ googleEventId: 'e2', clientId: client.id, caseId: kase.id, kind: 'hearing', title: '乙 第2回弁論', startAt: '2026-08-20T01:00:00.000Z', endAt: '2026-08-20T02:00:00.000Z' }).run();
    db().insert(schema.calendarEvents).values({ googleEventId: 'e3', clientId: client.id, caseId: kase.id, kind: 'hearing', title: '乙 第3回弁論', startAt: '2099-08-20T01:00:00.000Z', endAt: '2099-08-20T02:00:00.000Z' }).run();
    expect(checkPostEvents()).toBe(0);
    const note = db().select().from(schema.caseNotes).where(eq(schema.caseNotes.caseId, kase.id)).all();
    expect(note.length).toBe(2);
  });
});

import { eq } from 'drizzle-orm';
