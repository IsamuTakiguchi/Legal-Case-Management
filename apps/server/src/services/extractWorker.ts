/**
 * 本文の取り出しを、サーバー本体とは別のスレッドで行う（大きな Excel・PDF でサーバー全体が固まらないように）。
 * forms.ts の extractText から起動される
 */
import { parentPort, workerData } from 'node:worker_threads';
import { extractTextInline } from './textExtract.js';

const { name, data } = workerData as { name: string; data: Uint8Array };
extractTextInline(name, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  .then((text) => parentPort?.postMessage({ ok: true, text }))
  .catch((err: unknown) => parentPort?.postMessage({ ok: false, error: String((err as Error)?.message ?? err) }));
