import type { EventKind } from './types.js';

export const HEARING_KEYWORDS = ['期日', '裁判', '弁論', '口頭弁論', '尋問', '判決', '調停', '審判', '和解期日', '準備手続', '進行協議', '公判', '審尋', '審問', '証拠調', '検認', '集会', '控訴審', '債権者集会', '免責審尋'];
export const MEETING_KEYWORDS = ['打合せ', '打ち合わせ', '打合わせ', '打合', '面談', '来所', '接見', 'ご自宅'];
export const CONSULT_KEYWORDS = ['相談'];
export const HOLD_SUFFIX = '仮';

/** 全角英数字を半角にし、空白を統一する */
export function normalizeTitle(title: string): string {
  return title
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]+/g, ' ')
    .trim();
}

/**
 * カレンダーのタイトルから種別を推定する。
 * 実際の運用例: 「山田 打合せ」「山田 WEB裁判」「山田 電話打合せ」「山田 新規相談」「山田 調停」「山田 第1回 集会期日」
 * 「期日」「裁判」などが含まれれば打合せより優先して期日扱い（「打合せ期日」は期日）。
 */
export function classifyEventTitle(title: string): EventKind {
  const t = normalizeTitle(title);
  if (/(^| )仮$/.test(t) || / 仮 /.test(t)) return 'hold';
  if (HEARING_KEYWORDS.some((k) => t.includes(k))) return 'hearing';
  if (CONSULT_KEYWORDS.some((k) => t.includes(k))) return 'consult';
  if (MEETING_KEYWORDS.some((k) => t.includes(k))) return 'meeting';
  return 'other';
}

/** 事務所の予定など、依頼者に紐付けない定型タイトル */
export const NON_CLIENT_TITLES = ['事務所会議', '事務所相談担当日', '無料電話相談', '民事当番', 'ひまわりダイヤル', '相続遺言お悩みダイヤル', '移動'];
export function isNonClientTitle(title: string): boolean {
  const t = normalizeTitle(title);
  return NON_CLIENT_TITLES.some((k) => t === k || t.startsWith(k));
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
  const t = normalizeTitle(title).replace(/ /g, '');
  return names.some((n) => {
    const nn = n.replace(/[\s　]+/g, '');
    return nn.length > 0 && t.includes(nn);
  });
}
