import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-notesug-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;

const prompts: { system: string; user: string }[] = [];
let reply: Record<string, unknown> = {};
vi.mock('../integrations/anthropic.js', async (orig) => ({
  ...(await orig<typeof import('../integrations/anthropic.js')>()),
  generateStructured: vi.fn(async (opts: { system: string; user: string }) => {
    prompts.push({ system: opts.system, user: opts.user });
    return reply;
  }),
}));

const { openTestDatabase, closeDatabase, db, schema } = await import('../db/index.js');
const { createApp } = await import('../index.js');
const { setPassword } = await import('../auth/index.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());

async function api() {
  const app = createApp();
  await setPassword('test-pass-1234');
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-pass-1234' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  return (p: string, body: unknown) => app.request(`/api${p}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
}

describe('記録の AI 整理: 要約 1 つと、タスク・日程・送信の案', () => {
  it('要約は 1 つにまとめ（発言者で分けない）、日程・依頼者・担当事務への案を返す。担当事務への案は 1 行目が依頼者の氏名', async () => {
    const post = await api();
    const client = db().insert(schema.clients).values({ name: '吉堂 壱星' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '自己破産', caseType: 'general_civil' }).returning().get();
    reply = {
      gist: '本人から書類一式が届いたとのこと。法テラスへの審査回付を進めると伝えた。',
      phone: null,
      decisions: ['法テラスへ審査回付する'],
      nextActions: [{ title: '法テラスの審査結果を確認', due: null, replyBy: null, owner: 'self' }],
      waitingFor: 'staff',
      counterpart: '吉堂 壱星',
      schedule: { suggested: true, note: '法テラスの面談日を本人と調整する' },
      clientMessage: { suggested: true, text: '吉堂様\n書類を受け取りました。法テラスへの申込みを進めます。' },
      staffMessage: { suggested: true, text: '吉堂さん（自己破産）について、法テラスへ審査回付をお願いします。' },
    };
    const r = await post(`/cases/${kase.id}/notes/structure`, { rawText: '本人から書類届いた。法テラスへ回付', kind: 'phone' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.gist).toContain('法テラスへの審査回付を進めると伝えた');
    expect(j.theirSaid).toEqual([]);
    expect(j.ourSaid).toEqual([]);
    expect(j.nextActions).toHaveLength(1);
    expect(j.suggestions.schedule).toEqual({ suggested: true, note: '法テラスの面談日を本人と調整する' });
    expect(j.suggestions.clientMessage.suggested).toBe(true);
    expect(j.suggestions.staffMessage.text).toBe('吉堂壱星\n法テラスへ審査回付をお願いします。');
    // AI には、発言者で分けず 1 つにまとめること・担当事務への書き方を伝える
    expect(prompts.at(-1)!.system).toContain('発言者ごとに分けず 1 つの文章');
    expect(prompts.at(-1)!.system).toContain('「吉堂壱星」');
  });

  it('必要のない案は suggested=false で空', async () => {
    const post = await api();
    const client = db().insert(schema.clients).values({ name: '山田 太郎' }).returning().get();
    const kase = db().insert(schema.cases).values({ clientId: client.id, title: '貸金', caseType: 'general_civil' }).returning().get();
    reply = {
      gist: '進捗の確認の電話。特に変わりなし。',
      phone: null,
      decisions: [],
      nextActions: [],
      waitingFor: 'none',
      counterpart: null,
      schedule: { suggested: false, note: '' },
      clientMessage: { suggested: true, text: '' },
      staffMessage: { suggested: false, text: '' },
    };
    const j = await (await post(`/cases/${kase.id}/notes/structure`, { rawText: '進捗確認。変わりなし', kind: 'phone' })).json();
    expect(j.suggestions).toEqual({ schedule: { suggested: false, note: '' }, clientMessage: { suggested: false, text: '' }, staffMessage: { suggested: false, text: '' } });
  });
});
