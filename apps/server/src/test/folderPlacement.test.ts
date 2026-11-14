import { describe, it, expect } from 'vitest';
import { parseYearFolder, targetYear, yearFolderName, kanaRow, chooseSubfolder, placementFolder } from '../services/folderPlacement.js';

const ctx = (over: Partial<Parameters<typeof chooseSubfolder>[1]> = {}) => ({
  now: new Date('2026-11-14T03:00:00Z'),
  kana: 'やまだ はなこ',
  caseTypeLabel: '自己破産',
  allCaseTypeLabels: ['離婚・男女問題', '自己破産', '交通事故', '相続', '一般民事'],
  ...over,
});

describe('年ごとのフォルダ', () => {
  it('いろいろな年の書き方を読む（依頼者の名前などは年のフォルダにしない）', () => {
    expect(parseYearFolder('2025年')).toMatchObject({ year: 2025, fiscal: false, style: 'western' });
    expect(parseYearFolder('2025')).toMatchObject({ year: 2025 });
    expect(parseYearFolder('２０２５年度')).toMatchObject({ year: 2025, fiscal: true });
    expect(parseYearFolder('令和7年')).toMatchObject({ year: 2025, style: 'reiwa' });
    expect(parseYearFolder('令和元年')).toMatchObject({ year: 2019 });
    expect(parseYearFolder('R07')).toMatchObject({ year: 2025, style: 'r' });
    expect(parseYearFolder('R7年度')).toMatchObject({ year: 2025, fiscal: true });
    expect(parseYearFolder('2025年終了')).toMatchObject({ year: 2025 });
    expect(parseYearFolder('や 山田花子')).toBeNull();
    expect(parseYearFolder('山田 2025 交通事故')).toBeNull();
    expect(parseYearFolder('Rさん')).toBeNull();
  });

  it('年度は 4 月始まりで数え、同じ書き方で次の年のフォルダ名を作る', () => {
    expect(targetYear(new Date('2026-03-31T10:00:00Z'), true)).toBe(2025);
    expect(targetYear(new Date('2026-04-01T00:00:00Z'), true)).toBe(2026);
    expect(targetYear(new Date('2026-12-31T16:00:00Z'), false)).toBe(2027); // 日本時間では 2027/1/1
    expect(yearFolderName(parseYearFolder('2025年')!, 2026)).toBe('2026年');
    expect(yearFolderName(parseYearFolder('R07')!, 2026)).toBe('R08');
    expect(yearFolderName(parseYearFolder('令和7年度')!, 2026)).toBe('令和8年度');
  });
});

describe('置き場所の選び方', () => {
  it('年ごと: 今年のフォルダへ。無ければ作る', () => {
    expect(chooseSubfolder(['2024年', '2025年', '2026年', 'や 山田旧'], ctx())).toEqual({ name: '2026年', create: false, scheme: 'year' });
    expect(chooseSubfolder(['2024年', '2025年'], ctx())).toEqual({ name: '2026年', create: true, scheme: 'year' });
    expect(chooseSubfolder(['R06', 'R07'], ctx())).toEqual({ name: 'R08', create: true, scheme: 'year' });
    // 依頼者のフォルダの間に年らしいフォルダが 1 つだけ紛れていても、年ごととは見ない
    expect(chooseSubfolder(['2019', 'や 山田花子', 'さ 佐藤太郎'], ctx())).toBeNull();
  });

  it('事件の種類ごと・五十音ごと', () => {
    expect(chooseSubfolder(['破産', '交通事故', '離婚'], ctx())).toEqual({ name: '破産', create: false, scheme: 'type' });
    expect(chooseSubfolder(['破産', '交通事故'], ctx({ caseTypeLabel: '相続' }))).toBeNull();
    expect(chooseSubfolder(['あ行', 'か行', 'さ行', 'や行'], ctx())).toEqual({ name: 'や行', create: false, scheme: 'kana' });
    expect(kanaRow('ヤマダ')).toBe('や');
    expect(kanaRow('がっこう')).toBe('か');
    // どれでもなければ直下
    expect(chooseSubfolder(['や 山田花子', 'さ 佐藤太郎'], ctx())).toBeNull();
  });

  it('2 段（種類 → 年）まで辿り、年のフォルダが無ければ作る', async () => {
    const tree: Record<string, string[]> = { '3.終了事件': ['破産', '交通事故'], '3.終了事件/破産': ['2024年', '2025年'] };
    const made: string[] = [];
    const io = {
      list: async (rel: string) => (tree[rel] ?? []).map((name) => ({ name, isFolder: true })),
      ensureFolder: async (rel: string) => {
        made.push(rel);
      },
    };
    expect(await placementFolder('3.終了事件', ctx(), io)).toBe('3.終了事件/破産/2026年');
    expect(made).toEqual(['3.終了事件/破産/2026年']);
    // 分けていなければ区分フォルダの直下
    expect(await placementFolder('2.残務処理', ctx(), io)).toBe('2.残務処理');
  });
});
