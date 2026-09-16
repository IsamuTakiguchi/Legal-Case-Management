/*
 * 画面が出る前に配色（昼／夜）を決める。
 * 本体の JavaScript より先に読ませることで、切り替わりのちらつきを防ぐ。
 * ページの中に直接書くとセキュリティ設定（CSP: script-src 'self'）で止まるため、別ファイルにしている。
 */
(function () {
  try {
    var c = localStorage.getItem('lcm-theme') || 'auto';
    var dark = c === 'dark' || (c !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', dark ? '#0e141b' : '#f4f2ee');
  } catch (e) {
    document.documentElement.dataset.theme = 'light';
  }
})();
