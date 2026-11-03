import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CASE_CONTACT_ROLE_LABEL, clientPersonLabel, representativeLabel, splitNumbers, telHref, type CaseContactRole, type InsurerPerson } from '@lcm/shared';
import { api } from './api';
import { channelLabel, fmtDateTime } from './format';
import { Icon } from './icons';
import type { ClientPerson } from './ClientPersons';

export interface SummaryClient {
  id: number;
  name: string;
  entityType?: string | null;
  representativeTitle?: string | null;
  representativeName?: string | null;
  phones?: string[];
  emails: string[];
  lineUserId: string | null;
  chatworkRoomId: number | null;
  preferredChannel: string | null;
}

/** 事件の関係者（相手方代理人・保険会社・裁判所など） */
export type SummaryContact = InsurerPerson & { role: string; lineUserId?: string | null };

type SendChannel = 'gmail' | 'line' | 'chatwork';

interface ClientTargets {
  targets: { key: string; channel: SendChannel; to: string; personId: number | null; recipient: string }[];
  gmailThreads: { conversationId: number; subject: string; lastMessageAt: string | null; personId: number | null }[];
  configured?: { gmail: boolean; line: boolean; chatwork: boolean };
}
interface ContactTargets {
  targets: { channel: 'gmail' | 'line'; to: string }[];
  missing: string[];
  gmailThreads: { conversationId: number; subject: string; lastMessageAt: string | null }[];
}

/** 関係者の並び（相手方代理人 → 相手方 → 保険会社 → 裁判所 → その他） */
const ROLE_ORDER: CaseContactRole[] = ['opponent_counsel', 'opponent', 'client_insurer', 'opponent_insurer', 'insurer', 'court', 'other'];
/** 会社ごとにまとめて出す区分（担当者が何人もいる） */
const GROUPED_ROLES = new Set<string>(['client_insurer', 'opponent_insurer', 'insurer']);

/** 区分ごと、保険会社は会社ごとにまとめる */
export function contactGroups<T extends SummaryContact>(contacts: T[]): { role: string; companies: { organization: string | null; people: T[] }[] }[] {
  const roles = [...ROLE_ORDER, ...new Set(contacts.map((c) => c.role).filter((r) => !(ROLE_ORDER as string[]).includes(r)))];
  return roles
    .map((role) => {
      const companies: { organization: string | null; people: T[] }[] = [];
      for (const c of contacts.filter((x) => x.role === role).sort((a, b) => a.id - b.id)) {
        if (!GROUPED_ROLES.has(role)) {
          companies.push({ organization: null, people: [c] });
          continue;
        }
        const organization = c.organization?.trim() || c.name;
        const co = companies.find((x) => x.organization === organization);
        if (co) co.people.push(c);
        else companies.push({ organization, people: [c] });
      }
      return { role, companies };
    })
    .filter((s) => s.companies.length);
}

/** 番号（tel: リンク。スマホなら押すとそのまま発信） */
function Tel({ number, label }: { number: string; label?: string }) {
  return (
    <a href={telHref(number)} className="inline-flex items-center gap-1 whitespace-nowrap text-blue-700 hover:underline">
      <Icon name="phone" className="h-3.5 w-3.5" />
      {label && <span className="text-xs text-slate-500">{label}</span>}
      {number}
    </a>
  );
}

const SEND_LABEL: Record<SendChannel, string> = { gmail: '✉ メール', line: '💬 LINE', chatwork: '🟥 Chatwork' };

/** メール・LINE・Chatwork で送るボタン */
function SendButton({ channel, onClick, disabled, title }: { channel: SendChannel; onClick: () => void; disabled?: boolean; title: string }) {
  return (
    <button type="button" className="btn btn-sm whitespace-nowrap" onClick={onClick} disabled={disabled} title={title}>
      {SEND_LABEL[channel]}
    </button>
  );
}

