import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { CHANNEL_LABEL } from '@lcm/shared';

export interface ClientRow {
  id: number;
  name: string;
  kana: string | null;
  aliases: string[];
  emails: string[];
  lineUserId: string | null;
  chatworkRoomId: number | null;
  chatworkAccountId: number | null;
  onedriveFolderPath: string | null;
  preferredChannel: string | null;
  notes: string | null;
}

export default function Clients() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [showNew, setShowNew] = useState(params.has('new'));
  const list = useQuery({ queryKey: ['clients', q], queryFn: () => api.get<ClientRow[]>(`/clients${q ? `?q=${encodeURIComponent(q)}` : ''}`) });
  const create = useMutation({
    mutationFn: (body: Partial<ClientRow>) => api.post<ClientRow>('/clients', body),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      nav(`/clients/${c.id}`);
    },
  });
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-bold">依頼者</h1>
        <input className="input ml-auto w-64" placeholder="名前・かなで検索" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-primary" onClick={() => setShowNew(!showNew)}>
          ＋ 新規依頼者
        </button>
      </div>
      {showNew && <ClientForm initial={{ name: params.get('new') ?? '', emails: params.get('email') ? [params.get('email')!] : [] }} onSubmit={(b) => create.mutate(b)} onCancel={() => setShowNew(false)} busy={create.isPending} />}
      <div className="card p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2">氏名</th>
              <th className="px-4 py-2">連絡手段</th>
              <th className="px-4 py-2">フォルダ</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((c) => (
              <tr key={c.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2">
                  <Link to={`/clients/${c.id}`} className="font-medium text-blue-700 hover:underline">
                    {c.name}
                  </Link>
                  {c.kana && <span className="ml-2 text-xs text-slate-500">{c.kana}</span>}
                </td>
                <td className="px-4 py-2 text-xs">
                  {c.emails.length > 0 && <span className="badge badge-gmail mr-1">Gmail</span>}
                  {c.lineUserId && <span className="badge badge-line mr-1">LINE</span>}
                  {c.chatworkRoomId && <span className="badge badge-chatwork mr-1">Chatwork</span>}
                  {c.preferredChannel && <span className="text-slate-500">主: {CHANNEL_LABEL[c.preferredChannel as keyof typeof CHANNEL_LABEL]}</span>}
                </td>
                <td className="px-4 py-2 text-xs text-slate-500">{c.onedriveFolderPath ?? `（氏名と同名）`}</td>
              </tr>
            ))}
            {list.data?.length === 0 && (
              <tr>
                <td className="px-4 py-4 text-slate-500" colSpan={3}>
                  依頼者がまだ登録されていません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ClientForm({ initial, onSubmit, onCancel, busy }: { initial: Partial<ClientRow>; onSubmit: (b: Partial<ClientRow>) => void; onCancel: () => void; busy?: boolean }) {
  const [f, setF] = useState<Partial<ClientRow>>({ aliases: [], emails: [], ...initial });
  const folders = useQuery({ queryKey: ['drive-folders'], queryFn: () => api.get<{ path: string; items: { name: string; isFolder: boolean }[] }>('/drive/folders'), retry: false });
  const set = (k: keyof ClientRow, v: unknown) => setF({ ...f, [k]: v });
  return (
    <form
      className="card grid gap-3 md:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(f);
      }}
    >
      <div>
        <label className="label">氏名（必須）</label>
        <input className="input" required value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} />
      </div>
      <div>
        <label className="label">かな</label>
        <input className="input" value={f.kana ?? ''} onChange={(e) => set('kana', e.target.value)} />
      </div>
      <div>
        <label className="label">別名（カレンダーの表記など・カンマ区切り）</label>
        <input className="input" value={(f.aliases ?? []).join(', ')} onChange={(e) => set('aliases', e.target.value.split(/[,、]/).map((s) => s.trim()).filter(Boolean))} />
      </div>
      <div>
        <label className="label">メールアドレス（カンマ区切り）</label>
        <input className="input" value={(f.emails ?? []).join(', ')} onChange={(e) => set('emails', e.target.value.split(/[,、\s]+/).map((s) => s.trim()).filter(Boolean))} />
      </div>
      <div>
        <label className="label">Chatwork ルーム ID</label>
        <input className="input" type="number" value={f.chatworkRoomId ?? ''} onChange={(e) => set('chatworkRoomId', e.target.value ? Number(e.target.value) : null)} />
      </div>
      <div>
        <label className="label">LINE ユーザー ID（通常は受信時に自動紐付け）</label>
        <input className="input" value={f.lineUserId ?? ''} onChange={(e) => set('lineUserId', e.target.value || null)} />
      </div>
      <div>
        <label className="label">依頼者フォルダ（OneDrive の依頼者ルート配下。空なら氏名と同名）</label>
        <input className="input" list="folder-list" value={f.onedriveFolderPath ?? ''} onChange={(e) => set('onedriveFolderPath', e.target.value || null)} placeholder="例: 山田太郎_離婚" />
        <datalist id="folder-list">{folders.data?.items.filter((i) => i.isFolder).map((i) => <option key={i.name} value={i.name} />)}</datalist>
      </div>
      <div>
        <label className="label">主な連絡手段</label>
        <select className="input" value={f.preferredChannel ?? ''} onChange={(e) => set('preferredChannel', e.target.value || null)}>
          <option value="">未設定</option>
          <option value="line">LINE公式</option>
          <option value="chatwork">Chatwork</option>
          <option value="gmail">Gmail</option>
        </select>
      </div>
      <div className="md:col-span-2">
        <label className="label">メモ</label>
        <textarea className="input" rows={2} value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
      </div>
      <div className="flex gap-2 md:col-span-2">
        <button className="btn btn-primary" disabled={busy}>
          保存
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          キャンセル
        </button>
      </div>
    </form>
  );
}
