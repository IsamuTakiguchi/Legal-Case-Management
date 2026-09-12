import { useEffect, useRef, useState } from 'react';

/**
 * 入力途中のテキストをブラウザに自動保存して、画面を離れても消えないようにする仕組み。
 *
 * - 保存先はこの端末のブラウザ（localStorage）。サーバーには送らない
 * - 保存・送信に成功したら clear() で消す（呼ばなくても、元の内容に戻れば自動で消える）
 * - 編集フォームでは「元の内容（base）」も一緒に保存し、元が変わっていたら復元しない
 *   （他の端末や AI で内容が変わったのに古い入力で上書きしてしまうのを防ぐ）
 */
const PREFIX = 'lcm.draft.';
/** これより古い下書きは捨てる */
const TTL_MS = 30 * 86400_000;
const SAVE_DELAY_MS = 400;

type Stored = { v: unknown; base: unknown; at: number };

function storageKey(key: string): string {
  return PREFIX + key;
}

function read(key: string): Stored | null {
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return null;
    const p = JSON.parse(raw) as Stored;
    if (!p || typeof p !== 'object') return null;
    if (typeof p.at !== 'number' || Date.now() - p.at > TTL_MS) {
      localStorage.removeItem(storageKey(key));
      return null;
    }
    return p;
  } catch {
    return null;
  }
}

function write(key: string, v: unknown, base: unknown) {
  try {
    localStorage.setItem(storageKey(key), JSON.stringify({ v, base, at: Date.now() } satisfies Stored));
  } catch {
    // 容量超過やプライベートモードでも動作は止めない
  }
}

export function clearDraft(key: string) {
  try {
    localStorage.removeItem(storageKey(key));
  } catch {
    /* noop */
  }
}

/** 期限切れの下書きを片付ける（起動時に 1 回） */
export function pruneDrafts() {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      try {
        const p = JSON.parse(localStorage.getItem(k) ?? 'null') as Stored | null;
        if (!p || typeof p.at !== 'number' || Date.now() - p.at > TTL_MS) stale.push(k);
      } catch {
        stale.push(k);
      }
    }
    for (const k of stale) localStorage.removeItem(k);
  } catch {
    /* noop */
  }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export interface DraftHandle {
  /** この画面を開いたときに、保存されていた入力を復元したか */
  restored: boolean;
  /** 保存・送信できたら呼ぶ（下書きを消す） */
  clear: () => void;
}

/**
 * 1 つのテキスト入力を自動保存する。
 * key が null の間は何もしない（会話 ID などが未確定のとき）。
 * base には「元の内容」（新規入力なら空文字）を渡す。
 */
