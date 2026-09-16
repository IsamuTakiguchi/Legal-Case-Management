/**
 * Chatwork の「リアクション」ボタンは公開 API（v2）に無いため、アプリからは付けられない。
 * 代わりに、そのメッセージへの返信として短い一言（Chatwork の絵文字つき）をワンタップで送る。
 * 既定の 6 つは、Chatwork のリアクションと同じ顔ぶれ（了解・おじぎ・いいね・拍手・にっこり・びっくり）にしてある。
 */

export interface ChatworkReaction {
  /** ボタンに出す短い名前 */
  label: string;
  /** 実際に送る本文（Chatwork の絵文字コードを含む） */
  text: string;
  /** ボタンに出す絵文字（本文の先頭の絵文字コードから決まる） */
  emoji: string;
}

/** Chatwork の絵文字コード → 画面のボタンに出す絵文字 */
const EMOJI: Record<string, string> = {
  '(roger)': '✅',
  '(bow)': '🙏',
  '(y)': '👍',
  '(clap)': '👏',
  '(nod)': '🙆',
  '(think)': '🤔',
  '(sweat)': '😅',
  '(please)': '🙏',
  '(cracker)': '🎉',
  '(F)': '🌸',
  '(h)': '❤️',
  '(*)': '⭐',
  ':)': '🙂',
  ':o': '😮',
  ':(': '🙁',
  ';)': '😉',
};

/** 本文の先頭にある Chatwork の絵文字コードを読む */
function leadingEmoji(text: string): string {
  const t = text.trimStart();
  for (const code of Object.keys(EMOJI)) {
    if (t.startsWith(code)) return EMOJI[code]!;
  }
  return '💬';
}

/** 設定が空のときに使う既定のリアクション（1 行 1 つ、`ラベル|送る本文`） */
export const DEFAULT_CHATWORK_REACTIONS = [
  '了解|(roger) 了解しました',
  'ありがとう|(bow) ありがとうございます',
  'いいね|(y)',
  '拍手|(clap)',
  'にっこり|:)',
  'びっくり|:o',
].join('\n');

/** 設定の文字列を、ボタンに出せる形に読み解く。壊れた行は飛ばす */
export function parseChatworkReactions(raw: string | null | undefined): ChatworkReaction[] {
  const src = (raw ?? '').trim() ? raw! : DEFAULT_CHATWORK_REACTIONS;
  const out: ChatworkReaction[] = [];
  for (const line of src.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const at = s.indexOf('|');
    const label = at >= 0 ? s.slice(0, at).trim() : s;
    const text = (at >= 0 ? s.slice(at + 1) : s).trim();
    if (!text) continue;
    // 同じ本文が並んでも押し間違えるだけなので 1 つにまとめる
    if (out.some((r) => r.text === text)) continue;
    out.push({ label: label || text, text, emoji: leadingEmoji(text) });
    if (out.length >= 12) break;
  }
  return out;
}
