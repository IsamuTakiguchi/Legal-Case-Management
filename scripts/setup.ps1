# Windows (PowerShell) 用: .env を作成して Docker Desktop で起動する
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host "Docker Desktop がインストールされていません。https://www.docker.com/products/docker-desktop/ から入れてください。"
  exit 1
}

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  $bytes = New-Object byte[] 36; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $secret = ([Convert]::ToBase64String($bytes)) -replace '[^A-Za-z0-9]', ''
  $pw = Read-Host "ログイン用パスワードを決めてください（8文字以上）"
  $url = Read-Host "公開 URL（未定なら空のまま Enter。後で初期設定画面から設定できます）"
  $content = Get-Content ".env" -Raw
  $content = $content -replace "(?m)^SESSION_SECRET=.*$", "SESSION_SECRET=$secret"
  $content = $content -replace "(?m)^APP_PASSWORD=.*$", "APP_PASSWORD=$pw"
  if ($url) { $content = $content -replace "(?m)^PUBLIC_BASE_URL=.*$", "PUBLIC_BASE_URL=$url" }
  Set-Content ".env" $content -Encoding UTF8
  Write-Host ".env を作成しました。API キーはブラウザの「初期設定」画面から入力できます。"
}

$profile = @()
if (Select-String -Path ".env" -Pattern "^CLOUDFLARE_TUNNEL_TOKEN=.+" -Quiet) { $profile = @("--profile", "tunnel") }
docker compose @profile up -d --build
Write-Host ""
Write-Host "起動しました。ブラウザで http://localhost:8787 を開き、.env の APP_PASSWORD でログインしてください。"
Write-Host "左メニューの「初期設定」から各サービスのキーを登録します。"
