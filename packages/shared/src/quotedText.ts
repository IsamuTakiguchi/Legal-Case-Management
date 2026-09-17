/**
 * メールの本文から「過去のやり取りの引用」を切り分ける。
 *
 * 返信メールは、書いた分の下に元のメールが丸ごと付いてくる。
 * 画面ではその部分を折りたたみたいので、「今回書かれた分」と「引用」に分ける。
 *
 * 引用の始まりは、次のいずれかで見分ける。
 * - Gmail の「2026年9月17日(水) 10:00 山田 花子 <yamada@example.com>:」「On … wrote:」
 * - Outlook の「-----Original Message-----」「-----元のメッセージ-----」、下線だけの区切り行
 * - Outlook の「差出人: / 送信日時: / 宛先: / 件名:」のまとまり
 * - 転送の見出し
 * - 末尾まで続く「>」始まりの行
 */

/** 引用の始まりを表す 1 行 */
const HEADER_LINE: RegExp[] = [
  /^-{2,}\s*(original message|元のメッセージ|オリジナル\s*メッセージ|原文)\s*-{2,}$/i,
  /^-{3,}\s*forwarded message\s*-{3,}$/i,
  /^(begin forwarded message[:：]|転送されたメッセージ[:：]|転送メッセージ[:：])$/i,
  // Outlook Web の区切り（下線だけの行）
  /^[_＿]{8,}$/,
  // Gmail 日本語: 日付＋相手（メールアドレス付き、または時刻付き）＋ コロン
  /^\d{4}年\d{1,2}月\d{1,2}日.*@.*[:：]$/,
  /^\d{4}年\d{1,2}月\d{1,2}日.*\d{1,2}[:：]\d{2}.*[:：]$/,
  // 「○○さんは書きました:」「○○ wrote:」
  /^.*(さんは|様は|が)?書きました[:：]$/,
  /^on\s.+\swrote[:：]$/i,
];

/** 「差出人:」などの見出しが並ぶ Outlook 形式の始まり */
const FROM_LINE = /^(差出人|送信者|送信元|from)\s*[:：]/i;
const SUBJECT_LINE = /^(件名|題名|subject)\s*[:：]/i;

const QUOTE_MARK = /^[>＞]/;

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** その行から引用が始まっているか */
function startsQuote(lines: string[], i: number): boolean {
  const line = lines[i]!.trim();
  if (!line) return false;
  if (HEADER_LINE.some((re) => re.test(line))) return true;
  // 「On …」「2026年9月17日(水) 10:00 山田 花子 <a@b.com>」で改行され、次の行が「wrote:」のことがある
  if (/^on\s/i.test(line) || /^\d{4}年\d{1,2}月\d{1,2}日/.test(line)) {
    const next = (lines[i + 1] ?? '').trim();
    if (/^(wrote|>?\s*wrote)[:：]$/i.test(next) || /^書きました[:：]$/.test(next)) return true;
  }
  // Outlook の見出しのまとまり（差出人: … 件名: …）
  if (FROM_LINE.test(line)) {
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      if (SUBJECT_LINE.test(lines[j]!.trim())) return true;
    }
  }
  return false;
}

/** 末尾まで続く「>」始まりの行のかたまりが始まる位置。無ければ -1 */
function trailingQuoteRun(lines: string[]): number {
  let start = -1;
  let sawQuote = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (isBlank(line)) continue;
    if (QUOTE_MARK.test(line.trimStart())) {
      sawQuote = true;
      start = i;
      continue;
    }
    break;
  }
  return sawQuote ? start : -1;
}

export interface SplitQuoted {
  /** 今回書かれた分 */
  main: string;
  /** 過去のやり取りの引用（無ければ空） */
  quoted: string;
}

/**
 * 本文を「今回書かれた分」と「引用」に分ける。
 * 引用が見つからないとき、引用しか無いとき、引用が短すぎるときは分けない。
 */
export function splitQuotedReply(body: string | null | undefined): SplitQuoted {
  const text = body ?? '';
  if (!text.trim()) return { main: text, quoted: '' };
  const lines = text.split('\n');
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startsQuote(lines, i)) {
      cut = i;
      break;
    }
  }
  const run = trailingQuoteRun(lines);
  if (run >= 0 && (cut < 0 || run < cut)) cut = run;
  if (cut <= 0) return { main: text, quoted: '' };
  const main = lines.slice(0, cut).join('\n').replace(/\s+$/, '');
  const quoted = lines.slice(cut).join('\n').trim();
  // 今回書かれた分が無い（引用だけ）なら、そのまま全部見せる
  if (!main.trim()) return { main: text, quoted: '' };
  // 引用が 1 行だけの短いものは、折りたたむほどでもない
  const quotedLines = quoted.split('\n').filter((l) => !isBlank(l));
  if (quotedLines.length < 2 && quoted.length < 20) return { main: text, quoted: '' };
  return { main, quoted };
}

/** 引用を落とした本文（一覧の抜粋などに使う） */
export function stripQuotedReply(body: string | null | undefined): string {
  return splitQuotedReply(body).main;
}
