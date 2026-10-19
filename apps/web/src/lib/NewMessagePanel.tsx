import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import { ClientPicker } from './ClientPicker';
import { fmtDateTime } from './format';

interface ClientTargets {
  clientId: number;
  clientName: string;
  targets: { key: string; channel: 'gmail' | 'line' | 'chatwork'; channelLabel: string; to: string; personId: number | null; recipient: string }[];
  missing: string[];
  gmailThreads: { conversationId: number; subject: string; lastMessageAt: string | null; personId: number | null }[];
}

interface StaffTargets {
  configured: boolean;
  staff: { id: number; name: string; chatworkAccountId: number | null }[];
  rooms: { roomId: number; name: string; type: string }[];
  defaultRoomId: number | null;
}

const ICON: Record<string, string> = { gmail: '✉', line: '💬', chatwork: '🟥' };

/**
 * こちらから新しく送る（返信ではなく、依頼者・事務局へこちらから連絡する）。
 * ① 誰に（依頼者／事務局） → ② どこから（LINE・メール・Chatwork） を選ぶと、その相手との会話画面が開き、
 * いつもの返信と同じように AI 下書き・添付・送信予約を使って書ける
 */
export function NewMessagePanel({ initialClientId, onClose }: { initialClientId?: number | null; onClose: () => void }) {
  const navigate = useNavigate();
  const [to, setTo] = useState<'client' | 'staff'>('client');
  const [clientId, setClientId] = useState(initialClientId ? String(initialClientId) : '');
  const [key, setKey] = useState('');
  // メールは「新しいメール（件名）」か「前のメールの続き」
  const [thread, setThread] = useState('');
  const [subject, setSubject] = useState('');
  const [roomId, setRoomId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [err, setErr] = useState('');
  const targets = useQuery({ queryKey: ['send-targets', clientId], queryFn: () => api.get<ClientTargets>(`/clients/${clientId}/send-targets`), enabled: to === 'client' && !!clientId });
  const staff = useQuery({ queryKey: ['staff-send-targets'], queryFn: () => api.get<StaffTargets>('/staff/send-targets'), enabled: to === 'staff' });
  // 宛先の候補が変わったら、先頭（主担当・窓口、または本人の希望チャネル）を選んでおく
  useEffect(() => {
    setKey(targets.data?.targets[0]?.key ?? '');
    setThread('');
  }, [targets.data]);
  useEffect(() => {
    if (staff.data?.defaultRoomId && !roomId) setRoomId(String(staff.data.defaultRoomId));
  }, [staff.data, roomId]);
  const target = targets.data?.targets.find((t) => t.key === key) ?? null;
  const threads = (targets.data?.gmailThreads ?? []).filter((t) => (t.personId ?? null) === (target?.personId ?? null));

  const startClient = useMutation({
    mutationFn: () =>
      api.post<{ conversationId: number }>(`/clients/${clientId}/start-conversation`, {
        channel: target!.channel,
        personId: target!.personId,
        subject: target!.channel === 'gmail' && !thread ? subject.trim() : null,
        threadConversationId: target!.channel === 'gmail' && thread ? Number(thread) : null,
      }),
    onSuccess: (r) => navigate(`/inbox/${r.conversationId}`),
    onError: (e) => setErr((e as Error).message),
  });
  const member = staff.data?.staff.find((s) => String(s.id) === staffId) ?? null;
  const room = staff.data?.rooms.find((r) => String(r.roomId) === roomId) ?? null;
  const startStaff = useMutation({
    mutationFn: () => api.post<{ conversationId: number }>(`/chatwork/rooms/${roomId}/start-conversation`, { name: room?.name ?? null }),
    // 宛先（To）を付けるなら、会話画面の本文の先頭に入れておく
    onSuccess: (r) => navigate(`/inbox/${r.conversationId}${member?.chatworkAccountId ? `?to=${member.chatworkAccountId}&toName=${encodeURIComponent(member.name)}` : ''}`),
    onError: (e) => setErr((e as Error).message),
  });
  const needSubject = target?.channel === 'gmail' && !thread && !subject.trim();

  return (
    <section className="fade-in card space-y-3 border-blue-200 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">✉ 新しく送る</h2>
        <span className="text-xs text-slate-500">送り先を選ぶと、その相手との画面で書けます（AI 下書き・添付・送信予約も使えます）</span>
        <button className="btn btn-sm ml-auto" onClick={onClose}>
          閉じる
        </button>
      </div>
      <div className="flex gap-1" role="tablist">
        {(
          [
            ['client', '依頼者へ'],
            ['staff', '事務局へ（Chatwork）'],
          ] as const
        ).map(([v, label]) => (
          <button key={v} role="tab" aria-selected={to === v} className={`btn btn-sm ${to === v ? 'btn-primary' : ''}`} onClick={() => setTo(v)}>
            {label}
          </button>
        ))}
      </div>

      {to === 'client' && (
        <div className="space-y-2">
          {!initialClientId && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="shrink-0 font-medium">① 依頼者</span>
              <ClientPicker value={clientId} onChange={setClientId} selectClassName="w-full min-w-0 sm:w-64" autoFocus />
            </div>
          )}
          {clientId && targets.isLoading && <div className="loading-text text-slate-500">読み込み中…</div>}
          {targets.data && (
            <div className="space-y-1">
              <div className="font-medium">{initialClientId ? '① 送り方' : '② 送り方'}（{targets.data.clientName}）</div>
              {targets.data.targets.length === 0 && <div className="rounded bg-orange-50 px-2 py-1 text-xs text-orange-800">この依頼者に送れる連絡先がありません</div>}
              {targets.data.targets.map((t) => (
                <label key={t.key} className={`flex cursor-pointer items-center gap-2 rounded border px-2 py-1.5 ${key === t.key ? 'border-blue-400 bg-blue-50' : 'border-slate-200'}`}>
                  <input type="radio" name="send-target" checked={key === t.key} onChange={() => setKey(t.key)} />
                  <span className="shrink-0">{ICON[t.channel]}</span>
                  <span className="shrink-0 font-medium">{t.channelLabel}</span>
                  <span className="min-w-0 truncate">{t.recipient}</span>
                  <span className="ml-auto min-w-0 truncate text-xs text-slate-500">{t.to}</span>
                </label>
              ))}
              {targets.data.missing.length > 0 && (
                <ul className="text-xs text-slate-400">
                  {targets.data.missing.map((m) => (
                    <li key={m}>・{m}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {target?.channel === 'gmail' && (
            <div className="space-y-1 rounded border border-slate-200 p-2">
              <label className="flex items-center gap-2">
                <input type="radio" name="gmail-thread" checked={!thread} onChange={() => setThread('')} /> 新しいメール
              </label>
              {!thread && <input className="input w-full min-w-0" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="件名（例: 次回期日のご連絡）" aria-label="件名" />}
              {threads.length > 0 && (
                <label className="flex items-center gap-2">
                  <input type="radio" name="gmail-thread" checked={!!thread} onChange={() => setThread(String(threads[0]!.conversationId))} /> 前のメールの続き
                </label>
              )}
              {!!thread && (
                <select className="input w-full min-w-0" value={thread} onChange={(e) => setThread(e.target.value)} aria-label="続けるメール">
                  {threads.map((t) => (
                    <option key={t.conversationId} value={t.conversationId}>
                      {t.subject}
                      {t.lastMessageAt ? `（${fmtDateTime(t.lastMessageAt)}）` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          <button className="btn btn-primary" disabled={!target || needSubject || startClient.isPending} onClick={() => startClient.mutate()}>
            {startClient.isPending ? '開いています…' : 'この宛先で書く →'}
          </button>
        </div>
      )}

      {to === 'staff' && (
        <div className="space-y-2">
          {staff.isLoading && <div className="loading-text text-slate-500">読み込み中…</div>}
          {staff.data && !staff.data.configured && <div className="rounded bg-orange-50 px-2 py-1 text-xs text-orange-800">Chatwork が未設定です。初期設定で接続してください</div>}
          {staff.data?.configured && (
            <>
              <label className="flex flex-wrap items-center gap-2">
                <span className="shrink-0 font-medium">① ルーム</span>
                <select className="input w-full min-w-0 sm:w-auto sm:flex-1" value={roomId} onChange={(e) => setRoomId(e.target.value)} aria-label="送るルーム">
                  <option value="">（選んでください）</option>
                  {staff.data.rooms.map((r) => (
                    <option key={r.roomId} value={r.roomId}>
                      {r.name}
                      {r.type === 'direct' ? '（個人チャット）' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-wrap items-center gap-2">
                <span className="shrink-0 font-medium">② 宛先（To）</span>
                <select className="input w-full min-w-0 sm:w-auto" value={staffId} onChange={(e) => setStaffId(e.target.value)} aria-label="宛先の事務局メンバー">
                  <option value="">（付けない）</option>
                  {staff.data.staff.map((s) => (
                    <option key={s.id} value={s.id} disabled={!s.chatworkAccountId}>
                      {s.name}
                      {s.chatworkAccountId ? '' : '（Chatwork 未登録）'}
                    </option>
                  ))}
                </select>
              </label>
              <div className="text-xs text-slate-500">宛先を選ぶと、本文の先頭に「To: ◯◯さん」を入れておきます。依頼者や記録・タスクについての確認なら、その画面の「事務局に確認」を使うと内容を引用して送れます。</div>
              <button className="btn btn-primary" disabled={!roomId || startStaff.isPending} onClick={() => startStaff.mutate()}>
                {startStaff.isPending ? '開いています…' : 'このルームで書く →'}
              </button>
            </>
          )}
        </div>
      )}
      {err && <div className="fade-in text-xs text-red-600">{err}</div>}
    </section>
  );
}
