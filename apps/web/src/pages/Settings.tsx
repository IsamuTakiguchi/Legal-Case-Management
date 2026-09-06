import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';

interface Status {
  publicBaseUrl: string;
  storage: string;
  line: { configured: boolean; webhookUrl: string; quota: { used: number; limit: number } | null; lastWebhookAt: string | null; lastEventAt: string | null; lastError: string | null };
  chatwork: { configured: boolean; webhookUrl: string; webhookTokenSet: boolean };
  google: { configured: boolean; connected: boolean; account: string | null; redirectUri: string };
  microsoft: { configured: boolean; connected: boolean; account: string | null; redirectUri: string };
  zoom: { configured: boolean };
  anthropic: { configured: boolean; model: string };
  jobs: { name: string; label: string; cron: string; enabled: boolean; running: boolean; last: { startedAt: string; ok: boolean | null; summary: string | null; error: string | null } | null }[];
  demo: { seeded: boolean; seededAt: string | null };
}

interface BackupInfo {
  local: { name: string; size: number; createdAt: string }[];
  remoteFolder: string;
}

const FIELDS: { key: string; label: string; hint?: string; multiline?: boolean; options?: { value: string; label: string }[] }[] = [
  {
    key: 'gmail_categories',
    label: 'Gmail の取込範囲',
    hint: '「メインだけ」にすると、Gmail がプロモーション・ソーシャル・新着・フォーラムに分類した受信メールを受信箱に出しません',
    options: [
      { value: 'all', label: 'すべて（Gmail の全タブ）' },
      { value: 'primary', label: 'メインだけ' },
    ],
  },
  { key: 'lawyer_name', label: '弁護士名' },
  { key: 'office_name', label: '事務所名' },
  { key: 'office_location', label: '事務所所在地（カレンダーの場所欄）' },
  { key: 'signature_gmail', label: 'メール署名', multiline: true },
  { key: 'access_note', label: 'アクセス案内（面談確定テンプレートに差し込み）', multiline: true },
  { key: 'business_hours_start', label: '営業開始（時）' },
  { key: 'business_hours_end', label: '営業終了（時）' },
  { key: 'default_meeting_minutes', label: '既定の所要時間（分）' },
  { key: 'waiting_followup_business_days', label: '返信待ちのフォロー期限（営業日）' },
  { key: 'scheduling_stale_business_days', label: '日程調整の停滞判定（営業日）' },
  { key: 'holidays', label: '休業日（YYYY-MM-DD をカンマ区切り）', multiline: true },
  { key: 'attachment_subfolder', label: '受領ファイルの保存サブフォルダ' },
  { key: 'court_docs_subfolder', label: '提出書面のサブフォルダ' },
  { key: 'draft_subfolder', label: 'AI 下書きの保存サブフォルダ' },
  { key: 'unassigned_folder', label: '未振分フォルダ名（依頼者ルート直下）' },
  { key: 'forms_library_paths', label: '書式フォルダのパス（OneDrive ルートから・複数は改行）', multiline: true },
  { key: 'forms_index_client_subfolders', label: '依頼者フォルダ内で索引化するサブフォルダ（複数は改行）', multiline: true },
  { key: 'client_folder_name_format', label: '新規依頼者フォルダの名前の形', hint: '{kana}=読みの頭文字、{name}=氏名、{case}=事件名。例: {kana}{name}　{case} → 「し塩見海斗　損害賠償請求（交通事故）」。空なら氏名のみ。既存フォルダから自動推定' },
  { key: 'share_link_expiry_days', label: '共有リンクの有効期限（日）' },
  { key: 'morning_digest_hour', label: '朝ダイジェストの時刻（時・JST）' },
  { key: 'web_meeting_provider', label: 'WEB 会議の提供元（auto / zoom / meet）', hint: 'auto は Zoom 設定済みなら Zoom、なければ Google Meet' },
  { key: 'line_manual_send_note', label: 'LINE でファイルを送れない時の案内文', multiline: true },
];

