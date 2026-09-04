import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface Field {
  key: string;
  label: string;
  secret: boolean;
  placeholder?: string;
  set: boolean;
  source: 'db' | 'env' | 'none';
  display: string;
}
interface Service {
  id: string;
  label: string;
  doc: string;
  fields: Field[];
}
interface SetupData {
  services: Service[];
  urls: { lineWebhook: string; chatworkWebhook: string; googleRedirect: string; microsoftRedirect: string };
  state: { anthropic: boolean; line: boolean; chatwork: boolean; google: { configured: boolean; connected: boolean }; microsoft: { configured: boolean; connected: boolean }; zoom: boolean };
}

const DOC_BASE = 'https://github.com/IsamuTakiguchi/Legal-Case-Management/blob/claude/unified-communication-manager-cidsxx/docs/setup/';

const STEPS: Record<string, string[]> = {
  general: ['アプリを公開している URL を入力します（Cloudflare Tunnel や Fly.io の URL）。', 'この URL を基に、下の Webhook URL とリダイレクト URI が決まります。'],
  anthropic: ['console.anthropic.com で API キーを発行して貼り付けます。', '「接続テスト」で短い応答が返れば完了です。'],
  line: ['LINE Developers → チャネル基本設定の「チャネルシークレット」、Messaging API 設定の「チャネルアクセストークン（長期）」を貼り付けます。', '同じ画面の Webhook URL に下の URL を登録し「検証」→「Webhook の利用」を ON。', 'LINE Official Account Manager → 応答設定で「チャット」と「Webhook」を両方 ON。'],
  chatwork: ['Chatwork → サービス連携 → API Token を貼り付けます。', '（任意）サービス連携 → Webhook で下の URL を登録し、表示されたトークンを貼り付けると即時受信になります。'],
  google: ['Google Cloud で Gmail API と Calendar API を有効化し、OAuth 同意画面を「内部」（Workspace）または「本番」に。', 'OAuth クライアント（ウェブ）を作り、下のリダイレクト URI を登録。ID とシークレットを貼り付けて保存。', '保存後に「Google に接続」を押して同意します。'],
  microsoft: ['Microsoft Entra → アプリの登録 → 新規登録。リダイレクト URI（Web）に下の URI を登録。', '「証明書とシークレット」でシークレットを作成し、値を貼り付け。API のアクセス許可に Files.ReadWrite / User.Read / offline_access（委任）を追加。', '保存後に「Microsoft に接続」を押してサインインします。'],
  zoom: ['Zoom App Marketplace → Build App → Server-to-Server OAuth。Account ID / Client ID / Client Secret を貼り付け。', 'Scopes に meeting:write:admin と meeting:read:admin を追加して Activate。'],
};

