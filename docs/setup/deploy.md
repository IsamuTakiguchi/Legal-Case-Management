# デプロイ手順（Docker）

アプリは 1 つのコンテナで動きます。LINE と Chatwork の Webhook を受けるため、**HTTPS の公開 URL** が必要です。

## 選択肢

| 方式 | 向いている場合 | 公開 URL | 手間 |
|---|---|---|---|
| **C. Render.com（推奨・最も手間が少ない）** | PC に何も入れたくない。月額 7 ドル程度は許容できる | Render が自動発行（https://…onrender.com） | ブラウザで数クリック |
| **D. Railway** | Render と同程度の手軽さ。月額 5 ドル〜（従量） | Railway が自動発行（https://…up.railway.app） | ブラウザで数クリック（ボリュームの追加が 1 手順多い） |
| A. 事務所 PC（Docker Desktop）＋ Cloudflare Tunnel | 追加費用をかけたくない。PC を常時起動できる | Cloudflare Zero Trust のトンネル | Docker と Cloudflare の設定が必要 |
| B. Fly.io（ボリューム付き） | CLI 操作に抵抗がない | Fly.io が自動発行 | CLI のインストールが必要 |

## C. Render.com（推奨）

1. [Render](https://dashboard.render.com/) にアカウントを作成し、GitHub を連携
2. New → **Blueprint** → このリポジトリを選択 → ブランチ `claude/unified-communication-manager-cidsxx` を指定（`render.yaml` を自動で読み込みます）
3. `APP_PASSWORD`（ログイン用パスワード）だけ入力して Apply
4. 数分でビルドが終わり、`https://legal-case-management-xxxx.onrender.com` の URL が付きます。これが公開 URL で、アプリはこの URL を自動で認識します
5. その URL を開いてログイン → 「初期設定」からキーを登録

ディスク（5GB）付きの Starter プランになります。データはこのディスクに保存され、再デプロイしても消えません。

## D. Railway

Render と同じく Dockerfile をそのまま使えます。ディスク（Volume）を使うため Hobby プラン（月 5 ドル、使用量込み）が必要です。

1. [Railway](https://railway.com/) にアカウントを作成し、GitHub を連携
2. New Project → **Deploy from GitHub repo** → このリポジトリを選択。Settings → Source → Branch を `claude/unified-communication-manager-cidsxx` にする（`railway.json` が自動で読まれ、Dockerfile でビルドされます）
3. サービスの **Variables** に以下を追加
   - `APP_PASSWORD` = ログイン用パスワード（自分で決める）
   - `SESSION_SECRET` = 32 文字以上のランダム文字列（Variables 画面の「Generate」で生成可）
   - `PORT` = `8787`
   - `DATA_DIR` = `/data`
   - `TZ` = `Asia/Tokyo`
4. サービスを右クリック（または Command+K）→ **Add Volume** → Mount Path を `/data` にする（データ保存先。再デプロイしても消えません）
5. Settings → Networking → **Generate Domain** → ポートを `8787` にする。`https://xxxx.up.railway.app` の URL が付き、アプリはこの URL を自動で認識します（`RAILWAY_PUBLIC_DOMAIN` を参照）
6. その URL を開いてログイン → 「初期設定」からキーを登録

以降の手順（キーの貼り付け先、Webhook URL の登録）は Render と同じです。

どちらも OneDrive へは Microsoft Graph API 経由で書き込むため、PC の同期フォルダは不要です（A で同期フォルダに直接書きたい場合は `STORAGE_BACKEND=local` にして `docker-compose.yml` のボリュームを有効にします）。

## 最短手順（推奨）

1. リポジトリを取得（ブランチ `claude/unified-communication-manager-cidsxx`）
2. 起動スクリプトを実行（ログイン用パスワードを聞かれます）
   - Windows: PowerShell で `scripts\setup.ps1`
   - Mac / Linux: `bash scripts/setup.sh`
3. ブラウザで `http://localhost:8787` を開いてログイン → 左メニュー **初期設定**
4. 各サービスのキーを貼り付けて「保存」→「接続テスト」。Google と Microsoft は保存後に「接続」ボタンで同意
5. 初期設定画面に表示される Webhook URL を LINE Developers と Chatwork に登録

キーの取得方法は各手順書を参照してください: [LINE公式](line.md) / [Chatwork](chatwork.md) / [Google](google.md) / [Zoom](zoom.md) / [OneDrive](onedrive.md)。Anthropic は [Console](https://console.anthropic.com/) で API キーを発行します。

`.env` に直接書く方法も引き続き使えます（環境変数より画面で保存した値が優先されます）。

## 共通の準備（手動で行う場合）

1. `.env.example` を `.env` にコピー
2. `APP_PASSWORD`（ログイン用）と `SESSION_SECRET`（32 文字以上のランダム文字列）を設定
3. `PUBLIC_BASE_URL` に公開 URL（末尾スラッシュなし）を設定。Google / Microsoft のリダイレクト URI と Webhook URL はこの URL を基に作られます（初期設定画面からも変更可）

## A. 事務所 PC ＋ Cloudflare Tunnel

1. Docker Desktop をインストール
2. [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → Networks → Tunnels → Create a tunnel → Docker を選び、表示されるトークンを `.env` の `CLOUDFLARE_TUNNEL_TOKEN` に設定
3. トンネルの Public Hostname に `app.example.com` のようなホスト名を追加し、Service を `http://app:8787` にする
4. 起動:
   ```bash
   docker compose --profile tunnel up -d --build
   ```
5. `https://app.example.com` を開いてログイン
6. **推奨**: Zero Trust の Access → Applications で `app.example.com` を保護し、`/webhooks/*` だけ Bypass ポリシーにする（管理画面を外部から直接開けなくする）

PC を再起動しても `restart: unless-stopped` で自動起動します。

## B. Fly.io

```bash
fly launch --no-deploy            # 既存の Dockerfile を使う
fly volumes create app_data --size 3
fly secrets set $(cat .env | grep -v '^#' | xargs)
```

`fly.toml` に以下を追加してデプロイします。

```toml
[mounts]
  source = "app_data"
  destination = "/data"

[http_service]
  internal_port = 8787
  force_https = true
```

```bash
fly deploy
```

## 初回セットアップ（ブラウザ）

1. ログイン → **設定** → 「Google に接続」「Microsoft に接続」
2. 設定の「基本設定」で弁護士名・署名・営業時間・書式フォルダのパスなどを入力して保存
3. 「Gmail 送信済みを取込」→「文体プロファイルを生成」
4. LINE Developers と Chatwork に、設定画面に表示される Webhook URL を登録
5. **依頼者** を登録（メールアドレス・Chatwork ルーム・OneDrive フォルダ名）。LINE は最初の受信時に「未紐付け」として届くので、そこで紐付けます
6. バックグラウンド処理の「今すぐ実行」で Gmail 受信・カレンダー同期を試す

## バックアップ

- `/data/app.db`（SQLite）と `/data` 配下をそのままコピーすれば復元できます
- Docker ボリュームのバックアップ例:
  ```bash
  docker run --rm -v legal-case-management_app-data:/data -v "$PWD":/backup alpine tar czf /backup/lcm-backup.tgz /data
  ```

## 更新

```bash
git pull
docker compose up -d --build
```

マイグレーションは起動時に自動で適用されます。