/** メールを書く前に、新しいメール（件名）か、前のメールの続きかを選ぶ */
function MailStart({
  to,
  threads,
  defaultSubject,
  pending,
  error,
  onStart,
  onClose,
}: {
  to: string;
  threads: { conversationId: number; subject: string; lastMessageAt: string | null }[];
  defaultSubject: string;
  pending: boolean;
  error: string;
  onStart: (v: { subject?: string; threadConversationId?: number }) => void;
  onClose: () => void;
}) {
  const [thread, setThread] = useState('');
  const [subject, setSubject] = useState(defaultSubject);
  return (
    <div className="fade-in mt-1 space-y-1.5 rounded border border-blue-200 bg-blue-50/40 p-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium">✉ メールを書く</span>
        <span className="min-w-0 truncate text-slate-500">{to}</span>
        <button type="button" className="ml-auto text-slate-500 hover:text-slate-800" onClick={onClose} aria-label="閉じる">
          ×
        </button>
      </div>
      <label className="flex items-center gap-2">
        <input type="radio" checked={!thread} onChange={() => setThread('')} /> 新しいメール
      </label>
      {!thread && <input className="input w-full min-w-0 text-xs" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="件名" aria-label="件名" />}
      {threads.length > 0 && (
        <label className="flex items-center gap-2">
          <input type="radio" checked={!!thread} onChange={() => setThread(String(threads[0]!.conversationId))} /> 前のメールの続き
        </label>
      )}
      {!!thread && (
        <select className="input w-full min-w-0 text-xs" value={thread} onChange={(e) => setThread(e.target.value)} aria-label="続けるメール">
          {threads.map((t) => (
            <option key={t.conversationId} value={t.conversationId}>
              {t.subject}
              {t.lastMessageAt ? `（${fmtDateTime(t.lastMessageAt)}）` : ''}
            </option>
          ))}
        </select>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn btn-sm btn-primary shrink-0 whitespace-nowrap"
          disabled={pending || (!thread && !subject.trim())}
          onClick={() => onStart(thread ? { threadConversationId: Number(thread) } : { subject: subject.trim() })}
        >
          {pending ? '開いています…' : '書く画面を開く →'}
        </button>
        <span className="text-slate-500">AI 下書き・添付・CC・送信予約はいつもの画面で使えます</span>
      </div>
      {error && <div className="text-red-600">{error}</div>}
    </div>
  );
}

/**
 * 事件の概要・記録で、電話や連絡の前にすぐ見られる連絡先。
 * 依頼者（電話・メール・LINE・Chatwork、窓口のご家族・担当者）と、関係者（相手方代理人・相手方・保険会社・裁判所など）。
 * メール・LINE・Chatwork のボタンを押すと、その相手との会話画面が開き、そのまま書いて送れる
 */
export function CaseContactSummary({
  client,
  persons,
  contacts,
  traffic,
  caseTitle,
}: {
  client: SummaryClient;
  persons: ClientPerson[];
  contacts: SummaryContact[];
  traffic: boolean;
  caseTitle?: string;
}) {
  const navigate = useNavigate();
  const phones = client.phones ?? [];
  const rep = representativeLabel(client);
  const groups = contactGroups(contacts);
  const targets = useQuery({ queryKey: ['send-targets', String(client.id)], queryFn: () => api.get<ClientTargets>(`/clients/${client.id}/send-targets`), staleTime: 60_000 });
  // 開いているメールの欄（「client:」「client:12」「contact:5」）
  const [mailFor, setMailFor] = useState<string | null>(null);
  const [err, setErr] = useState<{ key: string; text: string } | null>(null);
  const defaultSubject = caseTitle ? `${caseTitle}について` : '';

  const open = (r: { conversationId: number }) => navigate(`/inbox/${r.conversationId}`);
  const startClient = useMutation({
    mutationFn: (v: { key: string; channel: SendChannel; personId: number | null; subject?: string; threadConversationId?: number }) =>
      api.post<{ conversationId: number }>(`/clients/${client.id}/start-conversation`, { channel: v.channel, personId: v.personId, subject: v.subject ?? null, threadConversationId: v.threadConversationId ?? null }),
    onSuccess: open,
    onError: (e, v) => setErr({ key: v.key, text: (e as Error).message }),
  });
  const startContact = useMutation({
    mutationFn: (v: { key: string; contactId: number; channel: 'gmail' | 'line'; subject?: string; threadConversationId?: number }) =>
      api.post<{ conversationId: number }>(`/contacts/${v.contactId}/start-conversation`, { channel: v.channel, subject: v.subject ?? null, threadConversationId: v.threadConversationId ?? null }),
    onSuccess: open,
    onError: (e, v) => setErr({ key: v.key, text: (e as Error).message }),
  });
  const pending = startClient.isPending || startContact.isPending;

  /** 依頼者本人（personId=null）や窓口・担当者に送るボタン */
  const clientButtons = (personId: number | null) => {
    const key = `client:${personId ?? ''}`;
    const ts = (targets.data?.targets ?? []).filter((t) => t.personId === personId);
    if (!ts.length) return null;
    const gmail = ts.find((t) => t.channel === 'gmail');
    return (
      <div>
        <div className="flex flex-wrap gap-1">
          {ts.map((t) => (
            <SendButton
              key={t.key}
              channel={t.channel}
              disabled={pending}
              title={`${t.recipient}に ${channelLabel(t.channel)} で送る画面を開きます`}
              onClick={() => {
                setErr(null);
                if (t.channel === 'gmail') setMailFor(mailFor === key ? null : key);
                else startClient.mutate({ key, channel: t.channel, personId });
              }}
            />
          ))}
        </div>
        {gmail && mailFor === key && (
          <MailStart
            to={gmail.to}
            threads={(targets.data?.gmailThreads ?? []).filter((t) => (t.personId ?? null) === personId)}
            defaultSubject={defaultSubject}
            pending={startClient.isPending}
            error={err?.key === key ? err.text : ''}
            onStart={(v) => startClient.mutate({ key, channel: 'gmail', personId, ...v })}
            onClose={() => setMailFor(null)}
          />
        )}
        {err?.key === key && mailFor !== key && <div className="text-xs text-red-600">{err.text}</div>}
      </div>
    );
  };

  return (
    <section className="card space-y-3 text-sm" aria-label="連絡先">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="font-semibold">連絡先</h2>
        <Link to={`/clients/${client.id}`} className="ml-auto text-xs text-blue-700 hover:underline">
          依頼者の連絡先を変更
        </Link>
        <a href="#contacts" className="text-xs text-blue-700 hover:underline">
          関係者を追加・変更
        </a>
      </div>
      <div className={`grid gap-3 ${groups.length ? 'md:grid-cols-2' : ''}`}>
        <div className="min-w-0 space-y-1">
          <div className="text-xs font-semibold text-slate-500">依頼者</div>
          <div className="font-medium">
            {client.name}
            {rep && <span className="ml-2 text-xs font-normal text-slate-500">代表者 {rep}</span>}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {phones.length ? phones.map((p) => <Tel key={p} number={p} />) : <span className="text-slate-400">電話 未登録</span>}
          </div>
          {client.emails.length > 0 && <div className="break-all text-slate-700">✉ {client.emails.join('、')}</div>}
          <div className="flex flex-wrap gap-1.5 text-xs">
            {client.lineUserId && <span className="badge badge-line">LINE 連携済</span>}
            {client.chatworkRoomId && <span className="badge badge-chatwork">Chatwork ルーム {client.chatworkRoomId}</span>}
            {client.preferredChannel && <span className="text-slate-500">主な連絡手段: {channelLabel(client.preferredChannel)}</span>}
          </div>
          {clientButtons(null)}
          {persons.length > 0 && (
            <ul className="space-y-1.5 border-t border-slate-100 pt-1">
              {persons.map((p) => (
                <li key={p.id} className="min-w-0">
                  <span className="mr-1 text-xs text-slate-500">{client.entityType === 'corporation' ? '担当者' : '窓口'}</span>
                  <span className="font-medium">{clientPersonLabel(p)}</span>
                  {p.primary && <span className="badge badge-gray ml-1">主</span>}
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {p.phones.map((t) => (
                      <Tel key={t} number={t} />
                    ))}
                    {p.emails.length > 0 && <span className="break-all text-slate-700">✉ {p.emails.join('、')}</span>}
                  </div>
                  {clientButtons(p.id)}
                </li>
              ))}
            </ul>
          )}
        </div>
        {groups.length > 0 && (
          <div className="min-w-0 space-y-3">
            {groups.map((g) => (
              <div key={g.role} className="min-w-0 space-y-1">
                <div className="text-xs font-semibold text-slate-500">{CASE_CONTACT_ROLE_LABEL[g.role as CaseContactRole] ?? g.role}</div>
                {g.companies.map((co, i) => (
                  <div key={co.organization ?? `p${i}`} className="space-y-1">
                    {co.organization && <div className="font-medium">{co.organization}</div>}
                    <ul className="space-y-1">
                      {co.people.map((x) => (
                        <ContactItem
                          key={x.id}
                          x={x}
                          organization={co.organization}
                          configured={targets.data?.configured}
                          pending={pending}
                          mailOpen={mailFor === `contact:${x.id}`}
                          onMail={() => {
                            setErr(null);
                            setMailFor(mailFor === `contact:${x.id}` ? null : `contact:${x.id}`);
                          }}
                          onCloseMail={() => setMailFor(null)}
                          defaultSubject={defaultSubject}
                          error={err?.key === `contact:${x.id}` ? err.text : ''}
                          onStart={(v) => startContact.mutate({ key: `contact:${x.id}`, contactId: x.id, ...v })}
                          starting={startContact.isPending}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {!groups.length && (
          <div className="text-xs text-slate-400">
            関係者（相手方代理人・相手方・保険会社など）は未登録です。下の「関係者」で登録すると、ここに連絡先とメールのボタンが出ます
            {traffic && '（保険会社は「メモから登録」で、保険会社のメモを貼り付けるとまとめて登録できます）'}
          </div>
        )}
      </div>
    </section>
  );
}

/** 関係者 1 人（担当の区分・氏名・TEL・FAX・メール、メール・LINE のボタン） */
function ContactItem({
  x,
  organization,
  configured,
  pending,
  mailOpen,
  onMail,
  onCloseMail,
  defaultSubject,
  error,
  onStart,
  starting,
}: {
  x: SummaryContact;
  /** 会社ごとにまとめて出しているときの会社名（まとめていなければ null） */
  organization: string | null;
  configured?: { gmail: boolean; line: boolean; chatwork: boolean };
  pending: boolean;
  mailOpen: boolean;
  onMail: () => void;
  onCloseMail: () => void;
  defaultSubject: string;
  error: string;
  onStart: (v: { channel: 'gmail' | 'line'; subject?: string; threadConversationId?: number }) => void;
  starting: boolean;
}) {
  // 前のメールの続きを選べるよう、メールの欄を開いたときだけ取りに行く
  const info = useQuery({ queryKey: ['contact-send-targets', x.id], queryFn: () => api.get<ContactTargets>(`/contacts/${x.id}/send-targets`), enabled: mailOpen });
  const canMail = x.emails.length > 0 && configured?.gmail !== false;
  const canLine = !!x.lineUserId && configured?.line !== false;
  return (
    <li className="rounded bg-slate-50 px-2 py-1">
      <div>
        {x.department && <span className="mr-1 text-xs text-slate-500">{x.department}担当</span>}
        {organization ? (
          x.name !== organization ? x.name : <span className="text-slate-500">（代表）</span>
        ) : (
          <>
            <span className="font-medium">{x.name}</span>
            {x.organization && <span className="ml-1 text-xs text-slate-500">{x.organization}</span>}
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {splitNumbers(x.phone).map((t) => (
          <Tel key={t} number={t} label="TEL" />
        ))}
        {splitNumbers(x.fax).map((t) => (
          <span key={t} className="whitespace-nowrap text-slate-700">
            <span className="text-xs text-slate-500">FAX</span> {t}
          </span>
        ))}
        {x.emails.length > 0 && <span className="break-all text-slate-700">✉ {x.emails.join('、')}</span>}
        {!x.phone && !x.fax && !x.emails.length && <span className="text-xs text-slate-400">連絡先 未登録</span>}
      </div>
      {x.note && <div className="whitespace-pre-wrap text-xs text-slate-600">{x.note}</div>}
      {(canMail || canLine) && (
        <div className="mt-1 flex flex-wrap gap-1">
          {canMail && <SendButton channel="gmail" onClick={onMail} disabled={pending} title={`${x.name}にメールを書く画面を開きます`} />}
          {canLine && <SendButton channel="line" onClick={() => onStart({ channel: 'line' })} disabled={pending} title={`${x.name}に LINE で送る画面を開きます`} />}
        </div>
      )}
      {mailOpen && (
        <MailStart
          to={x.emails[0] ?? ''}
          threads={info.data?.gmailThreads ?? []}
          defaultSubject={defaultSubject}
          pending={starting}
          error={error}
          onStart={(v) => onStart({ channel: 'gmail', ...v })}
          onClose={onCloseMail}
        />
      )}
      {error && !mailOpen && <div className="text-xs text-red-600">{error}</div>}
    </li>
  );
}
