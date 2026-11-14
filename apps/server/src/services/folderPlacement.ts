/**
 * 区分フォルダ（「3.終了事件」など）の中を、さらに分けて管理しているときの置き場所を決める。
 * 区分を変えてフォルダを移すとき、区分フォルダの直下ではなく、中の分け方に合った場所へ入れる。
 *
 * 読み取る分け方（区分フォルダの中のフォルダ名から自動で判断する）:
 * - 年ごと: 「2025年」「2025」「2025年度」「令和7年」「R7」「R07年度」など → 移す日の年（「年度」は 4 月始まり）。無ければ同じ書き方で作る
 * - 事件の種類ごと: 「破産」「交通事故」など事件類型の名前 → その事件の類型のフォルダ
 * - 五十音ごと: 「あ行」「か行」…（「あ」「か」…も可） → 依頼者の読みの 1 文字目の行
 * 「種類 → 年」のように 2 段まで分けていても辿る。どれにも当たらなければ、そのフォルダの直下に置く
 */

export interface YearFolder {
  name: string;
  /** 西暦の年（年度なら、その年度が始まる年） */
  year: number;
  fiscal: boolean;
  /** 年の書き方（西暦 4 桁・令和・R 表記） */
  style: 'western' | 'reiwa' | 'r';
  /** 名前の中の年の部分（作るときに、ここだけ差し替える） */
  token: string;
}

const REIWA_START = 2018; // 令和 n 年 = 2018 + n

/** 年ごとのフォルダの名前を読む（「2025年」「令和7年度」「R07」など）。年のフォルダでなければ null */
export function parseYearFolder(name: string): YearFolder | null {
  const n = name.normalize('NFKC').trim();
  let m: RegExpMatchArray | null;
  let year: number;
  let style: YearFolder['style'];
  let token: string;
  if ((m = n.match(/(19|20)\d{2}/))) {
    year = Number(m[0]);
    style = 'western';
    token = m[0];
  } else if ((m = n.match(/令和\s*(\d{1,2}|元)/))) {
    year = REIWA_START + (m[1] === '元' ? 1 : Number(m[1]));
    style = 'reiwa';
    token = m[0];
  } else if ((m = n.match(/(?<![A-Za-z])[Rr]\s*(\d{1,2})(?!\d)/))) {
    year = REIWA_START + Number(m[1]);
    style = 'r';
    token = m[0];
  } else return null;
  // 年のほかに書いてあるのは「年」「年度」「分」「終了」などの短い言葉だけ（依頼者の名前などは年のフォルダにしない）
  const rest = n.replace(token, '').replace(/[\s_.\-・（）()【】[\]]/g, '');
  if (!/^(年度?|年分|年終了|終了|分|度|年)?$/.test(rest)) return null;
  return { name, year, fiscal: /年度/.test(n), style, token };
}

/** 移す日の年（年度なら 4 月始まり）。日本時間で数える */
export function targetYear(now: Date, fiscal: boolean): number {
  const jst = new Date(now.getTime() + 9 * 3600_000);
  const y = jst.getUTCFullYear();
  return fiscal && jst.getUTCMonth() < 3 ? y - 1 : y;
}

/** 既存の年のフォルダと同じ書き方で、その年のフォルダ名を作る（「2025年」→「2026年」、「R07」→「R08」、「令和7年」→「令和8年」） */
export function yearFolderName(template: YearFolder, year: number): string {
  let token: string;
  if (template.style === 'western') token = String(year);
  else {
    const n = year - REIWA_START;
    if (template.style === 'reiwa') token = `令和${n}`;
    else {
      const digits = template.token.match(/\d+/)?.[0] ?? '';
      token = template.token.replace(/\d+/, String(n).padStart(digits.length, '0'));
    }
  }
  return template.name.normalize('NFKC').replace(template.token, token);
}

const KANA_ROWS: [string, string][] = [
  ['あ', 'あいうえおぁぃぅぇぉゔ'],
  ['か', 'かきくけこがぎぐげご'],
  ['さ', 'さしすせそざじずぜぞ'],
  ['た', 'たちつてとだぢづでどっ'],
  ['な', 'なにぬねの'],
  ['は', 'はひふへほばびぶべぼぱぴぷぺぽ'],
  ['ま', 'まみむめも'],
  ['や', 'やゆよゃゅょ'],
  ['ら', 'らりるれろ'],
  ['わ', 'わをんゎ'],
];

