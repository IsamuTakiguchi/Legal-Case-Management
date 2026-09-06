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
  state: { anthropic: boolean; line: boolean; chatwork: boolean; google: { configured: boolean; connected: boolean }; microsoft: { configured: boolean; connected: boolean; mode?: string }; zoom: boolean };
}

const DOC_BASE = 'https://github.com/IsamuTakiguchi/Legal-Case-Management/blob/main/docs/setup/';

const CONSOLE: Record<string, { label: string; url: string }[]> = {
  anthropic: [{ label: 'Anthropic Console（API キー）', url: 'https://console.anthropic.com/settings/keys' }],
  line: [
    { label: 'LINE Developers コンソール', url: 'https://developers.line.biz/console/' },
    { label: 'LINE Official Account Manager（応答設定）', url: 'https://manager.line.biz/' },
  ],
  chatwork: [
    { label: 'Chatwork API トークン', url: 'https://www.chatwork.com/service/packages/chatwork/subpackages/api/token.php' },
    { label: 'Chatwork Webhook 設定', url: 'https://www.chatwork.com/service/packages/chatwork/subpackages/webhook/list.php' },
  ],
  microsoft: [{ label: 'Microsoft Entra アプリの登録', url: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade' }],
  zoom: [{ label: 'Zoom App Marketplace（Build App）', url: 'https://marketplace.zoom.us/develop/create' }],
};

const STEPS: Record<string, string[]> = {
  general: ['Railway / Render / Fly.io では自動で認識されるため、通常は入力不要です（自前のドメインや Cloudflare Tunnel を使う場合のみ入力）。', 'この URL を基に、下の Webhook URL とリダイレクト URI が決まります。'],
  anthropic: ['console.anthropic.com で API キーを発行して貼り付けます。', '「接続テスト」で短い応答が返れば完了です。'],
  line: ['LINE Developers → 該当チャネル →「チャネル基本設定」タブにある「チャネル ID」と「チャネルシークレット」の 2 つを貼り付けて保存。', '「接続テスト」を押すと、アクセストークンの発行と Webhook URL の登録・疎通確認まで自動で行います（トークンは期限前に自動更新）。', 'あとは LINE Developers の「Webhook の利用」を ON、LINE Official Account Manager → 応答設定で「チャット」を ON にするだけです。'],
  chatwork: ['Chatwork → サービス連携 → API Token を貼り付けます。', '（任意）サービス連携 → Webhook で下の URL を登録し、表示されたトークンを貼り付けると即時受信になります。'],
  microsoft: ['最短: 下の「簡易接続（アプリ登録なし）」を押し、表示されたコードを microsoft.com/devicelogin で入力して事務所の Microsoft アカウントでサインイン。', '簡易接続がテナントの設定で拒否される場合のみ、Entra でアプリ登録（リダイレクト URI、シークレット、Files.ReadWrite / User.Read / offline_access）を行い、下の欄に貼り付けます。'],
  zoom: ['任意です。未設定のときは Google 接続済みなら WEB 相談の確定時に Google Meet の URL を自動発行して送ります。', 'Zoom を使う場合: Zoom App Marketplace → Build App → Server-to-Server OAuth → Account ID / Client ID / Client Secret を貼り付け → Scopes に meeting:write:admin と meeting:read:admin を追加して Activate。'],
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
  const connected = new URLSearchParams(location.search).get('connected');
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
      {connected && (
        <div className="card border-green-300 bg-green-50 text-sm">
          {connected === 'google' ? 'Google' : 'Microsoft'} に接続しました。
          {connected === 'google' ? ' 送信済みメールの取込・文体プロファイル生成・カレンダー同期をバックグラウンドで開始しました（設定 → バックグラウンド処理で進捗を確認できます）。' : ' 書式フォルダの索引化をバックグラウンドで開始しました。'}
        </div>
      )}
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
            {s.id === 'google' ? (
              <GoogleGuide redirectUri={d.urls.googleRedirect} />
            ) : (
              <ol className="ml-5 list-decimal space-y-0.5 text-xs text-slate-600">
                {STEPS[s.id]?.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ol>
            )}
            {CONSOLE[s.id] && s.id !== 'google' && (
              <div className="flex flex-wrap gap-2 text-xs">
                {CONSOLE[s.id].map((l) => (
                  <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="btn btn-sm">
                    ↗ {l.label}
                  </a>
                ))}
              </div>
            )}
            {s.id === 'line' && <Url label="Webhook URL" value={d.urls.lineWebhook} />}
            {s.id === 'chatwork' && <Url label="Webhook URL" value={d.urls.chatworkWebhook} />}
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
              {s.id === 'microsoft' && state?.configured && !state.connected && d.state.microsoft.mode !== 'device' && (
                <a className="btn btn-primary btn-sm" href="/api/auth/microsoft/start">
                  Microsoft に接続
                </a>
              )}
              {s.id === 'microsoft' && !state?.connected && <DeviceConnect mode={d.state.microsoft.mode} onDone={() => { qc.invalidateQueries({ queryKey: ['setup'] }); qc.invalidateQueries({ queryKey: ['status'] }); }} />}
              {s.id === 'microsoft' && state?.connected && d.state.microsoft.mode === 'device' && <span className="text-xs text-slate-500">簡易接続（アプリ登録なし）で接続中</span>}
              {s.id === 'microsoft' && state?.connected && <StatusFolderLayout rootKey={values.ONEDRIVE_CLIENT_ROOT ?? ''} />}
              {s.id === 'microsoft' && state?.connected && (
                <FolderPicker
                  current={values.ONEDRIVE_CLIENT_ROOT ?? ''}
                  onPick={(p) => {
                    setValues((v) => ({ ...v, ONEDRIVE_CLIENT_ROOT: p }));
                    api.put('/setup', { ONEDRIVE_CLIENT_ROOT: p }).then(() => {
                      setSaved(s.id);
                      qc.invalidateQueries({ queryKey: ['setup'] });
                      test.mutate('microsoft');
                    });
                  }}
                />
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

/** Google だけはアプリ登録を省略できないため、押すボタンをそのまま書いたガイドを出す */
const GOOGLE_STEPS: { title: string; url?: string; linkLabel?: string; actions: string[]; note?: string }[] = [
  {
    title: 'API を有効にする',
    url: 'https://console.cloud.google.com/apis/enableflow?apiid=gmail.googleapis.com,calendar-json.googleapis.com',
    linkLabel: 'Gmail API と Calendar API を一括で有効化',
    actions: ['リンクを開き、事務所の Google アカウントでログイン', 'プロジェクトの選択画面が出たら「新しいプロジェクト」→ 名前は任意（例: 事務所アプリ）→「作成」', '「次へ」→「有効にする」を押す'],
    note: 'すでにプロジェクトがある場合はそれを選んで構いません。',
  },
  {
    title: '同意画面を作る',
    url: 'https://console.cloud.google.com/auth/overview',
    linkLabel: 'OAuth 同意画面（Google Auth Platform）',
    actions: [
      '「開始」を押す',
      'アプリ名: 事務所アプリ（任意）、ユーザーサポートメール: 自分のアドレス →「次へ」',
      '対象: Google Workspace を使っていれば「内部」、個人の Gmail なら「外部」→「次へ」',
      '連絡先メール: 自分のアドレス →「次へ」→ 同意にチェック →「作成」',
    ],
    note: '「外部」にした場合は、左メニュー「対象」→「アプリを公開」を押して本番にしてください。テストのままだと 7 日で接続が切れます。',
  },
  {
    title: 'クライアント ID を作る',
    url: 'https://console.cloud.google.com/auth/clients/create',
    linkLabel: 'OAuth クライアントを作成',
    actions: ['アプリケーションの種類: 「ウェブ アプリケーション」', '名前: 任意', '「承認済みのリダイレクト URI」→「URI を追加」→ 下のリダイレクト URI を貼り付け', '「作成」を押す'],
  },
  {
    title: 'ID とシークレットを貼る',
    actions: ['作成後の画面に「クライアント ID」と「クライアント シークレット」が表示されます', 'この画面の下の欄にそれぞれ貼り付けて「保存」', '「Google に接続」→ 事務所のアカウントを選び、権限を許可'],
    note: '「このアプリは Google で確認されていません」と出たら「詳細」→「（安全ではないページ）に移動」で進めます（自分で作ったアプリなので問題ありません）。',
  },
];

function GoogleGuide({ redirectUri }: { redirectUri: string }) {
  const KEY = 'lcm_google_guide_done';
  const [done, setDone] = useState<boolean[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as boolean[];
      return GOOGLE_STEPS.map((_, i) => !!v[i]);
    } catch {
      return GOOGLE_STEPS.map(() => false);
    }
  });
  const toggle = (i: number) => {
    const next = done.map((v, j) => (j === i ? !v : v));
    setDone(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="space-y-2 text-xs">
      <div className="text-slate-600">Google だけはアプリ登録を省略できません。上から順に、書いてあるボタンをそのまま押してください（5 分ほど）。</div>
      {GOOGLE_STEPS.map((st, i) => (
        <div key={i} className={`rounded border p-2 ${done[i] ? 'border-green-200 bg-green-50' : 'border-slate-200'}`}>
          <label className="flex cursor-pointer items-center gap-2 font-semibold">
            <input type="checkbox" checked={done[i]} onChange={() => toggle(i)} />
            <span>
              {i + 1}. {st.title}
            </span>
            {st.url && (
              <a href={st.url} target="_blank" rel="noreferrer" className="btn btn-sm ml-auto">
                ↗ {st.linkLabel}
              </a>
            )}
          </label>
          <ol className="ml-8 mt-1 list-decimal space-y-0.5 text-slate-700">
            {st.actions.map((a, j) => (
              <li key={j}>{a}</li>
            ))}
          </ol>
          {i === 2 && (
            <div className="ml-6 mt-1">
              <Url label="リダイレクト URI" value={redirectUri} />
            </div>
          )}
          {st.note && <div className="ml-6 mt-1 text-slate-500">{st.note}</div>}
        </div>
      ))}
    </div>
  );
}

const STATUS_KEYS = ['consultation', 'active', 'wrapup', 'closed'] as const;
const STATUS_LABEL: Record<(typeof STATUS_KEYS)[number], string> = { consultation: '相談', active: '進行事件', wrapup: '残務処理', closed: '終了事件' };

/** 依頼者ルート直下の「0.相談／1.進行事件／…」を事件の区分に対応付ける */
function StatusFolderLayout({ rootKey }: { rootKey: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['onedrive-layout', rootKey],
    queryFn: () => api.get<{ root: string; folders: { name: string; childCount: number }[]; current: Record<string, string>; extras: string[]; guess: { map: Record<string, string>; extras: string[] } }>('/setup/onedrive/layout'),
  });
  const [map, setMap] = useState<Record<string, string>>({});
  const [extras, setExtras] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (!q.data || touched) return;
    const hasCurrent = Object.keys(q.data.current).length > 0;
    setMap(hasCurrent ? q.data.current : q.data.guess.map);
    setExtras(hasCurrent ? q.data.extras : q.data.guess.extras.filter((n) => !/^_/.test(n)));
  }, [q.data, touched]);
  const save = useMutation({
    mutationFn: () => api.put<{ ok: boolean; resolved: { scanned: number; updated: number; missing: string[] } }>('/setup/onedrive/layout', { map, extras }),
    onSuccess: (r) => {
      setMsg(`保存しました。区分フォルダ内のフォルダ ${r.resolved.scanned} 件を確認し、依頼者 ${r.resolved.updated} 名のフォルダを対応付けました${r.resolved.missing.length ? `（見つからない依頼者: ${r.resolved.missing.slice(0, 5).join('、')}${r.resolved.missing.length > 5 ? ' ほか' : ''}）` : ''}`);
      qc.invalidateQueries({ queryKey: ['onedrive-layout'] });
      qc.invalidateQueries({ queryKey: ['setup'] });
    },
    onError: (e) => setMsg((e as Error).message),
  });
  if (!q.data) return null;
  const folderNames = q.data.folders.map((f) => f.name);
  const looksFlat = Object.keys(q.data.guess.map).length === 0 && Object.keys(q.data.current).length === 0;
  const used = new Set(Object.values(map));
  return (
    <div className="w-full rounded border border-slate-200 bg-slate-50 p-3 text-xs">
      <div className="mb-1 font-semibold">区分フォルダの設定</div>
      <div className="mb-2 text-slate-600">
        依頼者ルート <code>{q.data.root}</code> の直下に「相談／進行事件／残務処理／終了事件」のような区分フォルダがあり、その中に依頼者フォルダが並ぶ運用の場合に、事件の区分と対応付けます。事件の区分を変えると依頼者フォルダを自動でその区分へ移動します。
        {looksFlat && ' 現在は区分フォルダが見つからないため、ルート直下を依頼者フォルダとして扱います（この設定は不要です）。'}
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {STATUS_KEYS.map((k) => (
          <label key={k} className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-slate-600">{STATUS_LABEL[k]}</span>
            <select
              className="input"
              value={map[k] ?? ''}
              onChange={(e) => {
                setTouched(true);
                setMap((m) => {
                  const next = { ...m };
                  if (e.target.value) next[k] = e.target.value;
                  else delete next[k];
                  return next;
                });
              }}
            >
              <option value="">（対応するフォルダなし）</option>
              {folderNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {folderNames.filter((n) => !used.has(n) && !/^_/.test(n)).length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-slate-600">区分には当たらないが依頼者フォルダを含むフォルダ（顧問先など）。チェックしたものは依頼者の検索対象になり、区分の変更では動かしません。</div>
          <div className="flex flex-wrap gap-2">
            {folderNames
              .filter((n) => !used.has(n) && !/^_/.test(n))
              .map((n) => (
                <label key={n} className="flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1">
                  <input
                    type="checkbox"
                    checked={extras.includes(n)}
                    onChange={(e) => {
                      setTouched(true);
                      setExtras((x) => (e.target.checked ? [...x, n] : x.filter((y) => y !== n)));
                    }}
                  />
                  {n}
                </label>
              ))}
          </div>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? '保存中…' : '区分を保存して依頼者フォルダを対応付ける'}
        </button>
        {msg && <span className="text-slate-700">{msg}</span>}
      </div>
    </div>
  );
}

/** OneDrive のフォルダをクリックで辿り、依頼者フォルダの親を選ぶ */
function FolderPicker({ current, onPick }: { current: string; onPick: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('/');
  const q = useQuery({
    queryKey: ['onedrive-folders', path],
    queryFn: () => api.get<{ path: string; folders: { name: string; path: string; childCount: number }[]; fileCount: number }>(`/setup/onedrive/folders?path=${encodeURIComponent(path)}`),
    enabled: open,
  });
  const crumbs = path === '/' ? [] : path.replace(/^\/+/, '').split('/');
  return (
    <div className="w-full">
      <button type="button" className="btn btn-sm" onClick={() => { setPath(current && current !== '/' ? current.replace(/\/[^/]*$/, '') || '/' : '/'); setOpen((v) => !v); }}>
        {open ? 'フォルダ選択を閉じる' : 'フォルダをクリックで選ぶ'}
      </button>
      {open && (
        <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-3 text-xs">
          <div className="mb-2 text-slate-600">依頼者ごとのフォルダ（山田太郎、株式会社○○ など）が並んでいる場所まで開いて、「ここにする」を押してください。</div>
          <div className="mb-2 flex flex-wrap items-center gap-1">
            <button type="button" className="text-blue-700 hover:underline" onClick={() => setPath('/')}>
              マイファイル
            </button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                <span className="text-slate-400">/</span>
                <button type="button" className="text-blue-700 hover:underline" onClick={() => setPath('/' + crumbs.slice(0, i + 1).join('/'))}>
                  {c}
                </button>
              </span>
            ))}
          </div>
          {q.isLoading && <div className="text-slate-500">読み込み中…</div>}
          {q.error && <div className="text-red-600">{(q.error as Error).message}</div>}
          {q.data && (
            <ul className="max-h-64 divide-y divide-slate-200 overflow-auto rounded border border-slate-200 bg-white">
              {q.data.folders.map((f) => (
                <li key={f.path} className="flex items-center gap-2 px-2 py-1.5">
                  <button type="button" className="flex-1 text-left hover:underline" onClick={() => setPath(f.path)}>
                    📁 {f.name} <span className="text-slate-400">（{f.childCount}）</span>
                  </button>
                </li>
              ))}
              {q.data.folders.length === 0 && <li className="px-2 py-2 text-slate-500">この中にフォルダはありません</li>}
            </ul>
          )}
          {q.data && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => { onPick(path); setOpen(false); }}>
                ここにする: <code className="ml-1">{path}</code>
              </button>
              <span className="text-slate-500">この中のフォルダ {q.data.folders.length} 件が依頼者フォルダとして扱われます</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Url({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded bg-slate-50 px-2 py-1 text-xs">
      <span className="text-slate-500">{label}:</span>
      <code className="select-all break-all">{value}</code>
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

function DeviceConnect({ mode, onDone }: { mode?: string; onDone: () => void }) {
  const [flow, setFlow] = useState<{ userCode: string; verificationUri: string; message: string; status: string; error?: string; account?: string } | null>(null);
  const [err, setErr] = useState('');
  const start = useMutation({
    mutationFn: () => api.post<{ userCode: string; verificationUri: string; message: string; status: string }>('/auth/microsoft/device/start'),
    onSuccess: (f) => {
      setFlow({ ...f });
      setErr('');
    },
    onError: (e) => setErr((e as Error).message),
  });
  const reset = useMutation({ mutationFn: () => api.post('/auth/microsoft/device/reset'), onSuccess: () => { setFlow(null); onDone(); } });
  useEffect(() => {
    if (!flow || flow.status !== 'pending') return;
    const t = setInterval(async () => {
      try {
        const s = await api.get<{ status: string; error?: string; account?: string }>('/auth/microsoft/device/status');
        if (s.status === 'done' || s.status === 'error') {
          setFlow((f) => (f ? { ...f, status: s.status, error: s.error, account: s.account } : f));
          if (s.status === 'done') onDone();
        }
      } catch {
        /* ignore */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [flow, onDone]);
  return (
    <div className="w-full space-y-2 rounded border border-blue-200 bg-blue-50 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary btn-sm" onClick={() => start.mutate()} disabled={start.isPending || flow?.status === 'pending'}>
          {start.isPending ? '準備中…' : '簡易接続（アプリ登録なし）を開始'}
        </button>
        {mode === 'device' && (
          <button className="btn btn-sm" onClick={() => reset.mutate()}>
            簡易接続をやめて自前のアプリ登録に戻す
          </button>
        )}
        <span className="text-slate-600">Microsoft 公式のコマンドラインツール用の公開クライアントを使うため、Entra でのアプリ登録が不要です。</span>
      </div>
      {err && <div className="text-red-600">{err}</div>}
      {flow && flow.status === 'pending' && (
        <div className="space-y-1">
          <div>
            <a className="font-semibold text-blue-700 underline" href={flow.verificationUri} target="_blank" rel="noreferrer">
              {flow.verificationUri}
            </a>{' '}
            を開き、次のコードを入力して事務所の Microsoft アカウントでサインインしてください（15 分以内）。
          </div>
          <div className="select-all text-2xl font-bold tracking-widest">{flow.userCode}</div>
          <div className="text-slate-500">サインインが完了すると自動的にこの画面が更新されます。</div>
        </div>
      )}
      {flow && flow.status === 'done' && <div className="text-green-700">接続しました: {flow.account}</div>}
      {flow && flow.status === 'error' && (
        <div className="text-red-600">
          接続できませんでした: {flow.error}
          <div className="text-slate-600">テナントの設定で拒否された可能性があります。「簡易接続をやめて自前のアプリ登録に戻す」を押し、手順書に従ってアプリ登録を行ってください。</div>
        </div>
      )}
    </div>
  );
}
