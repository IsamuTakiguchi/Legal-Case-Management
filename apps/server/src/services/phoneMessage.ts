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
