import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from './api';
import { ClientPicker } from './ClientPicker';
import { CASE_CONTACT_ROLES, CASE_CONTACT_ROLE_LABEL } from '@lcm/shared';

/** 未紐付けの会話を、事件の関係者（相手方・相手方代理人など）として紐付ける */
export function ContactLinkForm({ conversationId, defaultName, onDone }: { conversationId: number; defaultName: string; onDone: () => void }) {
  const [clientId, setClientId] = useState('');
  const [caseId, setCaseId] = useState('');
  const [contactId, setContactId] = useState('');
  const [role, setRole] = useState<string>('opponent_counsel');
  const [name, setName] = useState(defaultName);
  const [organization, setOrganization] = useState('');
  const [err, setErr] = useState('');
  // 名前が渡されなかったとき（要確認からの紐付けなど）は会話の相手名で補う
  const conv = useQuery({ queryKey: ['conversation-brief', conversationId], queryFn: () => api.get<{ counterpartName: string | null; counterpartAddress: string | null }>(`/conversations/${conversationId}`), enabled: !defaultName });
  useEffect(() => {
    if (!name && conv.data) setName(conv.data.counterpartName ?? conv.data.counterpartAddress ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.data]);
  const cases = useQuery({ queryKey: ['cases', 'client', clientId], queryFn: () => api.get<{ id: number; title: string; status: string }[]>(`/cases?clientId=${clientId}`), enabled: !!clientId });
  const contacts = useQuery({ queryKey: ['contacts', caseId], queryFn: () => api.get<{ id: number; name: string; role: string; organization: string | null }[]>(`/cases/${caseId}/contacts`), enabled: !!caseId });
  useEffect(() => {
    setCaseId('');
    setContactId('');
  }, [clientId]);
  useEffect(() => {
    const list = cases.data ?? [];
    if (list.length === 1 && !caseId) setCaseId(String(list[0].id));
  }, [cases.data, caseId]);
  const submit = useMutation({
    mutationFn: () =>
      contactId
        ? api.post(`/conversations/${conversationId}/link-contact`, { contactId: Number(contactId) })
        : api.post(`/conversations/${conversationId}/link-contact`, { caseId: Number(caseId), contact: { role, name, organization: organization || null } }),
    onSuccess: onDone,
    onError: (e) => setErr((e as Error).message),
  });
  const ready = contactId || (caseId && name.trim());
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="label">依頼者</label>
          <ClientPicker value={clientId} onChange={setClientId} />
        </div>
        <div>
          <label className="label">事件</label>
          <select className="input w-56" value={caseId} onChange={(e) => { setCaseId(e.target.value); setContactId(''); }} disabled={!clientId}>
            <option value="">{clientId ? '事件を選択…' : '先に依頼者を選択'}</option>
            {cases.data?.map((k) => (
              <option key={k.id} value={k.id}>
                {k.title}
              </option>
            ))}
          </select>
        </div>
      </div>
      {caseId && (
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label">関係者</label>
            <select className="input w-56" value={contactId} onChange={(e) => setContactId(e.target.value)}>
              <option value="">新しく登録する</option>
              {contacts.data?.map((x) => (
                <option key={x.id} value={x.id}>
                  {CASE_CONTACT_ROLE_LABEL[x.role as keyof typeof CASE_CONTACT_ROLE_LABEL] ?? x.role}: {x.name}
                  {x.organization ? `（${x.organization}）` : ''}
                </option>
              ))}
            </select>
          </div>
          {!contactId && (
            <>
              <div>
                <label className="label">役割</label>
                <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
                  {CASE_CONTACT_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {CASE_CONTACT_ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">名前</label>
                <input className="input w-44" value={name} onChange={(e) => setName(e.target.value)} placeholder="例: 田中 一郎" />
              </div>
              <div>
                <label className="label">所属（任意）</label>
                <input className="input w-44" value={organization} onChange={(e) => setOrganization(e.target.value)} placeholder="例: ○○法律事務所" />
              </div>
            </>
          )}
          <button className="btn btn-primary btn-sm" disabled={!ready || submit.isPending} onClick={() => submit.mutate()}>
            関係者として紐付ける
          </button>
        </div>
      )}
      {err && <div className="text-red-600">{err}</div>}
      <div className="text-xs text-slate-500">この会話の相手のメールアドレス・LINE は関係者側に登録され、依頼者の連絡先は変わりません。以後この相手からの連絡は自動でこの事件に紐付きます。</div>
    </div>
  );
}
