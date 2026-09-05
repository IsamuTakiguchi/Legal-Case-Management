import { useEffect, useState } from 'react';
import { api } from '../lib/api';

const ERRORS: Record<string, string> = {
  not_allowed: 'この Google アカウントではログインできません。設定 → ログイン で許可したアドレスか、「Google に接続」したアカウントを使ってください。',
  google_not_configured: 'Google のクライアント ID が未設定です。パスワードでログインし、初期設定で Google を設定してください。',
  no_allowed_email: 'Google ログインを許可するアドレスが未設定です。パスワードでログインし、初期設定で「Google に接続」するか、設定 → ログイン でアドレスを登録してください。',
  google_failed: 'Google との通信に失敗しました。もう一度お試しください。',
  locked: '試行回数が多すぎます。15 分ほど待ってから再度お試しください。',
};

export default function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [googleLogin, setGoogleLogin] = useState<boolean | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const e = p.get('error');
    if (e) {
      const email = p.get('email');
      setError((ERRORS[e] ?? 'ログインできませんでした。') + (email ? `（${email}）` : ''));
      setShowPassword(true);
    }
    api
      .get<{ authenticated: boolean; googleLogin: boolean }>('/auth/me')
      .then((r) => {
        setGoogleLogin(r.googleLogin);
        if (!r.googleLogin) setShowPassword(true);
      })
      .catch(() => {
        setGoogleLogin(false);
        setShowPassword(true);
      });
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/login', { password });
      location.href = '/';
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-sm space-y-4">
        <div>
          <h1 className="text-lg font-bold">統合コミュニケーション管理</h1>
          <p className="text-xs text-slate-500">登大路総合法律事務所</p>
        </div>
        {error && <div className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</div>}
        {googleLogin && (
          <a href="/api/auth/google/login/start" className="btn btn-primary w-full justify-center py-2">
            <GoogleMark />
            Google アカウントでログイン
          </a>
        )}
        {googleLogin && !showPassword && (
          <button type="button" className="w-full text-center text-xs text-slate-500 hover:underline" onClick={() => setShowPassword(true)}>
            パスワードでログイン
          </button>
        )}
        {showPassword && (
          <form onSubmit={submit} className="space-y-3">
            <div>
              <label className="label">パスワード</label>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={!googleLogin} autoComplete="current-password" />
            </div>
            <button className="btn w-full justify-center" disabled={busy || !password}>
              パスワードでログイン
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" className="mr-1 rounded-full bg-white">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.5 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" />
      <path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.5 0 20.1 0 24s1 7.5 2.6 10.7l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.3 0 11.6-2.1 15.5-5.7l-7.5-5.8c-2.1 1.4-4.8 2.3-8 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}
