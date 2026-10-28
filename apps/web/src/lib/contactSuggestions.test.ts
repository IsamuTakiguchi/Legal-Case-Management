import { describe, it, expect } from 'vitest';
import { filterContactSuggestions, type ContactSuggestion } from './ContactSuggestions';

const list: ContactSuggestion[] = [
  { name: '鈴木 弁護士', phone: '03-1234-5678', hint: 'この事件の記録 3 回' },
  { name: '山田 太郎', phone: '090-1111-2222', hint: '依頼者' },
  { name: '佐藤 書記官', phone: '03-9999-0000', hint: 'ほかの事件の記録' },
  { name: '田中 一郎', phone: null, hint: '相手方代理人（田中法律事務所）' },
];

describe('記録の相手・電話番号の候補の絞り込み', () => {
  it('何も入れていなければ上から順に出す', () => {
    expect(filterContactSuggestions(list, '', '', 2).map((s) => s.name)).toEqual(['鈴木 弁護士', '山田 太郎']);
  });

  it('相手の名前は空白を無視して部分一致、出どころ（相手方代理人など）でも探せる', () => {
    expect(filterContactSuggestions(list, '山田太', '').map((s) => s.name)).toEqual(['山田 太郎']);
    expect(filterContactSuggestions(list, '代理人', '').map((s) => s.name)).toEqual(['田中 一郎']);
  });

  it('電話番号は数字だけで部分一致（全角・ハイフンは無視）', () => {
    expect(filterContactSuggestions(list, '', '０９０１１').map((s) => s.name)).toEqual(['山田 太郎']);
    expect(filterContactSuggestions(list, '', '03-').map((s) => s.name)).toEqual(['鈴木 弁護士', '佐藤 書記官']);
  });

  it('入力済みのものと同じ候補は出さない', () => {
    expect(filterContactSuggestions(list, '山田 太郎', '090-1111-2222')).toEqual([]);
  });
});
