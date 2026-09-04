import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { env, isConfigured } from '../config.js';
import { logger } from '../logger.js';

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

/** テキスト生成。長文出力に備えて常にストリーミングで受け取る */
export async function generateText(opts: {
  system: string;
  user: string | Anthropic.MessageParam[];
  maxTokens?: number;
  effort?: Effort;
  onDelta?: (text: string) => void;
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
}): Promise<z.infer<T>> {
  const res = await anthropic().messages.parse({
    model: model(),
    max_tokens: opts.maxTokens ?? 8000,
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
    thinking: { type: 'adaptive' },
    output_config: { effort: opts.effort ?? 'medium', format: zodOutputFormat(opts.schema) },
  });
  if (res.stop_reason === 'refusal') throw new Error('生成が拒否されました');
  if (!res.parsed_output) throw new Error('構造化出力の解析に失敗しました');
  return res.parsed_output as z.infer<T>;
}
