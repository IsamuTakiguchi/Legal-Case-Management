import { useState } from 'react';
import { api } from '../lib/api';

export default function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
    <div className="flex min-h-screen items-center justify-center">
      <form onSubmit={submit} className="card w-80 space-y-3">
        <h1 className="text-lg font-bold">ログイン</h1>
        <div>
          <label className="label">パスワード</label>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </div>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <button className="btn btn-primary w-full justify-center" disabled={busy}>
          ログイン
        </button>
      </form>
    </div>
  );
}