export default function Setup() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['setup'], queryFn: () => api.get<SetupData>('/setup') });
  const [values, setValues] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [saved, setSaved] = useState<string>('');
  useEffect(() => {
    if (!q.data) return;
    const v: Record<string, string> = {};
    for (const s of q.data.services) for (const f of s.fields) if (!f.secret) v[f.key] = f.display;
    setValues((prev) => ({ ...v, ...prev }));
  }, [q.data]);
  const save = useMutation({
    mutationFn: (svc: Service) => {
      const body: Record<string, string> = {};
      for (const f of svc.fields) if (values[f.key] !== undefined) body[f.key] = values[f.key];
      return api.put('/setup', body);
    },
    onSuccess: (_, svc) => {
      setSaved(svc.id);
      qc.invalidateQueries({ queryKey: ['setup'] });
      qc.invalidateQueries({ queryKey: ['status'] });
      setValues((prev) => {
        const next = { ...prev };
        for (const f of svc.fields) if (f.secret) delete next[f.key];
        return next;
      });
    },
  });
  const test = useMutation({
    mutationFn: (id: string) => api.post<{ ok: boolean; message: string }>(`/setup/test/${id}`),
    onSuccess: (r, id) => setResults((p) => ({ ...p, [id]: r })),
    onError: (e, id) => setResults((p) => ({ ...p, [id]: { ok: false, message: (e as Error).message } })),
  });
  const d = q.data;
  if (!d) return <div className="text-slate-500">読み込み中…</div>;
  const done = [d.state.anthropic, d.state.line, d.state.chatwork, d.state.google.connected, d.state.microsoft.connected, d.state.zoom].filter(Boolean).length;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">初期設定</h1>
        <p className="text-sm text-slate-600">
          各サービスのキーをここに貼り付けて保存すると、暗号化してアプリ内に保存されます（.env の編集は不要）。進捗: {done} / 6。詳しい取得手順は各カードの「手順書」を参照してください。
        </p>
      </div>
      {d.services.map((s) => {
        const state = s.id === 'google' ? d.state.google : s.id === 'microsoft' ? d.state.microsoft : null;
        const ok = s.id === 'general' ? s.fields[0].set : state ? state.connected : (d.state as unknown as Record<string, boolean>)[s.id];
        const r = results[s.id];
        return (
          <section key={s.id} className="card space-y-3">
            <div className="flex items-center gap-2">
              <span className={`inline-block h-3 w-3 rounded-full ${ok ? 'bg-green-500' : state?.configured ? 'bg-yellow-400' : 'bg-slate-300'}`} />
              <h2 className="font-semibold">{s.label}</h2>
              {ok && <span className="badge badge-line">設定済</span>}
              {state && state.configured && !state.connected && <span className="badge badge-orange">未接続</span>}
              <a className="ml-auto text-xs text-blue-700 hover:underline" href={`${DOC_BASE}${s.doc}`} target="_blank" rel="noreferrer">
                手順書を開く
              </a>
            </div>
            <ol className="ml-5 list-decimal space-y-0.5 text-xs text-slate-600">
              {STEPS[s.id]?.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ol>
            {s.id === 'line' && <Url label="Webhook URL" value={d.urls.lineWebhook} />}
            {s.id === 'chatwork' && <Url label="Webhook URL" value={d.urls.chatworkWebhook} />}
            {s.id === 'google' && <Url label="リダイレクト URI" value={d.urls.googleRedirect} />}
            {s.id === 'microsoft' && <Url label="リダイレクト URI" value={d.urls.microsoftRedirect} />}
            <div className="grid gap-2 md:grid-cols-2">
              {s.fields.map((f) => (
                <div key={f.key}>
                  <label className="label">
                    {f.label}
                    {f.set && <span className="ml-1 text-slate-400">（{f.source === 'env' ? '.env から' : '保存済'}{f.secret ? `: ${f.display}` : ''}）</span>}
                  </label>
                  <input
                    className="input"
                    type={f.secret ? 'password' : 'text'}
                    placeholder={f.secret && f.set ? '変更する場合のみ入力' : f.placeholder}
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                    autoComplete="off"
                  />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn btn-primary btn-sm" onClick={() => save.mutate(s)} disabled={save.isPending}>
                保存
              </button>
              {s.id !== 'general' && (
                <button className="btn btn-sm" onClick={() => test.mutate(s.id)} disabled={test.isPending}>
                  {test.isPending && test.variables === s.id ? 'テスト中…' : '接続テスト'}
                </button>
              )}
              {s.id === 'google' && state?.configured && !state.connected && (
                <a className="btn btn-primary btn-sm" href="/api/auth/google/start">
                  Google に接続
                </a>
              )}
              {s.id === 'microsoft' && state?.configured && !state.connected && (
                <a className="btn btn-primary btn-sm" href="/api/auth/microsoft/start">
                  Microsoft に接続
                </a>
              )}
              {saved === s.id && <span className="text-xs text-green-700">保存しました</span>}
              {r && <span className={`text-xs ${r.ok ? 'text-green-700' : 'text-red-600'}`}>{r.message}</span>}
            </div>
          </section>
        );
      })}
      <section className="card text-sm">
        <h2 className="mb-1 font-semibold">設定後にすること</h2>
        <ol className="ml-5 list-decimal space-y-0.5 text-slate-700">
          <li>設定 → 文体学習 → 「Gmail 送信済みを取込」→「文体プロファイルを生成」</li>
          <li>依頼者を登録（メールアドレス・Chatwork ルーム ID・OneDrive フォルダ名）</li>
          <li>設定 → バックグラウンド処理 → 「Gmail 受信」「カレンダー同期」を今すぐ実行して動作確認</li>
        </ol>
      </section>
    </div>
  );
}

function Url({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded bg-slate-50 px-2 py-1 text-xs">
      <span className="text-slate-500">{label}:</span>
      <code className="select-all">{value}</code>
      <button
        className="btn btn-sm"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(() => setCopied(true));
        }}
      >
        {copied ? 'コピー済' : 'コピー'}
      </button>
    </div>
  );
}
