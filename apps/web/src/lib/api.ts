export class ApiError extends Error {
  status: number;
  /** 応答の本文（code などで画面の出し分けに使う） */
  data: Record<string, unknown> | null;
  constructor(status: number, message: string, data: Record<string, unknown> | null = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    if (!location.pathname.startsWith('/login')) location.href = '/login';
    throw new ApiError(401, 'ログインが必要です');
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = (json as { error?: string })?.error ?? text ?? res.statusText;
    throw new ApiError(res.status, msg, json && typeof json === 'object' ? (json as Record<string, unknown>) : null);
  }
  return json as T;
}

/** サーバーが決めた時間内に答えなかった（止まっている・更新の途中など） */
export class ServerTimeoutError extends Error {
  constructor() {
    super('サーバーが応答していません');
    this.name = 'ServerTimeoutError';
  }
}

/** 決めた時間で待つのをやめる（返事が来ないまま「読み込み中」で止まらないように） */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new ServerTimeoutError()), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export const api = {
  get: <T>(url: string) => fetch(`/api${url}`, { credentials: 'same-origin' }).then((r) => handle<T>(r)),
  post: <T>(url: string, body?: unknown) =>
    fetch(`/api${url}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => handle<T>(r)),
  put: <T>(url: string, body?: unknown) =>
    fetch(`/api${url}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => handle<T>(r)),
  del: <T>(url: string) => fetch(`/api${url}`, { method: 'DELETE', credentials: 'same-origin' }).then((r) => handle<T>(r)),
  upload: <T>(url: string, form: FormData) => fetch(`/api${url}`, { method: 'POST', credentials: 'same-origin', body: form }).then((r) => handle<T>(r)),
};

/** SSE を受け取る POST（AI 下書きなど） */
export async function postSSE(url: string, body: unknown, handlers: { onDelta?: (t: string) => void; onDone?: (data: Record<string, unknown>) => void; onError?: (msg: string) => void }) {
  const res = await fetch(`/api${url}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    handlers.onError?.((await res.text()) || res.statusText);
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (event === 'delta') handlers.onDelta?.(String(parsed.t ?? ''));
      else if (event === 'done') handlers.onDone?.(parsed);
      else if (event === 'error') handlers.onError?.(String(parsed.message ?? 'エラー'));
    }
  }
}