/** 読み（かな）の 1 文字目の行（「やまだ」→「や」）。カタカナも可 */
export function kanaRow(kana: string | null | undefined): string | null {
  const c = (kana ?? '').normalize('NFKC').trim().charAt(0);
  if (!c) return null;
  const hira = c.replace(/[ァ-ヶ]/g, (x) => String.fromCharCode(x.charCodeAt(0) - 0x60));
  return KANA_ROWS.find(([, chars]) => chars.includes(hira))?.[0] ?? null;
}

export interface PlacementContext {
  now: Date;
  /** 依頼者の読み */
  kana: string | null;
  /** この事件の類型の名前（「破産」など） */
  caseTypeLabel: string | null;
  /** すべての事件類型の名前（フォルダが種類ごとに分かれているかの判断に使う） */
  allCaseTypeLabels: string[];
}

export type PlacementChoice = { name: string; create: boolean; scheme: 'year' | 'type' | 'kana' } | null;

const squash = (s: string) => s.normalize('NFKC').replace(/[\s　・]/g, '');

/**
 * 区分フォルダの中のフォルダ名から分け方を読み取り、この事件を入れるフォルダを選ぶ。
 * 分け方が読み取れない・合うフォルダが無いときは null（そのフォルダの直下に置く）
 */
export function chooseSubfolder(folderNames: string[], ctx: PlacementContext): PlacementChoice {
  // 年ごと
  const years = folderNames.map(parseYearFolder).filter((x): x is YearFolder => !!x);
  // 年のフォルダが 2 つ以上ある、または中のフォルダがすべて年のフォルダ（依頼者のフォルダの間に 1 つだけ紛れているのは年ごとと見ない）
  if (years.length >= 2 || (years.length === 1 && folderNames.length === 1)) {
    const fiscal = years.filter((y) => y.fiscal).length * 2 > years.length;
    const want = targetYear(ctx.now, fiscal);
    const hit = years.find((y) => y.year === want && y.fiscal === fiscal) ?? years.find((y) => y.year === want);
    if (hit) return { name: hit.name, create: false, scheme: 'year' };
    // 同じ書き方の、いちばん新しい年のフォルダに倣って作る
    const template = [...years].filter((y) => y.fiscal === fiscal).sort((a, b) => b.year - a.year)[0] ?? years[0]!;
    return { name: yearFolderName(template, want), create: true, scheme: 'year' };
  }
  // 事件の種類ごと（2 つ以上のフォルダが事件類型の名前と合うとき）
  const labels = ctx.allCaseTypeLabels.map(squash).filter((l) => l.length >= 2);
  const typeFolders = folderNames.filter((n) => labels.some((l) => squash(n).includes(l) || l.includes(squash(n))));
  if (typeFolders.length >= 2) {
    const mine = ctx.caseTypeLabel ? squash(ctx.caseTypeLabel) : '';
    const hit = mine ? typeFolders.find((n) => squash(n).includes(mine) || mine.includes(squash(n))) : undefined;
    return hit ? { name: hit, create: false, scheme: 'type' } : null;
  }
  // 五十音ごと（「あ行」「か行」…が 3 つ以上あるとき）
  const rowFolders = folderNames.filter((n) => /^[あかさたなはまやらわ]行?$/.test(squash(n)));
  if (rowFolders.length >= 3) {
    const row = kanaRow(ctx.kana);
    const hit = row ? rowFolders.find((n) => squash(n).startsWith(row)) : undefined;
    return hit ? { name: hit, create: false, scheme: 'kana' } : null;
  }
  return null;
}

/**
 * 区分フォルダ（依頼者ルートからの相対）の中で、この事件を入れるフォルダ（相対パス）を決める。
 * 2 段まで辿る（「3.終了事件/破産/2026年」など）。年のフォルダが無ければ作る
 */
export async function placementFolder(
  statusFolder: string,
  ctx: PlacementContext,
  io: { list: (rel: string) => Promise<{ name: string; isFolder: boolean }[]>; ensureFolder: (rel: string) => Promise<void> },
): Promise<string> {
  let current = statusFolder;
  for (let depth = 0; depth < 2; depth++) {
    const names = (await io.list(current).catch(() => [])).filter((x) => x.isFolder).map((x) => x.name);
    if (!names.length) break;
    const pick = chooseSubfolder(names, ctx);
    if (!pick) break;
    const next = `${current}/${pick.name}`;
    if (pick.create) {
      await io.ensureFolder(next);
      return next; // 作ったばかりのフォルダの中は空なので、それ以上は辿らない
    }
    current = next;
  }
  return current;
}
