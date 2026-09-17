# Zoom の設定（Server-to-Server OAuth）

**Zoom の設定は任意です。** Google に接続済みであれば、WEB 相談の確定時に Google Meet の会議 URL をカレンダーの予定に自動で付け、その URL を依頼者へ送ります。Zoom を使いたい場合だけ以下を設定してください（設定すると Zoom が優先されます。設定画面の「WEB 会議の提供元」で切り替え可能）。

## 1. 権限の確認

Server-to-Server OAuth アプリを作るには、Zoom アカウントのオーナー（または管理者）ロールで「Server-to-Server OAuth app」の権限が有効になっている必要があります。

- Zoom Web ポータル → 管理 → ユーザー管理 → 役割 → 対象の役割 → 「Advanced」→ **Server-to-Server OAuth app** を有効化

## 2. アプリの作成

1. [Zoom App Marketplace](https://marketplace.zoom.us/) → Develop → **Build App** → **Server-to-Server OAuth**
2. アプリ名を入力（例: T-Lex）
3. App Credentials に表示される **Account ID / Client ID / Client Secret** を `.env` の `ZOOM_ACCOUNT_ID` / `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` に設定
4. Scopes で以下を追加
   - `meeting:write:meeting:admin`（または `meeting:write:admin`）
   - `meeting:read:meeting:admin`
5. **Activate** する

## 3. 動作

会議 URL が発行されるのは次の 3 か所です。いずれも毎回新しい URL を作り、使い回しません。

| どこから | いつ発行されるか |
|---|---|
| 受信箱の「日程調整」 | 「WEB」を選んで確定したとき |
| 受信箱の「会話から予定を登録」で **確定として登録** | 登録と同時。予定の説明欄に URL が入り、その場で返信欄に貼り付けられます |
| 受信箱の「会話から予定を登録」で **候補を仮押さえ** | 候補の段階では作りません。「この候補で確定」を押したときに、確定した 1 件についてだけ作ります |

- 待機室 ON、ホスト前の入室不可、入室時ミュートで作成されます
- 無料（Basic）プランでは 1 回 40 分の制限があります

### Zoom を設定していないとき

Google に接続していれば Google Meet の会議 URL が同じ場所で発行されます。どちらも無い場合は会議 URL は作らず、予定の場所に「WEB会議」とだけ入ります（URL は手で入れてください）。

どちらを使うかは 設定 →「WEB 会議の提供元」で切り替えられます（自動 / Zoom / Google Meet）。
