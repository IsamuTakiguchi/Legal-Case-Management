import { Hono } from 'hono';
import { recordTurn, recordApplied, listThreads, getThread, deleteThread, newThreadId } from '../services/secretaryHistory.js';
import { z } from 'zod';
import { searchAll, SEARCH_KINDS, SEARCH_KIND_LABEL } from '../services/search.js';
import { askAcrossData } from '../services/askSearch.js';
import { planSecretary, applySecretaryActions, secretaryActionSchema } from '../services/secretary.js';

export const searchRoutes = new Hono();

/** 文字どおりの横断検索（AI を使わないので速い・無料） */
searchRoutes.get('/search', (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const kinds = (c.req.query('kinds') ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k): k is (typeof SEARCH_KINDS)[number] => (SEARCH_KINDS as readonly string[]).includes(k));
  if (!q) return c.json({ hits: [], kindLabels: SEARCH_KIND_LABEL });
  return c.json({ hits: searchAll(q, { kinds, limit: 40 }), kindLabels: SEARCH_KIND_LABEL });
});

/** 日本語の質問に、事務所のデータ全体から根拠付きで答える */
searchRoutes.post('/search/ask', async (c) => {
  const body = z
    .object({
      question: z.string().min(1),
      kinds: z.array(z.enum(SEARCH_KINDS)).optional(),
    })
    .parse(await c.req.json());
  return c.json(await askAcrossData(body.question, { kinds: body.kinds }));
});

/** AI 秘書: 頼みごとから「やることの案」を作る（ここでは登録しない） */
searchRoutes.post('/secretary/plan', async (c) => {
  const body = z
    .object({
      text: z.string().min(1),
      history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() })).max(20).optional(),
      /** 秘書を開いた画面（依頼者・事件・会話）。「この件」「この人」はこれを指す */
      context: z.object({ clientId: z.number().int().optional(), caseId: z.number().int().optional(), conversationId: z.number().int().optional() }).optional(),
      /** ひと続きのやり取りの ID（無ければ新しく始める） */
      threadId: z.string().max(100).optional(),
    })
    .parse(await c.req.json());
  const plan = await planSecretary(body.text, body.history ?? [], body.context);
  // やり取りを残す（あとで履歴から見返せるように）
  const threadId = body.threadId || newThreadId();
  const turn = recordTurn({ threadId, request: body.text, reply: plan.reply, context: body.context ?? null, actions: plan.actions, previews: plan.previews, questions: plan.questions });
  return c.json({ ...plan, threadId, turnId: turn.id });
});

/** AI 秘書: これまでのやり取り（新しい順） */
searchRoutes.get('/secretary/threads', (c) => c.json(listThreads({ q: c.req.query('q') || undefined, limit: Number(c.req.query('limit') ?? 50) || 50 })));

/** AI 秘書: ひと続きのやり取り */
searchRoutes.get('/secretary/threads/:id', (c) => c.json(getThread(c.req.param('id'))));

searchRoutes.delete('/secretary/threads/:id', (c) => c.json(deleteThread(c.req.param('id'))));

/** AI 秘書: 確認した案を実際に登録する */
searchRoutes.post('/secretary/apply', async (c) => {
  const body = z.object({ actions: z.array(secretaryActionSchema).min(1).max(12), turnId: z.number().int().optional() }).parse(await c.req.json());
  const r = await applySecretaryActions(body.actions);
  if (body.turnId) recordApplied(body.turnId, r.applied);
  return c.json(r);
});
