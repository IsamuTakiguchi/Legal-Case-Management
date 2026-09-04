import type { EventKind } from './types.js';

export const HEARING_KEYWORDS = ['期日', '弁論', '口頭弁論', '尋問', '判決', '調停', '審判', '和解', '準備手続', '進行協議', '公判', '審尋', '審問', '証拠調'];
export const MEETING_KEYWORDS = ['打合せ', '打ち合わせ', '打合わせ', '面談', '来所', '接見'];
export const CONSULT_KEYWORDS = ['相談', 'WEB相談', 'ＷＥＢ相談'];
export const HOLD_SUFFIX = '仮';

/** カレンダーのタイトルから種別を推定する */
export function classifyEventTitle(title: string): EventKind {
  const t = title.trim();
  if (/(^|\s)仮$/.test(t) || /\s仮\s/.test(t)) return 'hold';
  if (HEARING_KEYWORDS.some((k) => t.includes(k))) return 'hearing';
  if (CONSULT_KEYWORDS.some((k) => t.includes(k))) return 'consult';
  if (MEETING_KEYWORDS.some((k) => t.includes(k))) return 'meeting';
  return 'other';
}

/** 借金問題かどうか（consultation-scheduler の判定基準） */
export const DEBT_KEYWORDS = ['借金', '債務整理', '自己破産', '過払い', '返済', '任意整理', '個人再生'];
export function isDebtIssue(text: string): boolean {
  return DEBT_KEYWORDS.some((k) => text.includes(k));
}

/** 姓（スペース前）を取り出す。「山田 太郎」「山田太郎」→「山田」（後者は先頭2文字を使う） */
export function familyName(fullName: string): string {
  const trimmed = fullName.trim();
  const parts = trimmed.split(/[\s　]+/);
  if (parts.length >= 2) return parts[0];
  if (trimmed.length >= 3) return trimmed.slice(0, 2);
  return trimmed;
}

/** タイトルに依頼者名（または別名）が含まれるかどうか */
export function titleMentionsClient(title: string, names: string[]): boolean {
  const t = title.replace(/[\s　]+/g, '');
  return names.some((n) => {
    const nn = n.replace(/[\s　]+/g, '');
    return nn.length > 0 && t.includes(nn);
  });
}
