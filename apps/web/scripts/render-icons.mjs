/**
 * ロゴ（docs/brand/logo-tlex.svg）から、アプリのアイコン一式（PNG）を作る。
 *   npx playwright install chromium   # 初回だけ
 *   node apps/web/scripts/render-icons.mjs
 * Playwright が別の場所にあるときは、その index.mjs を PLAYWRIGHT_MODULE で指定する。
 * Chromium の実行ファイルは CHROMIUM_PATH で指定できる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(here, '../../../docs/brand/logo-tlex.svg');
const OUT = path.resolve(here, '../public');

/**
 * 作るもの。
 * full = 地色を全面に敷く（角丸は端末側で付ける）
 * scale = 絵柄の大きさ（1 なら SVG のまま）
 */
const TARGETS = [
  { file: 'icon-192.png', size: 192, full: false, scale: 1 },
  { file: 'icon-512.png', size: 512, full: false, scale: 1 },
  { file: 'apple-touch-icon.png', size: 180, full: true, scale: 1 },
  // Android の丸型などで切り取られるので、絵柄は内側 80% に収める
  { file: 'icon-maskable-512.png', size: 512, full: true, scale: 0.82 },
];

const svg = fs.readFileSync(SOURCE, 'utf8');
const tile = svg.match(/<rect id="tile"[^>]*fill="([^"]+)"/);
if (!tile) throw new Error('logo-tlex.svg に id="tile" の rect（地色）が見つかりません');
const bg = tile[1];

/** 用途に合わせて SVG を組み替える（地色を全面に・絵柄を縮める） */
function variant(t) {
  let s = svg;
  if (t.full) s = s.replace(/(<rect id="tile"[^>]*?)\s*rx="[^"]*"/, '$1 rx="0"');
  if (t.scale !== 1) {
    const k = t.scale;
    const off = (512 * (1 - k)) / 2;
    s = s.replace('<g id="art">', `<g id="art" transform="translate(${off} ${off}) scale(${k})">`);
  }
  return s;
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage();
for (const t of TARGETS) {
  const data = `data:image/svg+xml;base64,${Buffer.from(variant(t)).toString('base64')}`;
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:${t.full ? bg : 'transparent'}"><img src="${data}" width="${t.size}" height="${t.size}" style="display:block"></body></html>`,
  );
  await page.waitForFunction(() => document.images[0]?.complete);
  const png = await page.screenshot({ type: 'png', omitBackground: !t.full, clip: { x: 0, y: 0, width: t.size, height: t.size } });
  fs.writeFileSync(path.join(OUT, t.file), png);
  console.log(`${t.file} を書き出しました`);
}
await browser.close();
