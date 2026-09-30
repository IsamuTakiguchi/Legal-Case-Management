import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { imagePreviewMime } from '@lcm/shared';

export interface PreviewableAttachment {
  id: number;
  filename: string;
  mime?: string | null;
  status: string;
}

/** 会話の吹き出しにその場で出せる画像か（不要にしたもの・取得に失敗したものは出さない） */
export function canPreviewImage(a: PreviewableAttachment): boolean {
  if (a.status === 'ignored' || a.status === 'failed') return false;
  return !!imagePreviewMime(a.filename, a.mime);
}

/**
 * LINE のように、受け取った画像を吹き出しの中に小さく表示する。
 * 高さは読み込み前から同じにしておく（読み込み後に吹き出しの高さが変わって、最新メッセージへのスクロールがずれないように）。
 * 押すと大きく表示する。読み込めない画像（HEIC を表示できないブラウザなど）は何も出さず、下のファイル名のリンクに任せる
 */
export function AttachmentImage({ a }: { a: PreviewableAttachment }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  if (failed) return null;
  const src = `/api/attachments/${a.id}/preview`;
  return (
    <>
      <button
        type="button"
        className={`block h-44 overflow-hidden rounded-[12px] border border-black/5 bg-slate-100 ${loaded ? '' : 'w-44 animate-pulse'}`}
        onClick={() => setOpen(true)}
        title={`${a.filename}（押すと大きく表示）`}
        aria-label={`画像 ${a.filename} を大きく表示`}
      >
        <img src={src} alt={a.filename} loading="lazy" className={`block h-full w-auto max-w-[min(15rem,60vw)] object-cover ${loaded ? '' : 'invisible'}`} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
      </button>
      {open && <ImageViewer src={src} filename={a.filename} downloadHref={`/api/attachments/${a.id}/download`} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 画像を画面いっぱいに表示する。背景を押すか Esc で閉じる */
function ImageViewer({ src, filename, downloadHref, onClose }: { src: string; filename: string; downloadHref: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return createPortal(
    <div className="fade-in fixed inset-0 z-50 flex flex-col bg-black/85" role="dialog" aria-modal="true" aria-label={filename} onClick={onClose}>
      <div className="flex items-center gap-3 px-4 py-3 text-sm text-white" onClick={(e) => e.stopPropagation()}>
        <span className="min-w-0 flex-1 truncate">{filename}</span>
        <a className="rounded-full bg-white/15 px-3 py-1 hover:bg-white/25" href={downloadHref}>
          ダウンロード
        </a>
        <a className="rounded-full bg-white/15 px-3 py-1 hover:bg-white/25" href={src} target="_blank" rel="noreferrer">
          新しいタブで開く
        </a>
        <button type="button" className="rounded-full bg-white/15 px-3 py-1 hover:bg-white/25" onClick={onClose} aria-label="閉じる">
          ✕
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <img src={src} alt={filename} className="max-h-full max-w-full object-contain shadow-2xl" onClick={(e) => e.stopPropagation()} />
      </div>
    </div>,
    document.body,
  );
}
