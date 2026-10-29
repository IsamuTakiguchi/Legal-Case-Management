import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from './api';
import { ClientPicker, useClients, type ClientOption } from './ClientPicker';
import { ContactLinkForm } from './ContactLinkForm';

/** 紐付けの分類: 依頼者本人／依頼者のご家族・窓口（法人なら担当者）／事件の関係者 */
export type LinkMode = 'client' | 'person' | 'contact';

/** 分類の見出し。LINE のグループは 1 人の相手ではないので「〜とのグループ」と言う */
export function linkModeLabels(group: boolean): Record<LinkMode, { label: string; title: string }> {
  return group
    ? {
        client: { label: '依頼者とのグループ', title: '依頼者本人が入っているグループ（ご家族なども一緒に入っていて構いません）' },
        person: { label: 'ご家族・窓口とのグループ', title: '依頼者本人は入っておらず、ご家族など窓口の方（法人なら担当者）とやり取りするグループ' },
        contact: { label: '事件の関係者とのグループ', title: '相手方・相手方代理人・保険会社など、依頼者以外の相手とのグループ' },
      }
    : {
        client: { label: '依頼者本人', title: '依頼者ご本人（法人なら会社・代表）' },
        person: { label: '依頼者のご家族・窓口', title: 'ご本人に代わって連絡してくるご家族など（法人なら担当者）。依頼者に紐付け、窓口として覚えます' },
        contact: { label: '事件の関係者', title: '相手方・相手方代理人・裁判所・保険会社など、依頼者以外の相手' },
      };
}

interface Person {
  id: number;
  name: string;
  title: string | null;
}

/**
 * 未紐付けの会話（メール・LINE・Chatwork）を、依頼者本人・依頼者のご家族や窓口・事件の関係者のどれかとして紐付ける。
 * ご家族・窓口を選ぶと依頼者に紐付けたうえで、会話の相手をその窓口（法人なら担当者）にする
 */
export function ConversationLinkForm({
  conversationId,
  group = false,
  defaultName,
  suggestions = [],
  newClientHref,
  extra,
  onDone,
}: {
  conversationId: number;
  /** LINE のグループ */
  group?: boolean;
  /** 相手の名前（窓口・関係者として登録するときの初期値） */
  defaultName: string;
  suggestions?: ClientOption[];
  /** 「新規依頼者として登録」の行き先 */
  newClientHref: string;
  /** 分類の横に出すもの（「会話を開く」など） */
  extra?: ReactNode;
  onDone: (text: string) => void;
}) {
  const [mode, setMode] = useState<LinkMode>('client');
  // 名前の似ている依頼者がいれば、はじめから選んでおく
  const [clientId, setClientId] = useState(suggestions[0] ? String(suggestions[0].id) : '');
  const [personId, setPersonId] = useState('');
  // グループは名前がグループ名なので、窓口の名前には入れない
  const [name, setName] = useState(group ? '' : defaultName);
  const [title, setTitle] = useState('');
  const [err, setErr] = useState('');
  const labels = linkModeLabels(group);
  const { data: clients } = useClients();
  const corporate = (clients as (ClientOption & { entityType?: string })[] | undefined)?.find((c) => String(c.id) === clientId)?.entityType === 'corporation';
  const persons = useQuery({ queryKey: ['client-persons', clientId], queryFn: () => api.get<Person[]>(`/clients/${clientId}/persons`), enabled: mode === 'person' && !!clientId });
  useEffect(() => setPersonId(''), [clientId]);
  const link = useMutation({
    mutationFn: () =>
      api.post<{ person: Person | null }>(`/conversations/${conversationId}/link`, {
        clientId: Number(clientId),
        ...(mode === 'person' ? (personId && personId !== 'new' ? { personId: Number(personId) } : { newPerson: { name: name.trim(), title: title.trim() || null } }) : {}),
      }),
    onSuccess: (r) => {
      setErr('');
      const who = r.person ? `${corporate ? '担当者' : '窓口'}の${r.person.name}${r.person.title ? `（${r.person.title}）` : ''}` : null;
      onDone(who ? `依頼者に紐付け、相手を${who}にしました` : '依頼者に紐付けました');
    },
    onError: (e) => setErr((e as Error).message),
  });
  const existing = persons.data ?? [];
  const adding = mode === 'person' && (personId === 'new' || (personId === '' && existing.length === 0));
  const ready = !!clientId && (mode === 'client' || (mode === 'person' && (adding ? !!name.trim() : !!personId)));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {(['client', 'person', 'contact'] as const).map((m) => (
          <label key={m} className="flex items-center gap-1" title={labels[m].title}>
            <input type="radio" name={`link-mode-${conversationId}`} checked={mode === m} onChange={() => setMode(m)} /> {labels[m].label}
          </label>
        ))}
        {extra}
      </div>
      {mode === 'contact' ? (
        <ContactLinkForm conversationId={conversationId} defaultName={group ? '' : defaultName} onDone={() => onDone('関係者として紐付けました')} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <ClientPicker value={clientId} onChange={setClientId} suggestions={suggestions} emptyLabel={mode === 'person' ? 'どの依頼者のご家族・窓口か…' : '依頼者を選択…'} />
          {mode === 'person' && clientId && (
            <>
              {existing.length > 0 && (
                <select className="input w-auto" value={personId} onChange={(e) => setPersonId(e.target.value)} aria-label={corporate ? '担当者' : '窓口の方'}>
                  <option value="">{corporate ? '担当者を選ぶ…' : '窓口の方を選ぶ…'}</option>
                  {existing.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.title ? `（${p.title}）` : ''}
                    </option>
                  ))}
                  <option value="new">＋ 新しく登録…</option>
                </select>
              )}
              {adding && (
                <>
                  <input className="input w-36" placeholder={corporate ? '担当者の名前' : '窓口の方の名前'} value={name} onChange={(e) => setName(e.target.value)} />
                  <input className="input w-36" placeholder={corporate ? '部署・肩書（任意）' : '続柄（例: 長男）'} value={title} onChange={(e) => setTitle(e.target.value)} />
                </>
              )}
            </>
          )}
          <button className="btn btn-primary btn-sm" disabled={!ready || link.isPending} onClick={() => link.mutate()}>
            紐付ける
          </button>
          {mode === 'client' && (
            <Link to={newClientHref} className="btn btn-sm">
              新規依頼者として登録
            </Link>
          )}
        </div>
      )}
      {mode === 'person' && (
        <div className="text-xs text-slate-500">
          依頼者に紐付けたうえで、{group ? 'このグループを窓口の方とのやり取り' : 'この相手を依頼者の窓口'}として覚えます。依頼者がまだ登録されていなければ、先に「{labels.client.label}」を選んで新規依頼者を登録してください。
        </div>
      )}
      {err && <div className="fade-in text-xs text-red-600">{err}</div>}
    </div>
  );
}
