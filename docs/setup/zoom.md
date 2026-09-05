# Zoom の設定（Server-to-Server OAuth）

**Zoom の設定は任意です。** Google に接続済みであれば、WEB 相談の確定時に Google Meet の会議 URL をカレンダーの予定に自動で付け、その URL を依頼者へ送ります。Zoom を使いたい場合だけ以下を設定してください（設定すると Zoom が優先されます。設定画面の「WEB 会議の提供元」で切り替え可能）。

## 1. 権限の確認

Server-to-Server OAuth アプリを作るには、Zoom アカウントのオーナー（または管理者）ロールで「Server-to-Server OAuth app」の権限が有効になっている必要があります。

- Zoom Web ポータル → 管理 → ユーザー管理 → 役割 → 対象の役割 → 「Advanced」→ **Server-to-Server OAuth app** を有効化

## 2. アプリの作成

1. [Zoom App Marketplace](https://marketplace.zoom.us/) → Develop → **Build App** → **Server-to-Server OAuth**
2. アプリ名を入力（例: 事務所アプリ）
3. App Credentials に表示される **Account ID / Client ID / Client Secret** を `.env` の `ZOOM_ACCOUNT_ID` / `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` に設定
4. Scopes で以下を追加
   - `meeting:write:meeting:admin`（または `meeting:write:admin`）
   - `meeting:read:meeting:admin`
5. **Activate** する

## 3. 動作

- 日程調整で「WEB」を選んで確定すると、その日時でミーティングを新規作成し、URL とパスコードを確定文に差し込みます（毎回新しい URL を発行し、使い回しません）
- 待機室 ON、ホスト前の入室不可、入室時ミュートで作成されます
- 無料（Basic）プランでは 1 回 40 分の制限があります
