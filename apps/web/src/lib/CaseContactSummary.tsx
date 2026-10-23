import { Link } from 'react-router-dom';
import { CASE_CONTACT_ROLE_LABEL, clientPersonLabel, insurerSides, representativeLabel, splitNumbers, telHref, type InsurerPerson } from '@lcm/shared';
import { channelLabel } from './format';
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

/**
 * 事件の概要・記録で、電話する前にすぐ見られる連絡先。
 * 依頼者（電話・メール・LINE・Chatwork、窓口のご家族・担当者）と、交通事故なら依頼者側・相手方の保険会社
 * （会社ごとに、担当の区分・担当者・TEL・FAX・受付番号）
 */
export function CaseContactSummary({ client, persons, contacts, traffic }: { client: SummaryClient; persons: ClientPerson[]; contacts: (InsurerPerson & { role: string })[]; traffic: boolean }) {
  const phones = client.phones ?? [];
  const rep = representativeLabel(client);
  const sides = traffic ? insurerSides(contacts) : [];
  return (
    <section className="card space-y-3 text-sm" aria-label="連絡先">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="font-semibold">連絡先</h2>
        <Link to={`/clients/${client.id}`} className="ml-auto text-xs text-blue-700 hover:underline">
          依頼者の連絡先を変更
        </Link>
      </div>
      <div className={`grid gap-3 ${sides.length ? 'md:grid-cols-2 xl:grid-cols-3' : ''}`}>
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
          {persons.length > 0 && (
            <ul className="space-y-1 border-t border-slate-100 pt-1">
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
                </li>
              ))}
            </ul>
          )}
        </div>
        {sides.map((s) => (
          <div key={s.role} className="min-w-0 space-y-2">
            <div className="text-xs font-semibold text-slate-500">{CASE_CONTACT_ROLE_LABEL[s.role]}</div>
            {s.companies.map((co) => (
              <div key={co.organization} className="space-y-1">
                <div className="font-medium">{co.organization}</div>
                <ul className="space-y-1">
                  {co.people.map((x) => (
                    <li key={x.id} className="rounded bg-slate-50 px-2 py-1">
                      <div>
                        {x.department && <span className="mr-1 text-xs text-slate-500">{x.department}担当</span>}
                        {x.name !== co.organization ? x.name : <span className="text-slate-500">（代表）</span>}
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
                      </div>
                      {x.note && <div className="whitespace-pre-wrap text-xs text-slate-600">{x.note}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ))}
        {traffic && !sides.length && <div className="text-xs text-slate-400">保険会社は未登録です。「関係者」の「メモから登録」で、保険会社のメモを貼り付けるとまとめて登録できます</div>}
      </div>
    </section>
  );
}