export function useDraft(key: string | null, value: string, setValue: (v: string) => void, base = ''): DraftHandle {
  const [restored, setRestored] = useState(false);
  const ready = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;
  const setRef = useRef(setValue);
  setRef.current = setValue;

  useEffect(() => {
    ready.current = false;
    if (!key) return;
    const saved = read(key);
    ready.current = true;
    if (!saved || typeof saved.v !== 'string') return;
    if (!same(saved.base, base)) {
      // 元の内容が変わっている（保存済み・他端末で更新など）。古い入力は捨てる
      clearDraft(key);
      return;
    }
    if (saved.v === valueRef.current) return;
    setRef.current(saved.v);
    setRestored(true);
  }, [key, base]);

  useEffect(() => {
    if (!key || !ready.current) return;
    const t = setTimeout(() => {
      if (value === base) clearDraft(key);
      else write(key, value, base);
    }, SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [key, value, base]);

  return {
    restored,
    clear: () => {
      if (key) clearDraft(key);
      setRestored(false);
    },
  };
}

/**
 * 別々の useState に分かれた複数の入力欄をまとめて自動保存する。
 * 各欄に value / set / base（元の内容。新規入力なら省略）を渡す。
 * 保存は 1 つのまとまりで行い、復元時は元の内容が変わっていない欄だけ戻す。
 */
export function useDraftGroup(key: string | null, fields: Record<string, { value: string; set: (v: string) => void; base?: string }>): DraftHandle {
  const [restored, setRestored] = useState(false);
  const ready = useRef(false);
  const ref = useRef(fields);
  ref.current = fields;
  const sig = (pick: (f: { value: string; base?: string }) => string) => JSON.stringify(Object.entries(fields).map(([k, f]) => [k, pick(f)]));
  const baseSig = sig((f) => f.base ?? '');
  const valueSig = sig((f) => f.value);

  useEffect(() => {
    ready.current = false;
    if (!key) return;
    const saved = read(key);
    ready.current = true;
    if (!saved || !saved.v || typeof saved.v !== 'object') return;
    const changed = saved.v as Record<string, string>;
    const savedBase = (saved.base ?? {}) as Record<string, string>;
    let any = false;
    for (const [k, f] of Object.entries(ref.current)) {
      const v = changed[k];
      if (typeof v !== 'string') continue;
      if ((savedBase[k] ?? '') !== (f.base ?? '')) continue; // 元の内容が変わっている欄は戻さない
      if (v === f.value) continue;
      f.set(v);
      any = true;
    }
    if (any) setRestored(true);
    else clearDraft(key);
  }, [key, baseSig]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!key || !ready.current) return;
    const t = setTimeout(() => {
      const changed: Record<string, string> = {};
      const baseOf: Record<string, string> = {};
      for (const [k, f] of Object.entries(ref.current)) {
        if (f.value === (f.base ?? '')) continue;
        changed[k] = f.value;
        baseOf[k] = f.base ?? '';
      }
      if (Object.keys(changed).length === 0) clearDraft(key);
      else write(key, changed, baseOf);
    }, SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [key, valueSig, baseSig]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    restored,
    clear: () => {
      if (key) clearDraft(key);
      setRestored(false);
    },
  };
}

/**
 * 複数項目のフォーム（オブジェクト）を自動保存する。
 * 変更のあった項目だけを保存し、復元時は「元の内容」が変わっていない項目だけ戻す。
 * base が null／undefined の間（サーバーからの読み込み前）は何もしない。
 */
export function useDraftRecord<T extends Record<string, unknown>>(key: string | null, value: T, setValue: (v: T) => void, base: T | null | undefined): DraftHandle {
  const [restored, setRestored] = useState(false);
  const ready = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;
  const setRef = useRef(setValue);
  setRef.current = setValue;
  const baseSig = base ? JSON.stringify(base) : '';

  useEffect(() => {
    ready.current = false;
    if (!key || !base) return;
    const saved = read(key);
    ready.current = true;
    if (!saved || !saved.v || typeof saved.v !== 'object') return;
    const changed = saved.v as Record<string, unknown>;
    const savedBase = (saved.base ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(changed)) {
      // 元の内容が変わっていない項目だけ戻す
      if (!same(savedBase[k], (base as Record<string, unknown>)[k])) continue;
      if (same(v, (valueRef.current as Record<string, unknown>)[k])) continue;
      patch[k] = v;
    }
    if (Object.keys(patch).length === 0) {
      clearDraft(key);
      return;
    }
    setRef.current({ ...valueRef.current, ...patch });
    setRestored(true);
    // base の中身が変わったら復元をやり直す（保存後・再読み込み後）
  }, [key, baseSig]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!key || !ready.current || !base) return;
    const t = setTimeout(() => {
      const changed: Record<string, unknown> = {};
      const baseOf: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (same(v, (base as Record<string, unknown>)[k])) continue;
        changed[k] = v;
        baseOf[k] = (base as Record<string, unknown>)[k] ?? null;
      }
      if (Object.keys(changed).length === 0) clearDraft(key);
      else write(key, changed, baseOf);
    }, SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [key, value, baseSig]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    restored,
    clear: () => {
      if (key) clearDraft(key);
      setRestored(false);
    },
  };
}

/** 「入力途中の内容を戻しました」の小さな案内 */
export function DraftHint({ handle, className = '' }: { handle: DraftHandle; className?: string }) {
  if (!handle.restored) return null;
  return <div className={`fade-in text-xs text-blue-600 ${className}`}>入力途中の内容を戻しました</div>;
}
