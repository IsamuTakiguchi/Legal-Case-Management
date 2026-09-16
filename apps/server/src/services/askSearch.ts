import { z } from 'zod';
import { generateStructured } from '../integrations/anthropic.js';
import { searchAll, searchTerms, hitsAsContext, SEARCH_KINDS, SEARCH_KIND_LABEL, type SearchHit, type SearchKind } from './search.js';
import { getSetting } from './settings.js';
import { toJstParts } from '@lcm/shared';
import { logger } from '../logger.js';

/**
 * 事務所のデータ全体に日本語で質問して、根拠付きで答えてもらう。
 * 「山田さんの査定書の件、いまどうなってる？」のような聞き方で、記録・やり取り・
 * タスク・予定をまたいで探し、答えと、その根拠になった場所へのリンクを返す。
 */

const WD = ['日', '月', '火', '水', '木', '金', '土'];

const planSchema = z.object({
  terms: z.array(z.string()).describe('データを探すための語。人名・事件名・書面名・固有名詞を優先し、5 個まで。「どうなっている」のような一般語は入れない'),
  kinds: z.array(z.enum(SEARCH_KINDS)).describe('探す先を絞れるときだけ指定する。迷ったら空にしてすべてを探す'),
});

const answerSchema = z.object({
  answer: z.string().describe('質問への答え。日本語で簡潔に。分かった事実だけを書き、推測は書かない。根拠にした資料は文中で [1] [2] のように示す'),
  used: z.array(z.number().int()).describe('根拠にした資料の番号。答えに使ったものだけを、重要な順に'),
  confidence: z.enum(['high', 'medium', 'low']).describe('high=資料に明記されている / medium=資料から読み取れる / low=資料が足りず推測が混じる'),
  missing: z.string().describe('答えるのに足りなかった情報があれば 1 文で。無ければ空'),
});

export interface AskSearchResult {
  question: string;
  /** 実際に探すのに使った語 */
  terms: string[];
  answer: string;
  confidence: 'high' | 'medium' | 'low';
  missing: string;
  /** 根拠にした資料（答えの [1] [2] の順） */
  citations: SearchHit[];
  /** 見つかったもの全部（根拠に使わなかったものも「ほかの候補」として出す） */
  hits: SearchHit[];
}

export async function askAcrossData(question: string, opts: { kinds?: SearchKind[]; limit?: number } = {}): Promise<AskSearchResult> {
  const q = question.trim();
  if (!q) throw new Error('聞きたいことを入力してください');

  // 1. 質問から検索語を決める（「山田さんの件どうなってる？」→「山田」）
  const np = toJstParts(new Date());
  let plan: z.infer<typeof planSchema> = { terms: [], kinds: [] };
  try {
    plan = await generateStructured({
      purpose: '横断検索の検索語',
      tier: 'light',
      system: [
        '日本の法律事務所の業務システムに対する質問から、データを探すための検索語を決めます。',
        `今日は ${np.year}年${np.month}月${np.day}日(${WD[np.weekday]}) です。`,
        '人名・事件名・書面名・会社名などの固有名詞を最優先で拾います。',
        '「どうなっている」「教えて」「状況」のような、どの資料にも出てくる一般語は入れません。',
        `探し先を絞れるときだけ kinds を指定します（${SEARCH_KINDS.map((k) => `${k}=${SEARCH_KIND_LABEL[k]}`).join(' / ')}）。迷ったら空にします。`,
      ].join('\n'),
      user: q,
      schema: planSchema,
      effort: 'low',
      maxTokens: 500,
    });
  } catch (err) {
    // 検索語を作れなくても、質問そのものから語を切り出して探せるようにする
    logger.warn({ err }, '検索語の作成に失敗したので、質問をそのまま使います');
  }

  // 2. 探す（AI の語と、質問そのものから切り出した語の両方を使う）
  const terms = [...new Set([...plan.terms.map((t) => t.trim()).filter((t) => t.length >= 2), ...searchTerms(q)])].slice(0, 12);
  const kinds = opts.kinds?.length ? opts.kinds : plan.kinds;
  const hits = searchAll(terms.join(' '), { kinds, limit: opts.limit ?? 24 });
  if (hits.length === 0) {
    return { question: q, terms, answer: '', confidence: 'low', missing: '当てはまる記録・やり取りが見つかりませんでした', citations: [], hits: [] };
  }

  // 3. 見つかったものを読んで答える
  const r = await generateStructured({
    purpose: '横断検索の回答',
    system: [
      '日本の法律事務所の弁護士本人が、自分の事務所のデータに質問しています。',
      `今日は ${np.year}年${np.month}月${np.day}日(${WD[np.weekday]}) です。`,
      '渡された資料だけを根拠に、日本語で簡潔に答えます。資料に無いことは書かず、分からないことは分からないと書きます。',
      '答えの中で根拠を [1] [2] のように示し、used にその番号を入れます。',
      '日付は「9月15日(火)」のように読みやすく書きます。金額・期限・次のアクションは落とさずに書きます。',
      '資料は抜粋なので、断定できないときは confidence を下げ、何を見れば分かるかを missing に書きます。',
    ].join('\n'),
    user: [
      getSetting('lawyer_name') ? `質問者: ${getSetting('lawyer_name')}（弁護士本人）` : '',
      `質問: ${q}`,
      '--- 事務所のデータ（抜粋・番号付き） ---',
      hitsAsContext(hits),
    ]
      .filter(Boolean)
      .join('\n\n'),
    schema: answerSchema,
    effort: 'medium',
    maxTokens: 2000,
  });

  // 番号は 1 始まり。範囲外・重複は捨てる
  const citations: SearchHit[] = [];
  for (const i of r.used) {
    const h = hits[i - 1];
    if (h && !citations.includes(h)) citations.push(h);
  }
  logger.info({ question: q, terms, hits: hits.length, citations: citations.length, confidence: r.confidence }, '横断検索で回答しました');
  return { question: q, terms, answer: r.answer.trim(), confidence: r.confidence, missing: r.missing.trim(), citations, hits };
}
