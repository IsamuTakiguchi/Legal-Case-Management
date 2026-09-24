/**
 * 電話番号の扱い。
 *
 * 画面には入力されたままの形（「090-1234-5678（携帯）」など）を残し、
 * 発信リンク・同じ番号かどうかの判定・検索には数字だけを使う。
 */

/**
 * 番号の部分だけ半角にする（「０９０－１２３４」→「090-1234」）。
 * 「（携帯）」「（オーナー）」のような添え書きはそのまま残す（長音の「ー」は数字に挟まれたときだけハイフンにする）
 */
function toHalfWidth(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－―‐]/g, '-')
    .replace(/(?<=\d)ー(?=\d)/g, '-')
    .replace(/＋(?=\d)/g, '+')
    .replace(/　/g, ' ');
}

/** 発信・照合用に、数字（と先頭の +）だけにする */
export function phoneDigits(s: string): string {
  const h = toHalfWidth(s).trim();
  const plus = h.startsWith('+') ? '+' : '';
  return plus + h.replace(/\D/g, '');
}

/** 電話番号として意味のある長さか（市外局番なしの短い番号や、メモの取り違えを弾く） */
export function isPhoneLike(s: string): boolean {
  const d = phoneDigits(s).replace(/^\+/, '');
  return d.length >= 10 && d.length <= 15;
}

/** tel: リンク（押すとスマホで発信できる） */
export function telHref(s: string): string {
  return `tel:${phoneDigits(s)}`;
}

/**
 * 入力欄の文字列を電話番号の並びにする。
 * 番号の中にハイフンや空白が入るので、区切りはカンマ・読点・改行・スラッシュだけ。
 */
export function splitPhones(input: string): string[] {
  return input
    .split(/[,、，\n/／]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 前後の空白を落とし、全角を半角にし、同じ番号（数字が同じもの）を 1 つにまとめる */
export function normalizePhones(phones: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of phones) {
    const v = toHalfWidth(p).trim().replace(/\s+/g, ' ');
    const d = phoneDigits(v);
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(v);
  }
  return out;
}

/** 2 つの電話番号が同じ番号か（書き方の違い「090-1234-5678」「09012345678」は同じとみる） */
export function samePhone(a: string, b: string): boolean {
  const x = phoneDigits(a);
  return !!x && x === phoneDigits(b);
}
