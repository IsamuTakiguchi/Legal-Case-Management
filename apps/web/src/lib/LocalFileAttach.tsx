import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { api } from './api';
import { fmtBytes } from './format';

/**
 * 送信に添付する、パソコンから選んだファイル。
 * 選んだ時点でサーバーの一時置き場に上げておき、送信のときは uploadIds だけを渡す
 */
export interface LocalUpload {
  id: string;
  name: string;
  size: number;
}

/** 1 ファイルの上限（サーバーと同じ） */
const LIMIT = 24 * 1024 * 1024;

export function useLocalUploads() {
  const [items, setItems] = useState<LocalUpload[]>([]);
  const [uploading, setUploading] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const add = async (files: FileList | File[]) => {
    setError(null);
    const errors: string[] = [];
    for (const f of Array.from(files)) {
      if (f.size > LIMIT) {
        errors.push(`${f.name} は大きすぎます（${Math.floor(LIMIT / 1024 / 1024)}MB まで）。フォルダに置いてから「フォルダのファイルを添付」で選んでください`);
        continue;
      }
      setUploading((u) => [...u, f.name]);
      try {
        const fd = new FormData();
        fd.append('file', f);
        const r = await api.upload<LocalUpload>('/outbound-uploads', fd);
        setItems((prev) => [...prev, r]);
      } catch (e) {
        errors.push(`${f.name}: ${(e as Error).message}`);
      } finally {
        setUploading((u) => {
          const i = u.indexOf(f.name);
          return i < 0 ? u : [...u.slice(0, i), ...u.slice(i + 1)];
        });
      }
    }
    if (errors.length) setError(errors.join(' / '));
  };
  const remove = (id: string) => {
    setItems((prev) => prev.filter((x) => x.id !== id));
    api.del(`/outbound-uploads/${id}`).catch(() => undefined);
  };
  /** 送信したあと（一時置き場はサーバーが片付けるので、画面の表示だけ消す） */
  const clear = () => {
    setItems([]);
    setError(null);
  };
  return { items, ids: items.map((x) => x.id), uploading, error, add, remove, clear };
}

export type LocalUploads = ReturnType<typeof useLocalUploads>;

/** 「パソコンのファイルを添付」ボタン（複数選べる） */
export function LocalFileButton({ uploads, disabled }: { uploads: LocalUploads; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => input.current?.click()} disabled={disabled || uploads.uploading.length > 0} title="パソコンにあるファイルを選んで添付します（この欄にファイルをドラッグ＆ドロップしても添付できます）">
        {uploads.uploading.length > 0 ? '📎 読み込み中…' : '📎 パソコンのファイルを添付'}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void uploads.add(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );
}

/** 選んだファイルの一覧（× で外す）と、読み込みの失敗 */
export function LocalFileBadges({ uploads, className = '' }: { uploads: LocalUploads; className?: string }) {
  if (!uploads.items.length && !uploads.uploading.length && !uploads.error) return null;
  return (
    <div className={`space-y-1 ${className}`}>
      {(uploads.items.length > 0 || uploads.uploading.length > 0) && (
        <div className="flex flex-wrap gap-1 text-xs">
          {uploads.items.map((f) => (
            <span key={f.id} className="badge badge-gray">
              💻 {f.name} <span className="text-slate-400">{fmtBytes(f.size)}</span>{' '}
              <button type="button" className="ml-1" onClick={() => uploads.remove(f.id)} title="外す">
                ×
              </button>
            </span>
          ))}
          {uploads.uploading.map((n, i) => (
            <span key={`${n}-${i}`} className="badge badge-gray opacity-60">
              💻 {n}（読み込み中…）
            </span>
          ))}
        </div>
      )}
      {uploads.error && <div className="text-xs text-red-600">{uploads.error}</div>}
    </div>
  );
}

/** ドラッグしているのがファイルか（文字や画面内の要素のドラッグは対象にしない） */
export function isFileDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
}

/**
 * ファイルをドラッグ＆ドロップして添付できる範囲。
 * 送信欄全体をこれで包むと、欄のどこに落としても添付になる。ドラッグ中は「ここにドロップ」と表示する
 */
export function FileDropZone({ uploads, children, className = '', disabled }: { uploads: LocalUploads; children: ReactNode; className?: string; disabled?: boolean }) {
  // 子要素の上を通るたびに enter / leave が来るので、数えて出入りを判定する
  const depth = useRef(0);
  const [over, setOver] = useState(false);
  const reset = () => {
    depth.current = 0;
    setOver(false);
  };
  return (
    <div
      className={`relative ${className}`}
      onDragEnter={(e) => {
        if (disabled || !isFileDrag(e)) return;
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (disabled || !isFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(e) => {
        if (disabled || !isFileDrag(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        if (disabled || !e.dataTransfer.files.length) return;
        e.preventDefault();
        reset();
        void uploads.add(e.dataTransfer.files);
      }}
    >
      {children}
      {over && (
        // 親の space-y-* の余白で枠がずれないよう、余白は 0 に固定する
        <div style={{ margin: 0 }} className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[inherit] border-2 border-dashed border-blue-400 bg-blue-50/80 text-sm font-semibold text-blue-700">
          ここにドロップすると添付します
        </div>
      )}
    </div>
  );
}

/**
 * 添付できる欄の外にファイルを落としたとき、ブラウザがそのファイルを開いて画面（書きかけの文）が消えないようにする。
 * アプリ全体で一度だけ登録する。ファイル選択の欄（input type=file）へのドロップはそのまま通す
 */
export function preventStrayFileDrops(): () => void {
  const isFileInput = (t: EventTarget | null) => t instanceof HTMLInputElement && t.type === 'file';
  const onDragOver = (e: globalThis.DragEvent) => {
    if (!isFileDrag(e) || e.defaultPrevented || isFileInput(e.target)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  };
  const onDrop = (e: globalThis.DragEvent) => {
    if (!isFileDrag(e) || e.defaultPrevented || isFileInput(e.target)) return;
    e.preventDefault();
  };
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('drop', onDrop);
  return () => {
    window.removeEventListener('dragover', onDragOver);
    window.removeEventListener('drop', onDrop);
  };
}
