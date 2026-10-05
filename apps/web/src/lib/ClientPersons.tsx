import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { telHref, clientPersonLabel } from '@lcm/shared';
import { api } from './api';
import { Icon } from './icons';
import { LineFriendPicker } from './LineFriendPicker';
import { RoomPicker } from './RoomPicker';

export interface ClientPerson {
  id: number;
  clientId: number;
  name: string;
  kana: string | null;
  title: string | null;
  emails: string[];
  phones: string[];
  lineUserId: string | null;
  chatworkAccountId: number | null;
  chatworkRoomId: number | null;
  primary: boolean;
  note: string | null;
}

interface FormState {
  name: string;
  kana: string;
  title: string;
  emails: string;
  phones: string;
  lineUserId: string | null;
  chatworkRoomId: string;
  primary: boolean;
  note: string;
}

const EMPTY: FormState = { name: '', kana: '', title: '', emails: '', phones: '', lineUserId: null, chatworkRoomId: '', primary: false, note: '' };
const split = (s: string) =>
  s
    .split(/[\s,、，;；]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function toForm(p: ClientPerson): FormState {
  return { name: p.name, kana: p.kana ?? '', title: p.title ?? '', emails: p.emails.join('\n'), phones: p.phones.join('\n'), lineUserId: p.lineUserId, chatworkRoomId: p.chatworkRoomId ? String(p.chatworkRoomId) : '', primary: p.primary, note: p.note ?? '' };
}

/**
 * 法人の依頼者の担当者（代表者とは別の窓口）。担当者ごとにメール・電話・LINE・Chatwork を登録する。
 * 担当者の連絡先から届いた連絡はこの依頼者に入り、期日連絡などでは担当者を宛先に選べる
 */
export function ClientPersonsCard({ clientId, persons }: { clientId: number; persons: ClientPerson[] }) {
  const qc = useQueryClient();
  // 'new' は新規登録、数字は編集中の担当者
  const [editing, setEditing] = useState<'new' | number | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [err, setErr] = useState('');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['client', String(clientId)] });
    qc.invalidateQueries({ queryKey: ['client-reachability', clientId] });
  };
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        kana: form.kana.trim() || null,
        title: form.title.trim() || null,
        emails: split(form.emails),
        phones: form.phones
          .split(/[\n,、，;；]+/)
          .map((x) => x.trim())
          .filter(Boolean),
        lineUserId: form.lineUserId,
        chatworkRoomId: form.chatworkRoomId ? Number(form.chatworkRoomId) : null,
        primary: form.primary,
        note: form.note.trim() || null,
      };
      return editing === 'new' ? api.post(`/clients/${clientId}/persons`, body) : api.put(`/client-persons/${editing}`, body);
    },
    onSuccess: () => {
      setEditing(null);
      setErr('');
      refresh();
    },
    onError: (e) => setErr((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/client-persons/${id}`),
    onSuccess: refresh,
    onError: (e) => setErr((e as Error).message),
  });
  const makePrimary = useMutation({
    mutationFn: (id: number) => api.put(`/client-persons/${id}`, { primary: true }),
    onSuccess: refresh,
    onError: (e) => setErr((e as Error).message),
  });
  const emailOk = split(form.emails).every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

  const formView = (
    <form
      className="fade-in mt-2 space-y-2 rounded-md border border-blue-200 bg-blue-50/40 p-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-2 md:grid-cols-3">
        <label className="block">
          <span className="label">氏名</span>
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例: 佐藤 花子" required autoFocus />
        </label>
        <label className="block">
          <span className="label">ふりがな</span>
          <input className="input" value={form.kana} onChange={(e) => setForm({ ...form, kana: e.target.value })} placeholder="さとう はなこ" />
        </label>
        <label className="block">
          <span className="label">部署・役職</span>
          <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="例: 総務部 課長" />
        </label>
        <label className="block">
          <span className="label">メール（複数は改行）</span>
          <textarea className="input min-h-10" rows={2} value={form.emails} onChange={(e) => setForm({ ...form, emails: e.target.value })} placeholder="sato@example.co.jp" />
          {!emailOk && <span className="text-xs text-red-600">メールアドレスの形になっていないものがあります</span>}
        </label>
        <label className="block">
          <span className="label">電話（複数は改行）</span>
          <textarea className="input min-h-10" rows={2} value={form.phones} onChange={(e) => setForm({ ...form, phones: e.target.value })} placeholder="06-1234-5678（内線 123）" />
        </label>
        <label className="block">
          <span className="label">メモ</span>
          <textarea className="input min-h-10" rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="例: 請求関係の窓口。平日 9〜17 時" />
        </label>
        <div>
          <span className="label">LINE</span>
          <LineFriendPicker value={form.lineUserId} onChange={(v) => setForm({ ...form, lineUserId: v })} />
        </div>
        <div className="md:col-span-2">
          <span className="label">Chatwork ルーム</span>
          <RoomPicker value={form.chatworkRoomId} onChange={(v) => setForm({ ...form, chatworkRoomId: v })} emptyLabel="（なし）" />
        </div>
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={form.primary} onChange={(e) => setForm({ ...form, primary: e.target.checked })} />
        主担当にする（期日連絡などで、依頼者に連絡するときの既定の宛先になります）
      </label>
      <div className="flex gap-2">
        <button className="btn btn-sm btn-primary" disabled={save.isPending || !form.name.trim() || !emailOk}>
          {save.isPending ? '保存中…' : editing === 'new' ? '登録' : '保存'}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>
          やめる
        </button>
      </div>
    </form>
  );

  return (
    <section className="card">
      <div className="mb-1 flex items-center">
        <h2 className="font-semibold">担当者</h2>
        {editing !== 'new' && (
          <button
            className="btn btn-sm ml-auto"
            onClick={() => {
              setForm({ ...EMPTY, primary: persons.length === 0 });
              setEditing('new');
            }}
          >
            ＋ 担当者を追加
          </button>
        )}
      </div>
      <p className="mb-2 text-xs text-slate-500">代表者とは別の窓口の方を、連絡先ごとに登録できます。担当者のメール・LINE・Chatwork から届いた連絡はこの依頼者に入り、期日連絡などでは宛先に選べます。</p>
      {err && <div className="mb-2 text-xs text-red-600">{err}</div>}
      {editing === 'new' && formView}
      {persons.length === 0 && editing !== 'new' && <div className="text-sm text-slate-400">登録されていません</div>}
      <ul className="divide-y divide-slate-100">
        {persons.map((p) => (
          <li key={p.id} className="py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{clientPersonLabel(p)}</span>
              {p.primary && <span className="badge badge-blue">主担当</span>}
              {p.kana && <span className="text-xs text-slate-500">{p.kana}</span>}
              <span className="ml-auto flex gap-1">
                {!p.primary && (
                  <button className="btn btn-sm" disabled={makePrimary.isPending} onClick={() => makePrimary.mutate(p.id)} title="依頼者に連絡するときの既定の宛先にします">
                    主担当にする
                  </button>
                )}
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setForm(toForm(p));
                    setEditing(p.id);
                  }}
                >
                  編集
                </button>
                <button
                  className="btn btn-sm text-red-600"
                  disabled={remove.isPending}
                  onClick={() => window.confirm(`担当者「${p.name}」を削除しますか？\nこの方とのやり取りは、依頼者の会話として残ります。`) && remove.mutate(p.id)}
                >
                  削除
                </button>
              </span>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-600">
              {p.phones.map((t) => (
                <a key={t} href={telHref(t)} className="inline-flex items-center gap-1 text-blue-700 hover:underline">
                  <Icon name="phone" className="h-3 w-3" />
                  {t}
                </a>
              ))}
              {p.emails.map((e) => (
                <span key={e}>{e}</span>
              ))}
              {p.lineUserId && <span>LINE 紐付け済み</span>}
              {p.chatworkRoomId && <span>Chatwork ルーム {p.chatworkRoomId}</span>}
              {!p.phones.length && !p.emails.length && !p.lineUserId && !p.chatworkRoomId && <span className="text-slate-400">連絡先未登録</span>}
            </div>
            {p.note && <div className="mt-0.5 whitespace-pre-wrap text-xs text-slate-500">{p.note}</div>}
            {editing === p.id && formView}
          </li>
        ))}
      </ul>
    </section>
  );
}
