/**
 * ロゴ（docs/brand/logo-tlex.png）から、アプリのアイコン一式を作る。
 *   npx playwright install chromium   # 初回だけ
 *   node apps/web/scripts/render-icons.mjs
 * Playwright が別の場所にあるときは、その index.mjs を PLAYWRIGHT_MODULE で指定する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(here, '../../../docs/brand/logo-tlex.png');
const OUT = path.resolve(here, '../public');

/**
 * 作るもの。
 * full = 地色を全面に敷く（角丸は端末側で付ける）。このときはタイルの縁の影が二重に見えないよう内側だけを使う
 * scale = 絵柄の大きさ
 */
const TARGETS = [
  { file: 'icon-192.png', size: 192, full: false, scale: 1 },
  { file: 'icon-512.png', size: 512, full: false, scale: 1 },
  { file: 'apple-touch-icon.png', size: 180, full: true, scale: 1 },
  // Android の丸型などで切り取られるので、絵柄は内側 80% に収める
  { file: 'icon-maskable-512.png', size: 512, full: true, scale: 0.82 },
];

const src = `data:image/png;base64,${fs.readFileSync(SOURCE).toString('base64')}`;
const browser = await chromium.launch();
const page = await browser.newPage();
const files = await page.evaluate(
  async ({ src, targets }) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const n = img.naturalWidth;
    const probe = document.createElement('canvas');
    probe.width = n;
    probe.height = n;
    const pctx = probe.getContext('2d');
    pctx.drawImage(img, 0, 0);
    const data = pctx.getImageData(0, 0, n, n).data;
    // ロゴの角丸タイル（生成りの地色＋濃い絵柄）の範囲を測る。まわりの白い余白と影は外す
    const isTile = (px, py) => {
      const i = (py * n + px) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      return (r - b >= 3 && r > 235) || r < 200 || g < 200 || b < 200;
    };
    let left = n;
    let right = 0;
    let top = n;
    let bottom = 0;
    for (let py = 0; py < n; py++) {
      for (let px = 0; px < n; px++) {
        if (!isTile(px, py)) continue;
        if (px < left) left = px;
        if (px > right) right = px;
        if (py < top) top = py;
        if (py > bottom) bottom = py;
      }
    }
    // 正方形に切り出す（中心はそのまま）
    const side = Math.min(right - left + 1, bottom - top + 1);
    const sx = Math.round((left + right) / 2 - side / 2);
    const sy = Math.round((top + bottom) / 2 - side / 2);
    // 角丸の半径の目安（上辺で地色が始まる位置）。少し大きめに取り、白い角を残さない
    let firstX = left;
    for (let px = left; px < right; px++) {
      if (isTile(px, top + 3)) {
        firstX = px;
        break;
      }
    }
    const radiusRatio = Math.min(0.25, (firstX - left) / side + 0.01);
    // 地色（タイルの余白）を拾う
    const bgI = ((sy + Math.round(side * 0.1)) * n + sx + Math.round(side * 0.5)) * 4;
    const bg = `rgb(${data[bgI]},${data[bgI + 1]},${data[bgI + 2]})`;

    const round = (ctx, size, r) => {
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.arcTo(size, 0, size, size, r);
      ctx.arcTo(size, size, 0, size, r);
      ctx.arcTo(0, size, 0, 0, r);
      ctx.arcTo(0, 0, size, 0, r);
      ctx.closePath();
    };

    const out = [];
    for (const t of targets) {
      const c = document.createElement('canvas');
      c.width = t.size;
      c.height = t.size;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      const drawn = t.size * t.scale;
      const off = (t.size - drawn) / 2;
      if (t.full) {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, t.size, t.size);
        // タイルの縁（影・角の白）が輪郭として残らないよう、少し内側を角丸で切り抜いて地色の上に置く
        const inset = Math.round(side * 0.045);
        ctx.save();
        ctx.beginPath();
        ctx.translate(off, off);
        round(ctx, drawn, drawn * (radiusRatio + 0.02));
        ctx.clip();
        ctx.drawImage(img, sx + inset, sy + inset, side - inset * 2, side - inset * 2, 0, 0, drawn, drawn);
        ctx.restore();
      } else {
        ctx.save();
        // タイルの角の外側（白）が残らないように角丸で切り抜く
        ctx.beginPath();
        ctx.translate(off, off);
        round(ctx, drawn, drawn * radiusRatio);
        ctx.clip();
        ctx.drawImage(img, sx, sy, side, side, 0, 0, drawn, drawn);
        ctx.restore();
      }
      out.push({ file: t.file, data: c.toDataURL('image/png').split(',')[1] });
    }
    return { out, info: { side, sx, sy, radiusRatio, bg } };
  },
  { src, targets: TARGETS },
);
await browser.close();
for (const f of files.out) {
  fs.writeFileSync(path.join(OUT, f.file), Buffer.from(f.data, 'base64'));
  console.log(`${f.file} を書き出しました`);
}
console.log(files.info);
