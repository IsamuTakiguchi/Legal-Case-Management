/** 続けて届いた画像を PDF にまとめた・まとめ待ちの印（サーバーの channelRef に入っている） */
export interface MergeRef {
  mergedInto?: { name: string; page: number; pages: number };
  mergeWait?: boolean;
}

/** PDF にまとめて保存した画像なら「PDF「…」の 2/3 ページ」 */
export function mergedLabel(ref: MergeRef | null | undefined): string | null {
  const m = ref?.mergedInto;
  return m ? `PDF「${m.name}」の ${m.page}/${m.pages} ページ` : null;
}

/** PDF にまとめられる画像（JPEG・PNG）か */
export function isMergeableImage(a: { filename: string; mime?: string | null }): boolean {
  return /\.(jpe?g|png)$/i.test(a.filename) || a.mime === 'image/jpeg' || a.mime === 'image/png';
}
