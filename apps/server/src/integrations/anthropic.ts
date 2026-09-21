import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { AI_MODEL_IDS } from '@lcm/shared';
import { env, isConfigured } from '../config.js';
import { logger } from '../logger.js';
import { recordUsage } from '../services/apiCost.js';
import { getSetting } from '../services/settings.js';

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!isConfigured('anthropic')) throw new Error('ANTHROPIC_API_KEY が設定されていません');
  if (!client) client = new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });
  return client;
}

/**
 * 処理の重さ。light は判定・仕分けなどの軽い処理（安いモデルに回せる）、
 * main は下書き・サマリーなど質が要る処理。
 */
export type ModelTier = 'main' | 'light';

/** 設定画面で選んだモデル。未設定・未知の値なら環境変数の既定に戻す */
export function model(tier: ModelTier = 'main'): string {
  const fallback = env().ANTHROPIC_MODEL;
  let main = '';
  let light = '';
  try {
    main = getSetting('ai_model').trim();
    light = getSetting('ai_model_light').trim();
  } catch {
    // DB 未初期化（起動直後やテスト）なら環境変数の既定を使う
    return fallback;
  }
  const pick = tier === 'light' ? light || main : main;
  return pick && AI_MODEL_IDS.includes(pick) ? pick : fallback;
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
  /** 軽い処理は light（設定で安いモデルに回せる） */
  tier?: ModelTier;
}): Promise<string> {
  const messages: Anthropic.MessageParam[] = typeof opts.user === 'string' ? [{ role: 'user', content: opts.user }] : opts.user;
  const stream = anthropic().messages.stream({
    model: model(opts.tier),
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
  tier?: ModelTier;
}): Promise<z.infer<T>> {
  const res = await anthropic().messages.parse({
    model: model(opts.tier),
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
  tier?: ModelTier;
}): Promise<z.infer<T>> {
  const res = await anthropic().messages.parse({
    model: model(opts.tier),
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

/**
 * 道具（ツール）。読み取りだけのものは run を持ち、最後にまとめを返すものは run を持たない。
 * run の無い道具が呼ばれた時点で往復を終え、その中身を呼び出し元に返す。
 */
export interface AgentTool<T extends z.ZodType = z.ZodType> {
  name: string;
  /** Claude に見せる説明。いつ使うかを日本語で書く */
  description: string;
  schema: T;
  /** 読み取りの処理。省略すると「これが最後」の合図になる */
  run?: (input: z.infer<T>) => Promise<unknown> | unknown;
}

/** 道具を 1 つ作る（run の引数に schema の型が付くようにするための包み） */
export function agentTool<T extends z.ZodType>(t: AgentTool<T>): AgentTool {
  return t as AgentTool;
}

export interface ToolLoopResult {
  /** 最後に返ってきた文章（道具で終わったときは空のこともある） */
  text: string;
  /** run の無い道具が呼ばれたときの中身 */
  final: { name: string; input: unknown } | null;
  /** 使った道具の名前（呼ばれた順） */
  used: string[];
  /** やり取りの記録（続きを頼むときにそのまま渡せる） */
  messages: Anthropic.MessageParam[];
}

/**
 * 道具を渡して、Claude に何回か往復させる。
 *
 * 途中で必要な情報（依頼者の ID など）を自分で調べてもらい、最後にまとめを受け取る。
 * 道具はすべて読み取りにして、書き込みは呼び出し元が確認のうえで行う。
 */
export async function runToolLoop(opts: {
  system: string;
  messages: Anthropic.MessageParam[];
  tools: AgentTool[];
  /** 往復の上限。既定 6 */
  maxRounds?: number;
  maxTokens?: number;
  effort?: Effort;
  purpose?: string;
  tier?: ModelTier;
}): Promise<ToolLoopResult> {
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const defs: Anthropic.ToolUnion[] = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: z.toJSONSchema(t.schema, { io: 'input' }) as Anthropic.Tool.InputSchema,
  }));
  const messages = [...opts.messages];
  const used: string[] = [];
  let text = '';

  for (let round = 0; round < (opts.maxRounds ?? 6); round++) {
    const stream = anthropic().messages.stream({
      model: model(opts.tier),
      max_tokens: opts.maxTokens ?? 8000,
      system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
      messages,
      tools: defs,
      thinking: { type: 'adaptive' },
      output_config: { effort: opts.effort ?? 'medium' },
    });
    const res = await stream.finalMessage();
    track(opts.purpose, res);
    if (res.stop_reason === 'refusal') {
      logger.warn({ stop_details: res.stop_details }, 'Claude が生成を拒否しました');
      throw new Error('生成が拒否されました。指示内容を見直してください。');
    }
    text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    // 考えた跡も含めて、返ってきたものをそのまま次の往復に渡す
    messages.push({ role: 'assistant', content: res.content });
    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!calls.length) return { text, final: null, used, messages };

    // 同じ往復で複数の道具が呼ばれることがある。結果は 1 通のメッセージにまとめて返す
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      used.push(call.name);
      const tool = byName.get(call.name);
      if (!tool) {
        results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: `${call.name} という道具はありません` });
        continue;
      }
      const parsed = tool.schema.safeParse(call.input);
      if (!parsed.success) {
        results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: `入力が正しくありません: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(' / ')}` });
        continue;
      }
      if (!tool.run) return { text, final: { name: tool.name, input: parsed.data }, used, messages };
      try {
        const out = await tool.run(parsed.data);
        results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out ?? null) });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: (err as Error).message });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  logger.warn({ used }, '道具の往復が上限に達しました');
  return { text, final: null, used, messages };
}
