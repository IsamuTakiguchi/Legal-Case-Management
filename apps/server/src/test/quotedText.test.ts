import { describe, it, expect } from 'vitest';
import { splitQuotedReply, stripQuotedReply } from '@lcm/shared';

describe('メールの引用を切り分ける', () => {
  it('Gmail 日本語の「2026年9月17日(水) … <メール>:」で切る', () => {
    const body = [
      '瀧口先生',
      '',
      '承知しました。10/5 でお願いします。',
      '',
      '2026年9月17日(水) 10:00 瀧口 勇 <takiguchi@example.com>:',
      '',
      '> 山田様',
      '> 候補日は 10/5 と 10/6 です。',
    ].join('\n');
    const r = splitQuotedReply(body);
    expect(r.main).toBe('瀧口先生\n\n承知しました。10/5 でお願いします。');
    expect(r.quoted.startsWith('2026年9月17日(水) 10:00 瀧口 勇')).toBe(true);
    expect(r.quoted).toContain('候補日は 10/5 と 10/6 です。');
  });

  it('英語の「On … wrote:」で切る（2 行に折り返されていても）', () => {
    const one = ['Thanks.', '', 'On Wed, Sep 17, 2026 at 10:00 AM Isamu <a@b.com> wrote:', '> Hello', '> Please confirm.'].join('\n');
    expect(splitQuotedReply(one).main).toBe('Thanks.');
    const two = ['Thanks.', '', 'On Wed, Sep 17, 2026 at 10:00 AM Isamu <a@b.com>', 'wrote:', '> Hello', '> Please confirm.'].join('\n');
    expect(splitQuotedReply(two).main).toBe('Thanks.');
    expect(splitQuotedReply(two).quoted).toContain('Please confirm.');
  });

  it('Outlook の「-----元のメッセージ-----」と下線の区切りで切る', () => {
    const a = ['了解です。', '', '-----元のメッセージ-----', '差出人: 瀧口 勇', '件名: 打合せの件', '', '本文です'].join('\n');
    expect(splitQuotedReply(a).main).toBe('了解です。');
    const b = ['了解です。', '', '________________________________', '差出人: 瀧口 勇 <a@b.com>', '送信日時: 2026年9月17日 10:00', '件名: 打合せの件'].join('\n');
    expect(splitQuotedReply(b).main).toBe('了解です。');
  });

  it('「差出人: … 件名: …」の並びで切る（区切り行が無くても）', () => {
    const body = ['承知しました。', '', '差出人: 瀧口 勇 <a@b.com>', '送信日時: 2026年9月17日 10:00', '宛先: 山田 花子', '件名: 打合せの件', '', '本文です'].join('\n');
    expect(splitQuotedReply(body).main).toBe('承知しました。');
  });

  it('「>」で始まる行が末尾まで続くときは、そこから引用とみなす', () => {
    const body = ['承知しました。', '', '> 候補日は 10/5 と 10/6 です。', '> ご都合はいかがでしょうか。'].join('\n');
    const r = splitQuotedReply(body);
    expect(r.main).toBe('承知しました。');
    expect(r.quoted).toBe('> 候補日は 10/5 と 10/6 です。\n> ご都合はいかがでしょうか。');
  });

  it('本文の途中の「>」は引用にしない（後ろに続きがある）', () => {
    const body = ['次のとおりです。', '> 引用っぽい行', 'これは今回の本文です。'].join('\n');
    expect(splitQuotedReply(body).quoted).toBe('');
  });

  it('引用しかないメールは、そのまま全部見せる', () => {
    const body = ['> 候補日は 10/5 と 10/6 です。', '> ご都合はいかがでしょうか。'].join('\n');
    const r = splitQuotedReply(body);
    expect(r.quoted).toBe('');
    expect(r.main).toBe(body);
  });

  it('引用が無いメールは何も変えない', () => {
    const body = 'お世話になっております。\n書面が届きましたのでご連絡します。';
    expect(splitQuotedReply(body)).toEqual({ main: body, quoted: '' });
    expect(stripQuotedReply(body)).toBe(body);
  });

  it('日付が出てくるだけの本文は引用と間違えない', () => {
    const body = ['2026年9月17日に次の書面を提出します:', '準備書面（1）', '証拠説明書'].join('\n');
    expect(splitQuotedReply(body).quoted).toBe('');
  });

  it('空・null でも落ちない', () => {
    expect(splitQuotedReply('')).toEqual({ main: '', quoted: '' });
    expect(splitQuotedReply(null)).toEqual({ main: '', quoted: '' });
    expect(stripQuotedReply(undefined)).toBe('');
  });
});
