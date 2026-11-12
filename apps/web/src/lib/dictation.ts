import { useEffect, useRef, useState } from 'react';

/** ブラウザの音声認識（Chrome・Safari などの webkitSpeechRecognition） */
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

function recognitionClass(): (new () => Recognition) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * 声で入力する。話し終わるたびに、確定した文を onText で渡す（入力欄の末尾に足す）。
 * 対応していないブラウザでは supported=false（ボタンを出さない。iPhone はキーボードの音声入力も使える）
 */
export function useDictation(onText: (text: string) => void) {
  const Cls = recognitionClass();
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const cb = useRef(onText);
  cb.current = onText;
  useEffect(() => () => rec.current?.stop(), []);
  const start = () => {
    if (!Cls || listening) return;
    setError(null);
    const r = new Cls();
    r.lang = 'ja-JP';
    r.interimResults = true;
    r.continuous = true;
    r.onresult = (e) => {
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) cb.current(res[0].transcript);
        else live += res[0].transcript;
      }
      setInterim(live);
    };
    r.onerror = (e) => setError(e.error === 'not-allowed' ? 'マイクの使用が許可されていません（ブラウザの設定で許可してください）' : e.error === 'no-speech' ? null : `音声入力が止まりました（${e.error}）`);
    r.onend = () => {
      setListening(false);
      setInterim('');
    };
    rec.current = r;
    r.start();
    setListening(true);
  };
  const stop = () => rec.current?.stop();
  return { supported: !!Cls, listening, interim, error, start, stop, toggle: () => (listening ? stop() : start()) };
}
