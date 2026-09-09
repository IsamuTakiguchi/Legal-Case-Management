import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { env, isConfigured } from '../config.js';
import { logger } from '../logger.js';
import { recordUsage } from '../services/apiCost.js';

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!isConfigured('anthropic')) throw new Error('ANTHROPIC_API_KEY が設定されていません');
  if (!client) client = new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });
  return client;
}

export function model(): string {
  return env().ANTHROPIC_MODEL;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 応答の usage から利用記録を残す（設定画面の「API 利用料」に出す） */
function track(purpose: string | undefined, res: { model: string; usage: Anthropic.Usage }) {
  recordUsage({
    model: res.model || model(),
    purpose: purpose ?? 'その他',
    tokens: {
      input: res.usage.input_tokens ?? 0,
      output: res.usage.output_tokens ?? 0,
      cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
    },
  });
}

/** テキスト生成。長文出力に備えて常にストリーミングで受け取る */
export async function generateText(opts: {
  system: string;
  user: string | Anthropic.MessageParam[];
  maxTokens?: number;
  effort?: Effort;
  onDelta?: (text: string) => void;
  /** 利用料の内訳に出す用途名 */
  purpose?: string;
}): Promise<string> {
  const messages: Anthropic.MessageParam[] = typeof opts.user === 'string' ? [{ role: 'user', content: opts.user }] : opts.user;
  const stream = anthropic().messages.stream({
    model: model(),
    max_tokens: opts.maxTokens ?? 16000,
    system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
    messages,
    thinking: { type: 'adaptive' },
    output_config: { effort: opts.effort ?? 'medium' },
  });
  if (opts.onDelta) stream.on('text', (t) => opts.onDelta!(t));
  const final = await stream.finalMessage();
  track(opts.purpose, final);
  if (final.stop_reason === 'refusal') {
    logger.warn({ stop_details: final.stop_details }, 'Claude が生成を拒否しました');
    throw new Error('生成が拒否されました。指示内容を見直してください。');
  }
  return final.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** 構造化出力（zod スキーマで型付け） */
export async function generateStructured<T extends z.ZodType>(opts: {
  system: string;
  user: string;
  schema: T;
  maxTokens?: number;
  effort?: Effort;
  purpose?: string;
}): Promise<z.infer<T>> {
  const res = await anthropic().messages.parse({
    model: model(),
    max_tokens: opts.maxTokens ?? 8000,
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
    thinking: { type: 'adaptive' },
    output_config: { effort: opts.effort ?? 'medium', format: zodOutputFormat(opts.schema) },
  });
  track(opts.purpose, res);
  if (res.stop_reason === 'refusal') throw new Error('生成が拒否されました');
  if (!res.parsed_output) throw new Error('構造化出力の解析に失敗しました');
  return res.parsed_output as z.infer<T>;
}

/** 構造化出力（画像や PDF などのコンテンツブロックを渡せる版） */
export async function generateStructuredFromContent<T extends z.ZodType>(opts: {
  system: string;
  content: Anthropic.ContentBlockParam[];
  schema: T;
  maxTokens?: number;
  effort?: Effort;
  purpose?: string;
}): Promise<z.infer<T>> {
  const res = await anthropic().messages.parse({
    model: model(),
    max_tokens: opts.maxTokens ?? 4000,
    system: opts.system,
    messages: [{ role: 'user', content: opts.content }],
    thinking: { type: 'adaptive' },
    output_config: { effort: opts.effort ?? 'low', format: zodOutputFormat(opts.schema) },
  });
  track(opts.purpose, res);
  if (res.stop_reason === 'refusal') throw new Error('生成が拒否されました');
  if (!res.parsed_output) throw new Error('構造化出力の解析に失敗しました');
  return res.parsed_output as z.infer<T>;
}

export function resetAnthropicClient() {
  client = null;
}
