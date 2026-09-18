import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-hndocs-'));
const root = path.join(tmp, 'clients');
fs.mkdirSync(root, { recursive: true });
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.STORAGE_BACKEND = 'local';
process.env.LOCAL_CLIENT_ROOT = root;
// Chatwork を「設定済み」にして送り先を作る。AI は使わない（下書きはテンプレートで出る）
process.env.CHATWORK_API_TOKEN = 'test-token';

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { prepareHearingNotice } = await import('../services/hearingNotice.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

async function putFile(rel: string, when: string) {
  const abs = path.join(root, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, 'x');
  await fsp.utimes(abs, new Date(when), new Date(when));
}

describe('期日連絡の添付候補', () => {
  it('期日の前後に更新した書面を「おすすめ」にし、古いものは候補どまりにする', async () => {
    const hearing = new Date(Date.now() - 3 * 86400_000); // 3 日前の期日
    const client = db().insert(schema.clients).values({ name: '山田 花子', chatworkRoomId: 100, onedriveFolderPath: '山田 花子' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '山田 損害賠償' }).returning().get();
    const note = db()
      .insert(schema.caseNotes)
      .values({ caseId: kase.id, clientId: client.id, kind: 'court', occurredAt: hearing.toISOString(), rawText: '第2回弁論。和解勧試。', gist: '第2回弁論。和解勧試。', decisions: [], nextActions: [], theirSaid: [], ourSaid: [], attachments: [] })
      .returning()
      .get();

    // 期日当日に出した書面／期日の 1 か月前の書面／期日の 2 か月前（候補からも外れる）
    await putFile('山田 花子/提出書面/準備書面（2）.pdf', hearing.toISOString());
    await putFile('山田 花子/提出書面/訴状.pdf', new Date(hearing.getTime() - 30 * 86400_000).toISOString());
    await putFile('山田 花子/提出書面/受任通知.pdf', new Date(hearing.getTime() - 70 * 86400_000).toISOString());

    const r = await prepareHearingNotice(note.id);
    const names = r.docs.map((d) => `${d.name}:${d.suggested ? 'おすすめ' : '候補'}`);
    expect(names).toContain('準備書面（2）.pdf:おすすめ');
    expect(names).toContain('訴状.pdf:候補');
    // 60 日より古いものは候補にも出さない
    expect(names.join(',')).not.toContain('受任通知.pdf');
    // 画面で使う依頼者 ID も返す
    expect(r.clientId).toBe(client.id);
  });

  it('フォルダにファイルが無くても、下書きは作れる', async () => {
    const client = db().insert(schema.clients).values({ name: '佐藤 太郎', chatworkRoomId: 200, onedriveFolderPath: '佐藤 太郎' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '佐藤 交通事故' }).returning().get();
    const note = db()
      .insert(schema.caseNotes)
      .values({ caseId: kase.id, clientId: client.id, kind: 'court', occurredAt: new Date().toISOString(), rawText: '第1回弁論', gist: '第1回弁論', decisions: [], nextActions: [], theirSaid: [], ourSaid: [], attachments: [] })
      .returning()
      .get();
    const r = await prepareHearingNotice(note.id);
    expect(r.docs).toEqual([]);
    expect(r.text).toContain('佐藤');
  });
});
