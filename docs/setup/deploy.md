# デプロイ手順（Docker）

アプリは 1 つのコンテナで動きます。LINE と Chatwork の Webhook を受けるため、**HTTPS の公開 URL** が必要です。

## 選択肢

| 方式 | 向いている場合 | 公開 URL |
|---|---|---|
| A. 事務所 PC（Docker Desktop）＋ Cloudflare Tunnel | 追加費用をかけたくない。PC を常時起動できる | Cloudflare Zero Trust のトンネル |
| B. Fly.io などのクラウド（ボリューム付き） | PC を落としても受信を止めたくない | クラウドが発行する URL |

どちらも OneDrive へは Microsoft Graph API 経由で書き込むため、PC の同期フォルダは不要です（A で同期フォルダに直接書きたい場合は `STORAGE_BACKEND=local` にして `docker-compose.yml` のボリュームを有効にします）。

## 共通の準備

1. リポジトリを取得し、`.env.example` を `.env` にコピー
2. 各サービスのキーを取得して `.env` に記入
   - [LINE公式アカウント](line.md)
   - [Chatwork](chatwork.md)
   - [Google（Gmail・カレンダー）](google.md)
   - [Zoom](zoom.md)
   - [OneDrive for Business](onedrive.md)
   - Anthropic: [Console](https://console.anthropic.com/) で API キーを発行し `ANTHROPIC_API_KEY` に設定
3. `APP_PASSWORD`（ログイン用）と `SESSION_SECRET`（32 文字以上のランダム文字列）を設定
4. `PUBLIC_BASE_URL` に公開 URL（末尾スラッシュなし）を設定。Google / Microsoft のリダイレクト URI はこの URL を基に作られます

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
