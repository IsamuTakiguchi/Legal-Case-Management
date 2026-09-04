/**
 * consultation-scheduler スキルから移植した相談予約用テンプレート。
 * 設定画面から編集できるよう settings に保存し、未設定時はこの既定値を使う。
 */
import { getSetting, setSetting } from './settings.js';

export interface MessageTemplate {
  key: string;
  label: string;
  when: string;
  body: string;
}

export const DEFAULT_TEMPLATES: MessageTemplate[] = [
  {
    key: 'consult_invite',
    label: '1. 相談を促す',
    when: 'まだ具体的な日程調整に至らず、まず相談を勧める場合',
    body: `お問い合わせ内容に関して確認しましたが、ご希望に沿えるかどうか分かりませんが、まずは詳細を確認してから判断ということになります。
もしご希望でしたら面談相談のご予約をお取りしますので、相談希望日をお知らせください。`,
  },
  {
    key: 'ask_alternative',
    label: '2. 別候補を依頼',
    when: '希望日時に空きがない場合',
    body: `{{姓}}様

お問い合わせありがとうございます。
あいにく今週中ですと、ご希望の時間帯はいずれも都合がつかない状況です。
来週ですと可能な時間帯はございますので、ご検討頂ければと存じます。`,
  },
  {
    key: 'web_confirm_debt',
    label: '3. WEB相談確定（借金問題）',
    when: 'WEB相談の日時が確定し、相談内容が借金問題の場合',
    body: `{{姓}}様

では、{{日時}}といたします。
ＵＲＬは次のとおりですので、時間となりましたら、ご入室ください。
{{URL}}

また、事前に、現在の借り入れ状況をまとめおいて頂けますでしょうか。（借入先、残高、毎月の返済額）`,
  },
  {
    key: 'web_confirm',
    label: '4. WEB相談確定',
    when: 'WEB相談の日時が確定した場合',
    body: `{{姓}}様

では、{{日時}}といたします。
ＵＲＬは次のとおりですので、時間となりましたら、ご入室ください。
{{URL}}`,
  },
  {
    key: 'propose_slots',
    label: '5. 候補日提案',
    when: '空いている日時の候補を提示する場合',
    body: `{{姓}}様

お問い合わせありがとうございます。

面談相談の日程ですが、最短ですと

{{候補日時}}

となりますがいかがでしょうか。`,
  },
  {
    key: 'decline',
    label: '6. 相談お断り',
    when: '相談内容的に対応が難しい場合',
    body: `{{姓}}様

この度はお問い合わせありがとうございます。

お問い合わせ内容に関して確認しましたが、内容的にお力になることは難しいと考えております。
申し訳ございませんが、ご理解賜りますようよろしくお願い申し上げます。`,
  },
  {
    key: 'visit_confirm_debt',
    label: '7. 面談相談確定（借金問題）',
    when: '面談相談の日時が確定し、相談内容が借金問題の場合',
    body: `{{姓}}様

では、
{{日時}}
で予約をお取りしますので、当日お待ちしております。

{{アクセス案内}}

当日は、現在の借り入れ状況をまとめた一覧をご持参ください。（借入先、残高、毎月の返済額）`,
  },
  {
    key: 'visit_confirm',
    label: '8. 面談相談確定',
    when: '面談相談の日時が確定した場合',
    body: `{{姓}}様

では、
{{日時}}
で予約をお取りしますので、当日お待ちしております。

{{アクセス案内}}`,
  },
  {
    key: 'hearing_report',
    label: '期日報告',
    when: '裁判・打合せ後に結果と提出書面を報告する場合',
    body: `{{姓}}様

本日の期日の結果をご報告いたします。

{{結果}}

提出した書面は添付（またはリンク）のとおりです。
次回期日は{{次回期日}}です。

ご不明な点がございましたらお知らせください。`,
  },
  {
    key: 'nudge',
    label: '催促',
    when: '返信待ちが期限を過ぎた場合',
    body: `{{姓}}様

先日ご連絡した件について、その後いかがでしょうか。
{{件名}}

お手数ですが、ご確認のうえご返信いただけますと幸いです。`,
  },
];

export function listTemplates(): MessageTemplate[] {
  const raw = getSetting('templates_json');
  if (!raw) return DEFAULT_TEMPLATES;
  try {
    const parsed = JSON.parse(raw) as MessageTemplate[];
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_TEMPLATES;
  } catch {
    return DEFAULT_TEMPLATES;
  }
}

export function saveTemplates(templates: MessageTemplate[]) {
  setSetting('templates_json', JSON.stringify(templates));
}

export function fillTemplate(body: string, vars: Record<string, string | undefined | null>): string {
  return body.replace(/\{\{([^}]+)\}\}/g, (_, k: string) => vars[k.trim()] ?? `〔${k.trim()}〕`);
}

export function accessNote(): string {
  return getSetting('access_note');
}