const NOTIFY_FIELDS: { key: string; label: string; hint?: string; multiline?: boolean }[] = [
  { key: 'digest_title', label: '朝ダイジェストの見出し' },
  { key: 'digest_max_items', label: '朝ダイジェストに載せる返信待ちの最大件数' },
  { key: 'digest_footer', label: '朝ダイジェストの末尾に付ける文（空なら無し）', multiline: true },
  { key: 'alert_notify_title', label: '要確認の通知の見出し', hint: '件数が自動で付きます' },
];

const BACKUP_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: 'backup_folder', label: 'OneDrive の保存先（依頼者ルートからの相対パス）' },
  { key: 'backup_keep_generations', label: 'OneDrive に残す世代数' },
  { key: 'backup_local_keep', label: 'サーバー内に残す世代数' },
];

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function Settings() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['status'], queryFn: () => api.get<Status>('/status'), refetchInterval: 30_000 });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Record<string, string>>('/settings') });
  const style = useQuery({ queryKey: ['style'], queryFn: () => api.get<{ stats: { total: number; byChannel: Record<string, number>; bySource: Record<string, number>; profiles: { channel: string; generatedAt: string }[] }; profiles: Record<string, string> }>('/style') });
  const [form, setForm] = useState<Record<string, string>>({});
  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);
  const save = useMutation({ mutationFn: () => api.put('/settings', form), onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }) });
  const runJob = useMutation({ mutationFn: (name: string) => api.post<{ ok: boolean; summary?: string; error?: string }>(`/jobs/${name}/run`), onSuccess: () => qc.invalidateQueries({ queryKey: ['status'] }) });
  const disconnect = useMutation({ mutationFn: (p: string) => api.post(`/auth/${p}/disconnect`), onSuccess: () => qc.invalidateQueries({ queryKey: ['status'] }) });
  const [msg, setMsg] = useState('');
  const styleAction = useMutation({
    mutationFn: (v: { url: string; body?: unknown }) => api.post<{ imported?: number; profile?: string }>(v.url, v.body),
    onSuccess: (r) => {
      setMsg(r.imported !== undefined ? `${r.imported} 件を取り込みました` : 'プロファイルを生成しました');
      qc.invalidateQueries({ queryKey: ['style'] });
    },
    onError: (e) => setMsg((e as Error).message),
  });
  const [profileChannel, setProfileChannel] = useState<'all' | 'gmail' | 'line' | 'chatwork'>('gmail');
  const [profile, setProfile] = useState('');
  useEffect(() => {
    if (style.data) setProfile(style.data.profiles[profileChannel] ?? '');
  }, [style.data, profileChannel]);
  const saveProfile = useMutation({ mutationFn: () => api.put('/style/profile', { channel: profileChannel, markdown: profile }), onSuccess: () => { setMsg('プロファイルを保存しました'); qc.invalidateQueries({ queryKey: ['style'] }); } });
  const PROFILE_TABS: { key: 'all' | 'gmail' | 'line' | 'chatwork'; label: string }[] = [
    { key: 'gmail', label: 'Gmail' },
    { key: 'line', label: 'LINE' },
    { key: 'chatwork', label: 'Chatwork' },
    { key: 'all', label: '全体（共通）' },
  ];
  const [importText, setImportText] = useState('');
  const [importChannel, setImportChannel] = useState('line');
  const [pw, setPw] = useState({ current: '', next: '' });
  const changePw = useMutation({ mutationFn: () => api.post('/auth/password', pw), onSuccess: () => { setMsg('パスワードを変更しました'); setPw({ current: '', next: '' }); }, onError: (e) => setMsg((e as Error).message) });
  const backup = useQuery({ queryKey: ['backup'], queryFn: () => api.get<BackupInfo>('/backup') });
  const [backupMsg, setBackupMsg] = useState('');
  const runBackup = useMutation({
    mutationFn: () => api.post<{ file: string; size: number; remote: { path: string } | null }>('/backup/run'),
    onSuccess: (r) => {
      setBackupMsg(r.remote ? `${r.file} を OneDrive（${r.remote.path}）に保存しました` : `${r.file} をサーバー内に保存しました（OneDrive 未接続のため OneDrive には保存していません）`);
      qc.invalidateQueries({ queryKey: ['backup'] });
      qc.invalidateQueries({ queryKey: ['status'] });
    },
    onError: (e) => setBackupMsg((e as Error).message),
  });
  const [demoMsg, setDemoMsg] = useState('');
  const demo = useMutation({
    mutationFn: (action: 'seed' | 'clear') => api.post<{ ok: boolean; clients?: number; deleted?: number }>(`/demo/${action}`),
    onSuccess: (r, action) => {
      setDemoMsg(action === 'seed' ? `デモデータを投入しました（依頼者 ${r.clients} 名）。受信箱・事件・タスク・要確認を見てみてください。` : `デモデータを削除しました（${r.deleted} 行）`);
      qc.invalidateQueries();
    },
    onError: (e) => setDemoMsg((e as Error).message),
  });
  const s = status.data;
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">設定</h1>
      {s && (
        <section className="card">
          <h2 className="mb-3 font-semibold">接続状況</h2>
          <div className="grid gap-3 text-sm md:grid-cols-2">
            <Conn ok={s.google.connected} label="Google（Gmail・カレンダー）" detail={s.google.connected ? s.google.account ?? '接続済' : s.google.configured ? '未接続' : '.env に GOOGLE_CLIENT_ID/SECRET を設定してください'}>
              {s.google.configured && !s.google.connected && (
                <a className="btn btn-primary btn-sm" href="/api/auth/google/start">
                  Google に接続
                </a>
              )}
              {s.google.connected && (
                <button className="btn btn-sm" onClick={() => disconnect.mutate('google')}>
                  切断
                </button>
              )}
              <div className="text-xs text-slate-500">リダイレクト URI: {s.google.redirectUri}</div>
            </Conn>
            <Conn ok={s.microsoft.connected} label="OneDrive for Business" detail={s.microsoft.connected ? s.microsoft.account ?? '接続済' : s.microsoft.configured ? '未接続' : '.env に MS_TENANT_ID/CLIENT_ID/SECRET を設定してください'}>
              {s.microsoft.configured && !s.microsoft.connected && (
                <a className="btn btn-primary btn-sm" href="/api/auth/microsoft/start">
                  Microsoft に接続
                </a>
              )}
              {s.microsoft.connected && (
                <button className="btn btn-sm" onClick={() => disconnect.mutate('microsoft')}>
                  切断
                </button>
              )}
              <div className="text-xs text-slate-500">
                ストレージ: {s.storage} / リダイレクト URI: {s.microsoft.redirectUri}
              </div>
            </Conn>
            <Conn ok={s.line.configured} label="LINE公式アカウント" detail={s.line.configured ? `今月の送信 ${s.line.quota?.used ?? 0} / ${s.line.quota?.limit ?? 0}` : '.env に LINE_CHANNEL_SECRET / ACCESS_TOKEN を設定'}>
              <div className="text-xs text-slate-500">Webhook URL: {s.line.webhookUrl}</div>
              {s.line.configured && (
                <div className="mt-1 text-xs">
                  <div className={s.line.lastEventAt ? 'text-green-700' : 'text-orange-700'}>
                    {s.line.lastEventAt
                      ? `最後にメッセージを受信: ${fmtDateTime(s.line.lastEventAt)}`
                      : s.line.lastWebhookAt
                        ? `Webhook の疎通は確認済み（${fmtDateTime(s.line.lastWebhookAt)}）。まだメッセージは届いていません`
                        : 'Webhook をまだ一度も受信していません。LINE Developers の「Webhook の利用」と、Official Account Manager 応答設定の「Webhook」が ON か確認してください'}
                  </div>
                  {s.line.lastError && <div className="text-red-600">直近のエラー: {s.line.lastError}</div>}
                </div>
              )}
            </Conn>
            <Conn ok={s.chatwork.configured} label="Chatwork" detail={s.chatwork.configured ? (s.chatwork.webhookTokenSet ? 'API・Webhook 設定済' : 'Webhook トークン未設定（ポーリングのみ）') : '.env に CHATWORK_API_TOKEN を設定'}>
              <div className="text-xs text-slate-500">Webhook URL: {s.chatwork.webhookUrl}</div>
            </Conn>
            <Conn ok={s.zoom.configured} label="Zoom" detail={s.zoom.configured ? 'Server-to-Server OAuth 設定済' : '.env に ZOOM_ACCOUNT_ID / CLIENT_ID / SECRET を設定'} />
            <Conn ok={s.anthropic.configured} label="Claude（Anthropic API）" detail={s.anthropic.configured ? `モデル: ${s.anthropic.model}` : '.env に ANTHROPIC_API_KEY を設定'} />
          </div>
        </section>
      )}

      <section className="card">
        <h2 className="mb-1 font-semibold">文体学習</h2>
        <p className="mb-2 text-xs text-slate-500">
          チャネルごとに文体を分けて学習します。返信の下書きは、そのチャネルのプロファイルと、そのチャネルで実際に送った文面だけを手本にします（サンプルが 5 件未満のチャネルは共通の分析で補います）。LINE と Chatwork のサンプルは、このアプリから送るたびに自動で増えます。プロファイルはサンプルが増えると毎晩自動で更新されます。
        </p>
        <div className="mb-2 text-sm text-slate-600">
          サンプル {style.data?.stats.total ?? 0} 件（{Object.entries(style.data?.stats.byChannel ?? {}).map(([k, v]) => `${k}: ${v}`).join(' / ') || 'なし'}）
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-sm" onClick={() => styleAction.mutate({ url: '/style/import/gmail', body: { maxMessages: 300 } })} disabled={styleAction.isPending}>
            Gmail 送信済みを取込（直近300通）
          </button>
          <button className="btn btn-sm" onClick={() => styleAction.mutate({ url: '/style/import/chatwork' })} disabled={styleAction.isPending}>
            Chatwork の自分の発言を取込
          </button>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-1">
              {PROFILE_TABS.map((t) => (
                <button key={t.key} type="button" className={`btn btn-sm ${profileChannel === t.key ? 'btn-primary' : ''}`} onClick={() => setProfileChannel(t.key)}>
                  {t.label}
                  <span className={profileChannel === t.key ? 'opacity-80' : 'text-slate-400'}>{t.key === 'all' ? style.data?.stats.total ?? 0 : style.data?.stats.byChannel[t.key] ?? 0}</span>
                </button>
              ))}
            </div>
            <label className="label">
              {PROFILE_TABS.find((t) => t.key === profileChannel)?.label} の文体プロファイル（編集可）
              {style.data?.stats.profiles?.find((p) => p.channel === profileChannel)?.generatedAt ? <span className="ml-1 text-slate-400">（生成 {fmtDateTime(style.data.stats.profiles.find((p) => p.channel === profileChannel)!.generatedAt)}）</span> : <span className="ml-1 text-orange-600">（未生成）</span>}
            </label>
            <textarea className="input min-h-48 font-mono text-xs" value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="「生成」を押すと、このチャネルで送った文面から文体の特徴をまとめます" />
            <div className="mt-1 flex flex-wrap gap-2">
              <button className="btn btn-primary btn-sm" onClick={() => styleAction.mutate({ url: '/style/profile', body: { channel: profileChannel } })} disabled={styleAction.isPending || (profileChannel !== 'all' && (style.data?.stats.byChannel[profileChannel] ?? 0) < 5)}>
                {styleAction.isPending ? '処理中…' : `${PROFILE_TABS.find((t) => t.key === profileChannel)?.label} のプロファイルを生成`}
              </button>
              <button className="btn btn-sm" onClick={() => saveProfile.mutate()}>
                編集を保存
              </button>
            </div>
          </div>
          <div>
            <label className="label">過去の文面を手動で取込（空行区切りで複数）</label>
            <select className="input mb-1 w-auto" value={importChannel} onChange={(e) => setImportChannel(e.target.value)}>
              <option value="line">LINE</option>
              <option value="chatwork">Chatwork</option>
              <option value="gmail">Gmail</option>
            </select>
            <textarea className="input min-h-32 text-xs" value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="LINE のトーク履歴から自分の発言をコピーして貼り付け" />
            <button className="btn btn-sm mt-1" onClick={() => { styleAction.mutate({ url: '/style/import/text', body: { channel: importChannel, text: importText } }); setImportText(''); }} disabled={!importText.trim()}>
              取込
            </button>
          </div>
        </div>
        {msg && <div className="mt-2 text-sm text-slate-700">{msg}</div>}
      </section>

      <section className="card">
        <h2 className="mb-3 font-semibold">基本設定</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {FIELDS.map((f) => (
            <div key={f.key} className={f.multiline ? 'md:col-span-2' : ''}>
              <label className="label">
                {f.label}
                {f.hint && <span className="ml-1 font-normal text-slate-400">（{f.hint}）</span>}
              </label>
              {f.options ? (
                <select className="input" value={form[f.key] ?? f.options[0].value} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}>
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.multiline ? (
                <textarea className="input" rows={3} value={form[f.key] ?? ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
              ) : (
                <input className="input" value={form[f.key] ?? ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
              )}
            </div>
          ))}
        </div>
        <button className="btn btn-primary mt-3" onClick={() => save.mutate()} disabled={save.isPending}>
          保存
        </button>
      </section>

      <section className="card">
        <h2 className="mb-1 font-semibold">通知の文面</h2>
        <p className="mb-3 text-xs text-slate-500">Chatwork マイチャットに届く朝のダイジェストと要確認の通知の文面です。返信の催促文や期日報告は文体エンジンが作るため、ここでは変えません。</p>
        <div className="grid gap-3 md:grid-cols-2">
          {NOTIFY_FIELDS.map((f) => (
            <div key={f.key} className={f.multiline ? 'md:col-span-2' : ''}>
              <label className="label">
                {f.label}
                {f.hint && <span className="ml-1 text-slate-400">（{f.hint}）</span>}
              </label>
              {f.multiline ? <textarea className="input" rows={2} value={form[f.key] ?? ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} /> : <input className="input" value={form[f.key] ?? ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />}
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
            保存
          </button>
          <button className="btn" onClick={() => runJob.mutate('morningDigest')} disabled={runJob.isPending || !s?.chatwork.configured}>
            ダイジェストを今すぐ送って確認
          </button>
        </div>
      </section>

      <section className="card">
        <h2 className="mb-1 font-semibold">バックアップ</h2>
        <p className="mb-3 text-xs text-slate-500">
          毎日 3:00（JST）にデータベースのスナップショットを圧縮し、サーバー内と OneDrive の <code>{backup.data?.remoteFolder ?? '…'}</code> に世代保存します。復元手順は手順書（deploy.md）を参照してください。
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          {BACKUP_FIELDS.map((f) => (
            <div key={f.key}>
              <label className="label">{f.label}</label>
              <input className="input" value={form[f.key] ?? ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
            保存
          </button>
          <button className="btn" onClick={() => runBackup.mutate()} disabled={runBackup.isPending}>
            {runBackup.isPending ? '作成中…' : '今すぐバックアップ'}
          </button>
          {backupMsg && <span className="text-xs text-slate-700">{backupMsg}</span>}
        </div>
        {backup.data && backup.data.local.length > 0 && (
          <div className="mt-3 text-xs">
            <div className="mb-1 text-slate-500">サーバー内の世代（クリックでダウンロード）</div>
            <ul className="flex flex-wrap gap-2">
              {backup.data.local.map((b) => (
                <li key={b.name}>
                  <a className="btn btn-sm" href={`/api/backup/${b.name}`}>
                    {b.name}（{fmtBytes(b.size)}）
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="mb-1 font-semibold">デモデータ</h2>
        <p className="mb-3 text-xs text-slate-500">
          架空の依頼者 3 名（離婚調停・交通事故・法人破産）と会話・タスク・期日・債権者・要確認を投入して、接続前に操作感を確かめられます。実データとは混ざらず、ワンクリックで消せます。名前には【デモ】が付きます。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {s?.demo.seeded ? (
            <>
              <span className="badge badge-orange">デモデータ表示中</span>
              <button className="btn" onClick={() => demo.mutate('clear')} disabled={demo.isPending}>
                デモデータを削除
              </button>
              <button className="btn btn-sm" onClick={() => demo.mutate('seed')} disabled={demo.isPending}>
                入れ直す
              </button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={() => demo.mutate('seed')} disabled={demo.isPending}>
              {demo.isPending ? '投入中…' : 'デモデータを投入'}
            </button>
          )}
          {demoMsg && <span className="text-xs text-slate-700">{demoMsg}</span>}
        </div>
      </section>

      {s && (
        <section className="card">
          <h2 className="mb-3 font-semibold">バックグラウンド処理</h2>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr>
                <th className="py-1">処理</th>
                <th className="py-1">スケジュール(UTC)</th>
                <th className="py-1">最終実行</th>
                <th className="py-1"></th>
              </tr>
            </thead>
            <tbody>
              {s.jobs.map((j) => (
                <tr key={j.name} className="border-t border-slate-100">
                  <td className="py-1">
                    {j.label} {!j.enabled && <span className="badge badge-gray">無効（未接続）</span>}
                  </td>
                  <td className="py-1 font-mono text-xs">{j.cron}</td>
                  <td className="py-1 text-xs">
                    {j.last ? (
                      <>
                        <span className={j.last.ok ? 'text-green-700' : 'text-red-600'}>{j.last.ok ? '成功' : '失敗'}</span> {fmtDateTime(j.last.startedAt)}
                        <div className="line-clamp-1 text-slate-500">{j.last.summary ?? j.last.error}</div>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="py-1 text-right">
                    <button className="btn btn-sm" onClick={() => runJob.mutate(j.name)} disabled={runJob.isPending || j.running}>
                      今すぐ実行
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {runJob.data && <div className="mt-2 text-xs text-slate-600">{runJob.data.ok ? `完了: ${runJob.data.summary}` : `失敗: ${runJob.data.error}`}</div>}
        </section>
      )}

      <section className="card">
        <h2 className="mb-1 font-semibold">ログイン</h2>
        <p className="mb-3 text-xs text-slate-500">
          Google のクライアント ID を設定すると、ログイン画面に「Google アカウントでログイン」が出ます。許可するアドレスが空のときは「Google に接続」したアカウント
          {s?.google.account ? `（${s.google.account}）` : ''}だけがログインできます。パスワードでのログインも引き続き使えます。
        </p>
        <label className="label">Google ログインを許可するメールアドレス（複数は改行）</label>
        <textarea className="input" rows={2} value={form.login_google_emails ?? ''} onChange={(e) => setForm({ ...form, login_google_emails: e.target.value })} placeholder={s?.google.account ?? 'example@gmail.com'} />
        <button className="btn btn-primary mt-3" onClick={() => save.mutate()} disabled={save.isPending}>
          保存
        </button>
      </section>

      <section className="card">
        <h2 className="mb-3 font-semibold">パスワード変更</h2>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label">現在</label>
            <input type="password" className="input" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          </div>
          <div>
            <label className="label">新しいパスワード（8文字以上）</label>
            <input type="password" className="input" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          </div>
          <button className="btn" onClick={() => changePw.mutate()} disabled={!pw.current || pw.next.length < 8}>
            変更
          </button>
        </div>
      </section>
    </div>
  );
}

function Conn({ ok, label, detail, children }: { ok: boolean; label: string; detail: string; children?: React.ReactNode }) {
  return (
    <div className="rounded border border-slate-200 p-3">
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? 'bg-green-500' : 'bg-slate-300'}`} />
        <span className="font-medium">{label}</span>
        <span className="text-xs text-slate-500">{detail}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
