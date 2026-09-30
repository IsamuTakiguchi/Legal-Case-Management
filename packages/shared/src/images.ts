/** ブラウザでそのまま表示できる画像の種類（SVG は中にスクリプトを書けるので入れない） */
const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
};
const ALLOWED_MIME = new Set(Object.values(IMAGE_TYPES));

/**
 * 添付が画面にそのまま出せる画像なら、その Content-Type。画像でなければ null。
 * Chatwork などは種類が分からない（null や application/octet-stream）ことがあるので、そのときは拡張子で見る
 */
export function imagePreviewMime(filename: string, mime: string | null | undefined): string | null {
  const m = mime?.toLowerCase().split(';')[0]!.trim() || null;
  if (m === 'image/jpg') return 'image/jpeg';
  if (m && ALLOWED_MIME.has(m)) return m;
  if (m && m !== 'application/octet-stream' && m !== 'binary/octet-stream') return null;
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? '';
  return IMAGE_TYPES[ext] ?? null;
}
