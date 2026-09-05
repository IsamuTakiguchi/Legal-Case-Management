# デプロイ手順（Docker）

アプリは 1 つのコンテナで動きます。LINE と Chatwork の Webhook を受けるため、**HTTPS の公開 URL** が必要です。

## 選択肢

| 方式 | 向いている場合 | 公開 URL | 手間 |
|---|---|---|---|
| **A. Railway（推奨）** | PC に何も入れたくない。月額 5 ドル程度（Hobby プラン、従量） | Railway が自動発行（https://…up.railway.app） | ブラウザで数クリック |
| B. Render.com | Railway と同程度の手軽さ。固定料金（月 7 ドル＋ディスク） | Render が自動発行（https://…onrender.com） | ブラウザで数クリック |
| C. 事務所 PC（Docker Desktop）＋ Cloudflare Tunnel | 追加費用をかけたくない。PC を常時起動できる | Cloudflare Zero Trust のトンネル | Docker と Cloudflare の設定が必要 |
| D. Fly.io（ボリューム付き） | CLI 操作に抵抗がない | Fly.io が自動発行 | CLI のインストールが必要 |

いずれも OneDrive へは Microsoft Graph API 経由で書き込むため、PC の同期フォルダは不要です（C で同期フォルダに直接書きたい場合は `STORAGE_BACKEND=local` にして `docker-compose.yml` のボリュームを有効にします）。

## A. Railway（推奨）

Dockerfile をそのまま使います（`railway.json` がビルド方法とヘルスチェックを指定しています）。データ保存用の Volume を使うため **Hobby プラン**（月 5 ドル、5 ドル分の使用量込み）が必要です。無料枠のままでは Volume が付けられず、再デプロイでデータが消えます。

1. [Railway](https://railway.com/) にログインし、GitHub を連携
2. **New Project → Deploy from GitHub repo** → このリポジトリを選択
3. 作成されたサービスを開き、**Settings → Source → Branch** を `claude/unified-communication-manager-cidsxx` にする（既定ブランチのままだと空のビルドになります）
4. **Variables** に `APP_PASSWORD` = ログイン用パスワード（自分で決める）を追加。これ以外の変数は不要です（`PORT` `DATA_DIR` `TZ` は Dockerfile で設定済み、`SESSION_SECRET` は初回起動時に自動生成して Volume に保存、公開 URL は Railway の `RAILWAY_PUBLIC_DOMAIN` から自動認識）
5. サービスを右クリック → **Add Volume** → Mount Path を `/data` にする
6. **Settings → Networking → Generate Domain** → ポートを `8787` にする。`https://xxxx.up.railway.app` の URL が付きます
7. Deploy が緑になったらその URL を開いてログイン → 左メニュー **初期設定** からキーを登録（下の「初回セットアップ」参照）

補足:

- 変数や Volume を追加すると自動で再デプロイされます。数分待ってから URL を開いてください
- Generate Domain のポート入力に 8787 以外が表示される場合は、Variables に `PORT` = `8787` を追加してから再度設定してください
- Volume の内容（`/data/app.db` と `/data/session_secret`）がすべてのデータです。Railway の Volume 画面からバックアップ（スナップショット）を取れます
- リージョンは Settings → Deploy → Region で **Southeast Asia (Singapore)** を選ぶと日本から最も近くなります

## B. Render.com

1. [Render](https://dashboard.render.com/) にアカウントを作成し、GitHub を連携
2. New → **Blueprint** → このリポジトリを選択 → ブランチ `claude/unified-communication-manager-cidsxx` を指定（`render.yaml` を自動で読み込みます）
3. `APP_PASSWORD`（ログイン用パスワード）だけ入力して Apply
4. 数分でビルドが終わり、`https://legal-case-management-xxxx.onrender.com` の URL が付きます。これが公開 URL で、アプリはこの URL を自動で認識します
5. その URL を開いてログイン → 「初期設定」からキーを登録

ディスク（5GB）付きの Starter プランになります。データはこのディスクに保存され、再デプロイしても消えません。

## C. 事務所 PC ＋ Cloudflare Tunnel

最短手順:

1. リポジトリを取得（ブランチ `claude/unified-communication-manager-cidsxx`）
2. 起動スクリプトを実行（ログイン用パスワードを聞かれます）
   - Windows: PowerShell で `scripts\setup.ps1`
   - Mac / Linux: `bash scripts/setup.sh`
3. ブラウザで `http://localhost:8787` を開いてログイン → 左メニュー **初期設定**

公開 URL を付ける場合:

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

手動で `.env` を用意する場合は `.env.example` をコピーし、`APP_PASSWORD`（ログイン用）と `PUBLIC_BASE_URL`（公開 URL、末尾スラッシュなし）を設定します。`SESSION_SECRET` は未設定なら自動生成されます。Google / Microsoft のリダイレクト URI と Webhook URL は公開 URL を基に作られます（初期設定画面からも変更可）。

## D. Fly.io

```bash
fly launch --no-deploy            # 既存の Dockerfile と fly.toml を使う
fly volumes create app_data --size 3
fly secrets set APP_PASSWORD=...
fly deploy
```

公開 URL は `FLY_APP_NAME` から自動で認識します。

## キーの登録（共通）

デプロイ後、アプリの **初期設定** 画面に各サービスのキーを貼り付けて「保存」→「接続テスト」。Google と Microsoft は保存後に「接続」ボタンで同意します。初期設定画面に表示される Webhook URL を LINE Developers と Chatwork に登録します。

キーの取得方法は各手順書を参照してください: [LINE公式](line.md) / [Chatwork](chatwork.md) / [Google](google.md) / [Zoom](zoom.md) / [OneDrive](onedrive.md)。Anthropic は [Console](https://console.anthropic.com/) で API キーを発行します。

`.env` に直接書く方法も引き続き使えます（環境変数より画面で保存した値が優先されます）。

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
