import { Hono } from 'hono';
import { z } from 'zod';
import { searchAll, SEARCH_KINDS, SEARCH_KIND_LABEL } from '../services/search.js';
import { askAcrossData } from '../services/askSearch.js';

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
