import { useRef, useState, type DragEvent } from 'react';
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
      <button type="button" className="btn btn-sm" onClick={() => input.current?.click()} disabled={disabled || uploads.uploading.length > 0} title="パソコンにあるファイルを選んで添付します（入力欄にドラッグ＆ドロップでも添付できます）">
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

/** 入力欄などにファイルをドラッグ＆ドロップしたら添付する */
export function fileDropProps(uploads: LocalUploads) {
  return {
    onDragOver: (e: DragEvent) => {
      if (e.dataTransfer.types.includes('Files')) e.preventDefault();
    },
    onDrop: (e: DragEvent) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      void uploads.add(e.dataTransfer.files);
    },
  };
}
