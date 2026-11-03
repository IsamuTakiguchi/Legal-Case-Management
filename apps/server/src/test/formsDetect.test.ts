import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-formsdetect-'));
const root = path.join(tmp, 'clients');
fs.mkdirSync(root, { recursive: true });
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.STORAGE_BACKEND = 'local';
process.env.LOCAL_CLIENT_ROOT = root;

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { detectNewForms, listFormCandidates, setFormStatus, searchForms, formStats, indexForms, buildDocx } = await import('../services/forms.js');
const { setSetting } = await import('../services/settings.js');
const { driveParentPath } = await import('../integrations/storage.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

async function putFile(rel: string, when: Date, body = 'テスト本文') {
  const abs = path.join(root, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  // Word は本物の docx にする（本文を取り出せるように）
  await fsp.writeFile(abs, rel.endsWith('.docx') ? await buildDocx('書面', body) : body);
  await fsp.utimes(abs, when, when);
}
const names = () => db().select().from(schema.formTemplates).all().map((r) => `${r.name}:${r.status}`).sort();

describe('OneDrive の新しいファイルから書式の候補を見つける', () => {
  it('文書種別の分かる Word・Excel は自動で追加し、それ以外は候補にする。受領資料・書式フォルダ・古いもの・一時ファイルは見ない', async () => {
    const client = db().insert(schema.clients).values({ name: '山田 花子', onedriveFolderPath: '山田 花子' }).returning().get();
    db().insert(schema.cases).values({ clientId: client.id, title: '山田 離婚', caseType: 'divorce' }).run();
    const now = new Date();
    const recent = new Date(now.getTime() - 2 * 86400_000);
    await putFile('山田 花子/準備書面（1）.txt', recent); // txt は書式の対象外
    await putFile('山田 花子/準備書面（1）.docx', recent);
    await putFile('山田 花子/財産目録.xlsx', recent);
    await putFile('山田 花子/打合せメモ.docx', recent);
    await putFile('山田 花子/訴状.pdf', recent);
    await putFile('山田 花子/判決.pdf', recent); // 文書種別の分からない PDF は見ない
    await putFile('山田 花子/~$準備書面.docx', recent); // Word の一時ファイル
    await putFile('山田 花子/受領資料/通知書.docx', recent); // 依頼者から受け取ったもの
    await putFile('山田 花子/古い準備書面.docx', new Date(now.getTime() - 40 * 86400_000)); // 初回は 14 日より前を見ない
    await putFile('書式/訴状ひな形.docx', recent); // 書式フォルダは別に索引化する
    await putFile('_未振分/契約書.docx', recent); // 依頼者のフォルダではない

    const r = await detectNewForms({ now });
    expect(r).toMatchObject({ added: 1, candidates: 3 });
    expect(names()).toEqual(['打合せメモ.docx:candidate', '準備書面（1）.docx:active', '訴状.pdf:candidate', '財産目録.xlsx:candidate']);
    const auto = db().select().from(schema.formTemplates).all().find((x) => x.name === '準備書面（1）.docx')!;
    expect(auto).toMatchObject({ source: 'detected', docType: '準備書面', caseType: 'divorce', clientId: client.id });
    expect(auto.extractedText).toContain('テスト本文');

    // ライブラリの検索に出るのは追加したものだけ。候補は件数だけ
    expect(searchForms({}).map((x) => x.name)).toEqual(['準備書面（1）.docx']);
    expect(formStats()).toMatchObject({ total: 1, candidates: 3 });
    expect(listFormCandidates().map((x) => x.clientName)).toEqual(['山田 花子', '山田 花子', '山田 花子']);

    // 続きから見るので、変わっていなければ何も増えない
    expect(await detectNewForms()).toMatchObject({ added: 0, candidates: 0 });
    // そのあとにできたファイルは拾う
    await putFile('山田 花子/上申書.docx', new Date(Date.now() + 5000));
    expect(await detectNewForms()).toMatchObject({ added: 1, candidates: 0 });
  });

  it('候補は直してから追加でき、対象外にしたものはもう出さない。自動追加をやめるとすべて候補になる', async () => {
    const memo = listFormCandidates().find((c) => c.name === '打合せメモ.docx')!;
    setFormStatus(memo.id, 'active', { docType: '打合せメモ' });
    const pdf = listFormCandidates().find((c) => c.name === '訴状.pdf')!;
    setFormStatus(pdf.id, 'dismissed');
    expect(searchForms({}).map((x) => x.name).sort()).toEqual(['上申書.docx', '打合せメモ.docx', '準備書面（1）.docx']);
    expect(searchForms({}).find((x) => x.name === '打合せメモ.docx')?.docType).toBe('打合せメモ');

    // 書き直しても、対象外にしたものは候補に戻らない
    await putFile('山田 花子/訴状.pdf', new Date(Date.now() + 10_000), '書き直し');
    await detectNewForms();
    expect(listFormCandidates().map((c) => c.name)).toEqual(['財産目録.xlsx']);

    setSetting('forms_auto_add', '0');
    await putFile('山田 花子/答弁書.docx', new Date(Date.now() + 15_000));
    expect(await detectNewForms()).toMatchObject({ added: 0, candidates: 1 });
    setSetting('forms_auto_add', '1');
  });

  it('候補が提出書面のフォルダにあれば、夜の索引化でライブラリに入る', async () => {
    await putFile('山田 花子/提出書面/証拠説明書のメモ.xlsx', new Date(Date.now() + 20_000));
    setSetting('forms_auto_add', '0');
    await detectNewForms();
    setSetting('forms_auto_add', '1');
    expect(listFormCandidates().some((c) => c.name === '証拠説明書のメモ.xlsx')).toBe(true);
    await indexForms();
    expect(listFormCandidates().some((c) => c.name === '証拠説明書のメモ.xlsx')).toBe(false);
    expect(searchForms({}).some((x) => x.name === '証拠説明書のメモ.xlsx')).toBe(true);
  });

  it('OneDrive の親フォルダのパスを、アプリのパスに直す', () => {
    expect(driveParentPath('/drive/root:/依頼者/山田 花子')).toBe('/依頼者/山田 花子');
    expect(driveParentPath('/drives/b!abc/root:/%E4%BE%9D%E9%A0%BC%E8%80%85')).toBe('/依頼者');
    expect(driveParentPath('/drive/root:/100%達成')).toBe('/100%達成');
    expect(driveParentPath('/drive/root:')).toBe('/');
  });
});
