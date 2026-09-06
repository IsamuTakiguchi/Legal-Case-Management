/** 各サービスへの接続テスト（設定ウィザード用） */
import { env, isConfigured } from '../config.js';
import { anthropic, model } from '../integrations/anthropic.js';
import * as cw from '../channels/chatwork.js';
import { calendarApi, gmailApi, isGoogleConnected } from '../integrations/google.js';
import { isMsConnected, meProfile, listChildren } from '../integrations/onedrive.js';
import { createZoomMeeting, deleteZoomMeeting } from '../integrations/zoom.js';
import { lineAccessToken, registerLineWebhook } from './lineSetup.js';
import { statusFolderMap, guessStatusFolders } from './clientFolders.js';

export interface TestResult {
  ok: boolean;
  message: string;
  detail?: Record<string, unknown>;
}

export async function testService(id: string): Promise<TestResult> {
  try {
    switch (id) {
      case 'anthropic': {
        if (!isConfigured('anthropic')) return { ok: false, message: 'API キーが未設定です' };
        const res = await anthropic().messages.create({ model: model(), max_tokens: 20, messages: [{ role: 'user', content: '「接続OK」とだけ返してください。' }] });
        const text = res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
        return { ok: true, message: `応答: ${text.slice(0, 40)}`, detail: { model: res.model } };
      }
      case 'line': {
        if (!isConfigured('line')) return { ok: false, message: 'チャネル ID とチャネルシークレット（または長期トークン）が未設定です' };
        const token = await lineAccessToken();
        const res = await fetch('https://api.line.me/v2/bot/info', { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return { ok: false, message: `LINE API エラー ${res.status}: ${await res.text()}` };
        const j = (await res.json()) as { displayName?: string; basicId?: string; chatMode?: string; markAsReadMode?: string };
        const wh = await registerLineWebhook().catch((err) => ({ registered: false, testDetail: String((err as Error).message ?? err) }) as Awaited<ReturnType<typeof registerLineWebhook>>);
        const parts = [`${j.displayName ?? ''}（${j.basicId ?? ''}）に接続できました。`];
        parts.push(wh.registered ? `Webhook URL を自動登録しました（${wh.testDetail ?? ''}）。` : `Webhook 未登録: ${wh.testDetail ?? ''}`);
        if (wh.registered && wh.active === false) parts.push('LINE Developers の「Webhook の利用」を ON にしてください。');
        if (j.chatMode === 'bot') parts.push('LINE Official Account Manager の応答設定で「チャット」を ON にすると管理画面からも手動返信できます。');
        return { ok: true, message: parts.join(' '), detail: { ...j, webhook: wh } };
      }
      case 'chatwork': {
        if (!isConfigured('chatwork')) return { ok: false, message: 'API トークンが未設定です' };
        const me = await cw.chatworkMe();
        const room = await cw.myChatRoomId();
        return { ok: true, message: `${me.name} として接続できました。通知先ルーム ID: ${room ?? '未検出'}`, detail: { accountId: me.account_id, roomId: room } };
      }
      case 'google': {
        if (!isConfigured('google')) return { ok: false, message: 'OAuth クライアント ID／シークレットが未設定です' };
        if (!isGoogleConnected()) return { ok: false, message: '設定は保存済みです。「Google に接続」を押して同意してください' };
        const prof = await gmailApi().users.getProfile({ userId: 'me' });
        const cals = await calendarApi().calendarList.list({ maxResults: 5 });
        return { ok: true, message: `${prof.data.emailAddress} に接続できました。カレンダー ${cals.data.items?.length ?? 0} 件`, detail: { calendars: cals.data.items?.map((c) => ({ id: c.id, summary: c.summary })) } };
      }
      case 'microsoft': {
        if (!isConfigured('microsoft')) return { ok: false, message: 'テナント ID／クライアント ID／シークレットが未設定です' };
        if (!(await isMsConnected())) return { ok: false, message: '設定は保存済みです。「Microsoft に接続」を押してサインインしてください' };
        const me = await meProfile();
        let rootOk = true;
        let children: { name: string; folder?: unknown }[] = [];
        try {
          children = await listChildren(env().ONEDRIVE_CLIENT_ROOT);
        } catch {
          rootOk = false;
        }
        const map = statusFolderMap();
        const layout = Object.keys(map).length ? `区分フォルダ: ${Object.values(map).join('・')}` : null;
        const folderNames = children.filter((i) => i.folder).map((i) => i.name);
        const looksLikeLayout = !layout && Object.keys(guessStatusFolders(folderNames).map).length >= 2;
        return {
          ok: true,
          message: [
            `${me.userPrincipalName ?? me.mail ?? ''} に接続できました。`,
            `依頼者ルート ${env().ONEDRIVE_CLIENT_ROOT}: ${rootOk ? `フォルダ ${folderNames.length} 件` : '見つかりません（初回保存時に作成されます）'}`,
            layout,
            looksLikeLayout ? '相談・進行事件などの区分フォルダがあるようです。下の「区分フォルダの設定」で対応付けてください' : null,
          ]
            .filter(Boolean)
            .join(' '),
        };
      }
      case 'zoom': {
        if (!isConfigured('zoom')) return { ok: false, message: 'Account ID／Client ID／Secret が未設定です' };
        const m = await createZoomMeeting({ topic: '接続テスト（自動削除）', startAt: new Date(Date.now() + 3600_000), durationMinutes: 15 });
        await deleteZoomMeeting(m.id).catch(() => undefined);
        return { ok: true, message: 'ミーティングの作成・削除ができました' };
      }
      default:
        return { ok: false, message: '不明なサービスです' };
    }
  } catch (err) {
    return { ok: false, message: String((err as Error).message ?? err).slice(0, 500) };
  }
}
