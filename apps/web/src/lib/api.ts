export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
    throw new ApiError(res.status, msg);
  }
  return json as T;
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
