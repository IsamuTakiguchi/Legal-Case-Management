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
/** 法人格。名前の前後どちらに付いていても外す（「株式会社リスタート」「リスタート株式会社」） */
const LEGAL_FORMS = [
  '特定非営利活動法人', '一般社団法人', '一般財団法人', '公益社団法人', '公益財団法人', '社会福祉法人', '医療法人社団', '医療法人財団',
  '医療法人', '学校法人', '宗教法人', '税理士法人', '弁護士法人', '司法書士法人', '行政書士法人', '社会保険労務士法人', '監査法人',
  '合同会社', '合資会社', '合名会社', '株式会社', '有限会社', 'NPO法人', '（株）', '(株)', '㈱', '（有）', '(有)', '㈲',
];
/** 法人格が無くても会社・団体と分かる語。これが含まれていれば名前を切らない */
const ORG_WORDS = [
  'コンサルティング', 'ホールディングス', 'グループ', 'サービス', 'システム', 'エンジニアリング', 'ソリューション', 'パートナーズ',
  '法律事務所', '会計事務所', '事務所', '商事', '商会', '商店', '工業', '産業', '建設', '工務店', '製作所', '不動産', '銀行',
  '信用金庫', '信用組合', '保険', '証券', 'クリニック', '病院', '医院', '歯科', '薬局', '協会', '組合', '連合会', 'センター',
  '学園', '学校', '大学', '幼稚園', '保育園', '法人', '会社', '企画', '書店', '運輸', '物流', '通信', '電機', '電気', '食品',
];
/** 3 文字・4 文字の姓（先頭 2 文字で切ると「佐々」「長谷」になってしまうもの） */
const LONG_SURNAMES = [
  '勅使河原', '小比類巻', '長曽我部',
  '佐々木', '長谷川', '小笠原', '大久保', '五十嵐', '宇都宮', '久保田', '小野寺', '二階堂', '長谷部', '東海林', '西園寺', '綾小路',
  '小田切', '佐久間', '早乙女', '大和田', '小田原', '大河内', '小山田', '三田村', '中曽根', '阿久津', '宇田川', '小久保', '波多野',
  '小野田', '小松原', '大田原', '大谷内', '小田島', '八重樫', '海老原', '海老名', '猪野毛', '小林原', '安孫子', '我孫子', '真田原',
];

/**
 * 予定の件名やメールの宛名に使う「姓」。
 * 「山田 太郎」→ 山田、「瀧口勇」→ 瀧口、「佐々木健」→ 佐々木。
 * 会社・団体（「リスタートコンサルティング」「株式会社◯◯」）は姓ではないので、法人格だけ外して名前は切らない。
 * カタカナ・英字だけの名前も、どこで切れるか分からないので切らない。
 */
export function familyName(fullName: string): string {
  let name = fullName.trim();
  if (!name) return '';
  // 法人格を外す。外れたら会社なので、残りをそのまま使う
  let isOrg = false;
  for (const lf of LEGAL_FORMS) {
    if (name.startsWith(lf) || name.endsWith(lf)) {
      name = name.replace(lf, '').trim();
      isOrg = true;
    }
  }
  if (!name) return fullName.trim();
  if (isOrg) return name.split(/[\s　]+/).filter(Boolean).join(' ');
  // 会社・団体と分かる語が入っていれば切らない
  if (ORG_WORDS.some((w) => name.includes(w))) return name;
  // 空白で区切られていれば先頭が姓
  const parts = name.split(/[\s　]+/).filter(Boolean);
  if (parts.length >= 2) return parts[0];
  // 漢字を含まない（カタカナ・ひらがな・英字）名前は、どこで切れるか分からないので切らない
  if (!/[\u4e00-\u9fff\u3400-\u4dbf々]/.test(name)) return name;
  // 先頭が漢字でなければ（ひらがな姓など）切らない
  if (!/^[\u4e00-\u9fff\u3400-\u4dbf々]/.test(name)) return name;
  // 3〜4 文字の姓が先頭にあればそれ
  for (const sn of LONG_SURNAMES) if (name.startsWith(sn) && name.length >= sn.length) return sn;
  // 漢字が続く範囲だけを見る（「山田たろう」→ 山田）
  const kanji = name.match(/^[\u4e00-\u9fff\u3400-\u4dbf々]+/)![0];
  if (kanji.length <= 2) return kanji;
  // 6 文字以上の漢字の並びは人名らしくない（団体名など）ので切らない
  if (kanji.length >= 6) return name;
  return kanji.slice(0, 2);
}

/** タイトルに依頼者名（または別名）が含まれるかどうか */
export function titleMentionsClient(title: string, names: string[]): boolean {
  const t = normalizeTitle(title).replace(/ /g, '');
  return names.some((n) => {
    const nn = n.replace(/[\s　]+/g, '');
    return nn.length > 0 && t.includes(nn);
  });
}
