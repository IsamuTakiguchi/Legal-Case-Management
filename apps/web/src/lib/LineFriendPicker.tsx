import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { fmtDate } from './format';

export interface LineFriend {
  userId: string;
  displayName: string | null;
  pictureUrl: string | null;
  followedAt: string | null;
  lastMessageAt: string | null;
  conversationId: number | null;
  client: { id: number; name: string } | null;
}

export function friendLabel(f: LineFriend): string {
  const name = f.displayName ?? `名前不明（ID 末尾 …${f.userId.slice(-6)}）`;
  const when = f.lastMessageAt ? `最終受信 ${fmtDate(f.lastMessageAt)}` : f.followedAt ? `友だち追加 ${fmtDate(f.followedAt)}` : 'まだ受信なし';
  return `${name}（${when}）`;
}

/**
 * 依頼者の LINE を「友だち一覧から選ぶ」部品。ID を手で調べなくてよい。
 * 友だち追加の通知・受信・友だち一覧 API から蓄積した相手を名前で選ぶ
 */
export function LineFriendPicker({ value, onChange, clientId }: { value: string | null; onChange: (userId: string | null) => void; clientId?: number | null }) {
  const qc = useQueryClient();
  const friends = useQuery({ queryKey: ['line-friends'], queryFn: () => api.get<LineFriend[]>('/line/friends') });
  const [manual, setManual] = useState(false);
  const [msg, setMsg] = useState('');
  const sync = useMutation({
    mutationFn: () => api.post<{ ok: boolean; total: number; added: number; reason?: string }>('/line/friends/sync'),
    onSuccess: (r) => {
      setMsg(r.ok ? `友だち ${r.total} 人を確認し、${r.added} 人を新たに登録しました` : (r.reason ?? '取り込めませんでした'));
      qc.invalidateQueries({ queryKey: ['line-friends'] });
    },
    onError: (e) => setMsg((e as Error).message),
  });
  const list = (friends.data ?? []).filter((f) => !f.client || f.client.id === clientId || f.userId === value);
  const linkedElsewhere = (friends.data ?? []).filter((f) => f.client && f.client.id !== clientId && f.userId !== value);
  return (
    <div className="space-y-1">
      {manual ? (
        <input className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} placeholder="U で始まる LINE ユーザー ID" />
      ) : (
        <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">未設定（受信時に自動で紐付け）</option>
          {value && !list.some((f) => f.userId === value) && <option value={value}>現在の設定: …{value.slice(-6)}</option>}
          {list.map((f) => (
            <option key={f.userId} value={f.userId}>
              {friendLabel(f)}
              {f.client && f.client.id === clientId ? '（この依頼者に紐付け済）' : ''}
            </option>
          ))}
          {linkedElsewhere.length > 0 && (
            <optgroup label="ほかの依頼者に紐付け済">
              {linkedElsewhere.map((f) => (
                <option key={f.userId} value={f.userId} disabled>
                  {f.displayName ?? f.userId} → {f.client!.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <button type="button" className="btn btn-sm" onClick={() => sync.mutate()} disabled={sync.isPending} title="LINE の友だち一覧 API から取り込みます（認証済／プレミアムアカウントのみ）">
          {sync.isPending ? '取り込み中…' : '友だち一覧を取り込む'}
        </button>
        <button type="button" className="hover:underline" onClick={() => setManual(!manual)}>
          {manual ? '一覧から選ぶ' : 'ID を直接入力'}
        </button>
        {friends.data && list.length === 0 && !manual && <span>候補がありません。依頼者が友だち追加すると「要確認」に通知が出て、そこから紐付けできます</span>}
      </div>
      {msg && <div className="fade-in text-xs text-slate-600">{msg}</div>}
    </div>
  );
}
