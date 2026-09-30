import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from './api';
import { LineFriendPicker } from './LineFriendPicker';
import { RoomPicker } from './RoomPicker';

type Channel = 'gmail' | 'line' | 'chatwork';

interface Reachability {
  clientId: number;
  clientName: string;
  emails: string[];
  lineUserId: string | null;
  lineInvitedAt: string | null;
  chatworkRoomId: number | null;
  configured: Record<Channel, boolean>;
  channels: { channel: Channel; to: string }[];
}

/** 期日連絡など「依頼者に連絡先が無い」と断られたときの応答か。そうなら依頼者 ID を返す */
export function unreachableClientId(err: unknown): number | null {
  if (err instanceof ApiError && err.data?.code === 'client_unreachable' && typeof err.data.clientId === 'number') return err.data.clientId;
  return null;
}

const LABEL: Record<Channel, string> = { gmail: 'メール（Gmail）', line: 'LINE', chatwork: 'Chatwork' };

/**
 * 依頼者に送る手段が無いとき、その場で連絡先（メール・LINE・Chatwork ルーム）を登録する欄。
 * アプリに接続していないチャネルは、登録しても送れないので「初期設定で接続」を案内する
 */
export function ClientContactSetup({ clientId, channels = ['gmail', 'line', 'chatwork'], onSaved }: { clientId: number; channels?: Channel[]; onSaved: () => void }) {
  const qc = useQueryClient();
  const r = useQuery({ queryKey: ['client-reachability', clientId], queryFn: () => api.get<Reachability>(`/clients/${clientId}/reachability`) });
  const d = r.data;
  const [email, setEmail] = useState('');
  const [lineUserId, setLineUserId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!d) return;
    setEmail(d.emails[0] ?? '');
    setLineUserId(d.lineUserId);
    setRoomId(d.chatworkRoomId ? String(d.chatworkRoomId) : '');
  }, [d]);

  const save = useMutation({
    mutationFn: () => {
      const patch: Record<string, unknown> = {};
      const e = email.trim();
      // 入れたアドレスを先頭に（送信先は先頭のアドレス）。ほかの登録済みアドレスは残す
      if (e && e !== d!.emails[0]) patch.emails = [e, ...d!.emails.filter((x) => x !== e)];
      if (lineUserId !== d!.lineUserId) patch.lineUserId = lineUserId;
      const room = roomId ? Number(roomId) : null;
      if (room !== d!.chatworkRoomId) patch.chatworkRoomId = room;
      if (!Object.keys(patch).length) throw new Error('連絡先を 1 つ以上入れてください');
      return api.put(`/clients/${clientId}`, patch);
    },
    onSuccess: async () => {
      setErr('');
      await r.refetch();
      qc.invalidateQueries({ queryKey: ['client', String(clientId)] });
      qc.invalidateQueries({ queryKey: ['clients'] });
      onSaved();
    },
    onError: (e) => setErr((e as Error).message),
  });

  if (r.isLoading) return <div className="loading-text text-xs text-slate-500">連絡先を確認中…</div>;
  if (!d) return null;
  const shown = channels;
  const notConnected = shown.filter((c) => !d.configured[c]);
  const emailOk = !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  return (
    <div className="fade-in space-y-2 rounded-md border border-orange-200 bg-orange-50/60 p-3 text-sm">
      <div className="font-medium text-orange-900">{d.clientName}さんに送る連絡先を登録してください</div>
      <div className="text-xs text-orange-800">どれか 1 つあれば送れます。登録した連絡先は依頼者情報にも保存されます。</div>
      {shown.includes('gmail') && (
        <label className="block">
          <span className="label">メールアドレス{!d.configured.gmail && '（Gmail 未接続）'}</span>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="例: taro@example.com" disabled={!d.configured.gmail} />
          {!emailOk && <span className="text-xs text-red-600">メールアドレスの形になっていません</span>}
        </label>
      )}
      {shown.includes('line') && (
        <div>
          <span className="label">LINE公式の友だち{!d.configured.line && '（LINE 未接続）'}</span>
          {d.configured.line ? <LineFriendPicker value={lineUserId} onChange={setLineUserId} clientId={clientId} invitedAt={d.lineInvitedAt} onInviteChanged={() => r.refetch()} /> : <div className="text-xs text-slate-500">LINE公式アカウントを接続すると選べます</div>}
        </div>
      )}
      {shown.includes('chatwork') && (
        <div>
          <span className="label">Chatwork ルーム{!d.configured.chatwork && '（Chatwork 未接続）'}</span>
          {d.configured.chatwork ? <RoomPicker value={roomId} onChange={setRoomId} emptyLabel="（なし）" /> : <div className="text-xs text-slate-500">Chatwork を接続すると選べます</div>}
        </div>
      )}
      {notConnected.length > 0 && (
        <div className="text-xs text-slate-600">
          {notConnected.map((c) => LABEL[c]).join('・')} はアプリに接続されていないため、連絡先を入れても送れません。
          <Link className="ml-1 text-blue-700 underline" to="/setup">
            初期設定で接続する
          </Link>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-sm btn-primary" onClick={() => save.mutate()} disabled={save.isPending || !emailOk || notConnected.length === shown.length}>
          {save.isPending ? '保存中…' : '登録して続ける'}
        </button>
        <Link className="text-xs text-blue-700 underline" to={`/clients/${clientId}`}>
          依頼者のページで詳しく登録する
        </Link>
      </div>
      {err && <div className="text-xs text-red-600">{err}</div>}
    </div>
  );
}
