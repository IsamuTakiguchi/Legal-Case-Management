#!/usr/bin/env bash
# Mac / Linux 用: .env を作成して Docker で起動する
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker がインストールされていません。https://www.docker.com/products/docker-desktop/ から Docker Desktop を入れてください。"
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  SECRET=$(openssl rand -base64 48 | tr -d '\n=/+' | cut -c1-48)
  read -r -p "ログイン用パスワードを決めてください（8文字以上）: " PW
  read -r -p "公開 URL（未定なら空のまま Enter。後で初期設定画面から設定できます）: " URL
  sed -i.bak "s#^SESSION_SECRET=.*#SESSION_SECRET=${SECRET}#" .env
  sed -i.bak "s#^APP_PASSWORD=.*#APP_PASSWORD=${PW}#" .env
  if [ -n "${URL}" ]; then sed -i.bak "s#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=${URL}#" .env; fi
  rm -f .env.bak
  echo ".env を作成しました。API キーはブラウザの「初期設定」画面から入力できます。"
fi

PROFILE=""
if grep -q '^CLOUDFLARE_TUNNEL_TOKEN=.\+' .env 2>/dev/null; then PROFILE="--profile tunnel"; fi
docker compose $PROFILE up -d --build
echo
echo "起動しました。ブラウザで http://localhost:8787 を開き、.env の APP_PASSWORD でログインしてください。"
echo "左メニューの「初期設定」から各サービスのキーを登録します。"
