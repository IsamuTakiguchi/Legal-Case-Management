import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * ほかの画面から「この 1 件を開いて」と名指しで来たときに、そこまで動かして目立たせる。
 *
 * 例: 要確認の「日程調整が停滞」→ `/inbox/12?session=3` → その日程調整だけが光る。
 *
 * @param key URL に付く名前（例 'session'）
 * @param ready 中身が出そろったか（読み込み中にスクロールしても意味がないため）
 * @returns 名指しされた ID（数値）。無ければ null
 */
export function useSpotlight(key: string, ready: boolean, elementId?: (id: number) => string): number | null {
  const [params] = useSearchParams();
  const raw = params.get(key);
  const id = raw && /^\d+$/.test(raw) ? Number(raw) : null;
  const [done, setDone] = useState<number | null>(null);

  useEffect(() => {
    if (!id || !ready || done === id) return;
    // 描画が終わってから動かす
    const t = setTimeout(() => {
      const el = document.getElementById(elementId ? elementId(id) : `${key}-${id}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setDone(id);
    }, 120);
    return () => clearTimeout(t);
  }, [id, ready, done, key, elementId]);

  return id;
}
