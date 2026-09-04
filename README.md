# 統合コミュニケーション管理（Legal Case Management）

LINE公式アカウント・Chatwork・Gmail に分散した依頼者とのやり取りを 1 つの画面で管理し、添付ファイルの OneDrive 振り分け、自分の文体での返信下書き、日程調整（仮押さえ・Zoom）、返信待ちリマインド、次回期日の入力漏れ確認、事件の進捗・電話記録、書式ライブラリ、債権者管理までを行う、法律事務所向けの自己ホスト型 Web アプリです。

## できること

| 機能 | 概要 |
|---|---|
| 統合受信箱 | 3 チャネルの受信・送信を依頼者ごとに時系列表示。未紐付けの連絡先は候補を提示して紐付け |
| 添付の自動振り分け | 受信した画像・ファイルを OneDrive for Business の依頼者フォルダ（`受領資料/`）へ保存。依頼者不明なら `_未振分/` に置いて確認を促す |
| 自分らしい返信下書き | 過去の送信文（Gmail 送信済み・Chatwork・LINE）から文体プロファイルを作り、類似する過去返信を参照して Claude が下書き。送信時に編集内容を再学習 |
| 日程調整 | Google カレンダーの空きから候補を提示し「{姓} {内容} 仮」で仮押さえ。確定時に他の仮押さえを削除、WEB なら Zoom を発行して URL・パスコードを送信 |
| 期日報告 | 依頼者フォルダの提出書面（PDF）を選んで、結果と一緒に依頼者のチャネルへ送信（LINE は共有リンク） |
| 返信待ちリマインド | 「依頼者待ち／相手方待ち」のタスクを持ち、期限超過を Chatwork マイチャットとアプリに通知。返信が来たら自動で解除 |
| 次回期日チェック | 期日・打合せが終わった後、次回期日がカレンダーにないと確認を促し、その場で登録できる |
| 事件管理 | 事件類型・段階・方針メモ・タイムライン。電話メモを Claude が要旨／決定事項／次のアクションに整理してタスク化 |
| 書式ライブラリ | OneDrive の書式フォルダと依頼者フォルダの書面を索引化し、類型・種別・本文で検索。選んだ書式を雛形に Word の下書きを生成 |
| 債権者管理 | 破産・再生事件で債権者ごとの段階・最終接触・次のアクションを管理。Excel 取込／出力、Gmail の自動紐付け、期限超過アラート |

## 構成

- `apps/server` … Hono + SQLite（Drizzle）+ croner。チャネルアダプタ、各種連携、ジョブ、API
- `apps/web` … React + Vite + Tailwind の管理画面（日本語）
- `packages/shared` … 型・zod スキーマ・日付ユーティリティ
- `docs/setup/` … 各サービスの API 登録手順

## セットアップ（概要）

1. Docker Desktop を入れて、`scripts/setup.ps1`（Windows）または `scripts/setup.sh`（Mac）を実行
2. ブラウザで `http://localhost:8787` を開き、決めたパスワードでログイン
3. 左メニューの **初期設定** で各サービスのキーを貼り付け → 保存 → 接続テスト（Google / Microsoft は「接続」ボタンで同意）
4. 初期設定画面に表示される Webhook URL を LINE Developers と Chatwork に登録
5. 設定画面で「Gmail 送信済みを取込」→「文体プロファイルを生成」

キーの取得手順は [docs/setup](docs/setup/) にあります。

詳細は [docs/setup/deploy.md](docs/setup/deploy.md) を参照してください。

## 開発

```bash
pnpm install
cp .env.example .env
pnpm dev          # server: http://localhost:8787, web: http://localhost:5173
pnpm test         # vitest
pnpm typecheck
pnpm build
```

## 注意事項

- LINE Messaging API はファイルを送信できません。PDF などは OneDrive の共有リンクとして送るか、LINE公式アカウントの管理画面から手動で送付します。
- LINE への返信は push メッセージとして通数を消費します（ライトプラン 5,000 通／月）。設定画面に当月の送信数を表示します。
- Gmail の OAuth 同意画面を「テスト」のまま運用するとトークンが 7 日で失効します。Workspace なら「内部」、個人アカウントなら「本番」に公開してください。
- 依頼者の情報を扱うため、管理画面の URL は Cloudflare Access などで保護することを推奨します。
