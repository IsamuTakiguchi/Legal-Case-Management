/** 電話の伝言（「◯◯さんから電話、折り返しお願いします」など）の読み取り */

/** 電話の伝言らしいタスクか（「電話」「TEL」「伝言」「折り返し」や電話番号が書かれている） */
export function looksLikePhoneMessage(t: { title: string; note: string | null }): boolean {
  const text = `${t.title}\n${t.note ?? ''}`.normalize('NFKC');
  return /電話|TEL|Tel|tel:|伝言|折り?返し|着信|架電|コールバック/.test(text) || extractPhones(text).length > 0;
}

export const digitsOf = (s: string) => s.normalize('NFKC').replace(/\D/g, '');

/** 本文に書かれた電話番号（全角・ハイフン・括弧の違いを吸収。10〜11 桁の国内番号） */
export function extractPhones(text: string): string[] {
  const t = text.normalize('NFKC');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of t.matchAll(/(?<!\d)(?:\+81[-\s]?|0)\d{1,4}[-\s(（)）]*\d{1,4}[-\s)）]*\d{3,4}(?!\d)/g)) {
    let digits = digitsOf(m[0]);
    if (digits.startsWith('81')) digits = `0${digits.slice(2)}`;
    if (digits.length < 10 || digits.length > 11 || seen.has(digits)) continue;
    seen.add(digits);
    out.push(m[0].trim());
  }
  return out;
}

/** 敬称（さん・様など）のあとに続く「より・から」「お電話がありました」などの言い回し */
const AFTER_NAME = String.raw`(?:より|から)?\s*(?:お?電話|TEL|Tel|tel|着信|連絡|ご連絡)?\s*(?:が?あり(?:ました)?|です|でした)?\s*[。．.]?`;
const HONORIFIC = String.raw`(?:さん|様|さま|氏|先生)`;
/** 名前の行ではないもの（用件・お願い・日時など） */
const NOT_NAME = /の件|について|折り?返し|お願い|伺い|進捗|確認|^[→⇒]/;

/**
 * 伝言から、電話をくれた人（折り返し先）と、その人の番号を読み取る。
 * 例: 「東京海上日動　ひめのさん」「0742-35-8061」「奥戸正勝さんの件」→ { name: '東京海上日動　ひめの', phone: '0742-35-8061' }
 * 「◯◯さんの件」のような用件の行は名前にしない。名前の候補が複数あれば、番号の近くに書かれた人のうち先に出てくる人
 */
export function extractCaller(text: string): { name: string; phone: string | null } | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const phoneAt = (i: number) => extractPhones(lines[i] ?? '')[0] ?? null;
  const phoneLines = lines.map((_, i) => i).filter((i) => phoneAt(i));
  const whole = new RegExp(`^(.+?)${HONORIFIC}${AFTER_NAME}$`);
  // 1 行の中に書かれたもの（「東京海上日動のひめのさんから電話（0742-…）」）
  const inline = new RegExp(`(?:^|[\\s　。、,，])([^\\s　。、,，]+(?:[\\s　の][^\\s　。、,，]+)?)${HONORIFIC}(?:より|から)`);
  const found: { i: number; name: string }[] = [];
  lines.forEach((l, i) => {
    if (!l) return;
    const m = whole.exec(l);
    const name = (m && !NOT_NAME.test(l) ? m[1] : inline.exec(l)?.[1])?.trim().replace(/[:：]$/, '');
    if (!name || name.length > 40 || NOT_NAME.test(name) || extractPhones(name).length) return;
    found.push({ i, name });
  });
  if (!found.length) return null;
  // 先に書かれた人が用件の相手（「◯◯様からも」のような 2 人目は後ろ）。番号の近く（2 行以内）に書かれた人を優先
  const best = found.find((f) => phoneLines.some((p) => Math.abs(p - f.i) <= 2)) ?? found[0]!;
  // 番号は、その人の行か、すぐ後ろの行に書かれたもの（無ければいちばん近い番号）
  const near = [best.i, best.i + 1, best.i + 2, best.i - 1].find((i) => phoneAt(i)) ?? phoneLines.sort((a, b) => Math.abs(a - best.i) - Math.abs(b - best.i))[0];
  return { name: best.name, phone: near !== undefined ? phoneAt(near) : null };
}
