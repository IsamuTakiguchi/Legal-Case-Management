import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-toolloop-'));
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = 'test-key';

/** Claude の返事をこちらで決めるための差し替え */
type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown };
const replies: { stop_reason: string; content: Block[] }[] = [];
/** 実際に送られたリクエスト（道具の結果がどう渡ったかを見る） */
const sent: { messages: { role: string; content: unknown }[]; tools: { name: string }[] }[] = [];

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = {
      stream: (req: { messages: { role: string; content: unknown }[]; tools: { name: string }[] }) => {
        // ループは同じ配列を作り変えていくので、送った時点の形を控える
        sent.push({ messages: [...req.messages], tools: req.tools });
        const next = replies.shift() ?? { stop_reason: 'end_turn', content: [{ type: 'text' as const, text: '（用意した返事がありません）' }] };
        return {
          finalMessage: async () => ({
            ...next,
            model: 'test-model',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        };
      },
    };
  }
  return { default: FakeAnthropic };
});

const { openTestDatabase, closeDatabase } = await import('../db/index.js');
const { runToolLoop, agentTool, resetAnthropicClient } = await import('../integrations/anthropic.js');

beforeAll(() => openTestDatabase());
afterAll(() => closeDatabase());
beforeEach(() => {
  replies.length = 0;
  sent.length = 0;
  resetAnthropicClient();
});

const lookups: string[] = [];
const tools = () => [
  agentTool({
    name: 'find_client',
    description: '依頼者を探す',
    schema: z.object({ name: z.string() }),
    run: (i) => {
      lookups.push(i.name);
      return [{ id: 7, name: `${i.name} 花子` }];
    },
  }),
  agentTool({
    name: 'boom',
    description: '必ず失敗する道具',
    schema: z.object({}),
    run: () => {
      throw new Error('つながりません');
    },
  }),
  agentTool({
    name: 'propose',
    description: '終わり',
    schema: z.object({ reply: z.string(), clientId: z.number().int() }),
  }),
];

const run = () => runToolLoop({ system: 'テスト', messages: [{ role: 'user', content: '山田さんの件' }], tools: tools(), maxRounds: 4 });

describe('道具を使う往復', () => {
  it('道具を呼び、その結果を渡して、最後の道具で終わる', async () => {
    replies.push(
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'find_client', input: { name: '山田' } }] },
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b', name: 'propose', input: { reply: '登録します', clientId: 7 } }] },
    );
    lookups.length = 0;
    const r = await run();

    expect(lookups).toEqual(['山田']);
    expect(r.used).toEqual(['find_client', 'propose']);
    expect(r.final).toEqual({ name: 'propose', input: { reply: '登録します', clientId: 7 } });
    // 2 回目の送信に、道具の結果が 1 通のメッセージとして入っている
    const second = sent[1]!.messages.at(-1) as { role: string; content: { type: string; tool_use_id: string; content: string }[] };
    expect(second.role).toBe('user');
    expect(second.content[0]!.type).toBe('tool_result');
    expect(second.content[0]!.tool_use_id).toBe('a');
    expect(second.content[0]!.content).toContain('山田 花子');
  });

  it('同じ往復で複数呼ばれても、結果は 1 通にまとめて返す', async () => {
    replies.push(
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'a', name: 'find_client', input: { name: '山田' } },
          { type: 'tool_use', id: 'b', name: 'find_client', input: { name: '佐藤' } },
        ],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '2 名いました' }] },
    );
    const r = await run();
    const results = (sent[1]!.messages.at(-1) as { content: unknown[] }).content;
    expect(results.length).toBe(2);
    expect(r.text).toBe('2 名いました');
    expect(r.final).toBeNull();
  });

  it('入力が schema に合わなければ、やり直せるように理由を返す', async () => {
    replies.push(
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'find_client', input: { なまえ: '山田' } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '直しました' }] },
    );
    await run();
    const res = (sent[1]!.messages.at(-1) as { content: { is_error?: boolean; content: string }[] }).content[0]!;
    expect(res.is_error).toBe(true);
    expect(res.content).toContain('name');
  });

  it('道具が失敗しても落ちず、失敗として伝える', async () => {
    replies.push(
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'boom', input: {} }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '別の手を考えます' }] },
    );
    const r = await run();
    const res = (sent[1]!.messages.at(-1) as { content: { is_error?: boolean; content: string }[] }).content[0]!;
    expect(res.is_error).toBe(true);
    expect(res.content).toContain('つながりません');
    expect(r.text).toBe('別の手を考えます');
  });

  it('知らない道具を呼ばれても落ちない', async () => {
    replies.push(
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'send_mail', input: {} }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'できませんでした' }] },
    );
    await run();
    const res = (sent[1]!.messages.at(-1) as { content: { is_error?: boolean; content: string }[] }).content[0]!;
    expect(res.is_error).toBe(true);
  });

  it('往復が上限に達したら、そこで打ち切る', async () => {
    for (let i = 0; i < 6; i++) replies.push({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `a${i}`, name: 'find_client', input: { name: '山田' } }] });
    const r = await runToolLoop({ system: 'テスト', messages: [{ role: 'user', content: 'x' }], tools: tools(), maxRounds: 2 });
    expect(sent.length).toBe(2);
    expect(r.final).toBeNull();
  });

  it('拒否されたときは分かる形で止める', async () => {
    replies.push({ stop_reason: 'refusal', content: [] });
    await expect(run()).rejects.toThrow('拒否');
  });
});
