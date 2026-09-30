import { parseJaDate } from './wareki.js';
import type { CaseContactRole } from './types.js';

export interface MemoContact {
  role: CaseContactRole;
  organization: string | null;
  /** 担当の区分（物損・人損など） */
  department: string | null;
  name: string;
  phone: string | null;
  fax: string | null;
  emails: string[];
}

export interface ContactMemo {
  /** 事故日（YYYY-MM-DD）。書いていない・読めないときは null */
  accidentDate: string | null;
  /** 事故日として書いてあった文字（読めなかったときに画面に出す） */
  accidentDateText: string | null;
  contacts: MemoContact[];
}

const FIELD = {
  phone: /^(?:TEL|Tel|tel|電話(?:番号)?|☎)\s*[:：]?\s*(.*)$/,
  fax: /^(?:FAX|Fax|fax|ファ(?:ッ)?クス)\s*[:：]?\s*(.*)$/,
  mail: /^(?:e-?mail|E-?mail|E-?MAIL|mail|Mail|MAIL|メール(?:アドレス)?)\s*[:：]?\s*(.*)$/,
};
const INSURER_WORDS = /保険|共済|損保|海上|火災|ほけん/;

/** 見出しの行（「依頼者側保険会社」「相手方側保険会社」など）なら、その区分 */
function sectionRole(line: string): CaseContactRole | null {
  if (line.length > 20) return null;
  if (/(相手方|相手|加害者|先方)/.test(line) && /(保険|共済)/.test(line)) return 'opponent_insurer';
  if (/(依頼者|当方|こちら|被害者|自社|依頼人)/.test(line) && /(保険|共済)/.test(line)) return 'client_insurer';
  if (/^(相手方代理人|相手方弁護士)$/.test(line)) return 'opponent_counsel';
  if (/^相手方$/.test(line)) return 'opponent';
  return null;
}

/**
 * 交通事故などのメモ（事故日・保険会社の担当者・電話・FAX・メール）を読み取る。
 * 例:
 *   事故日：R5.9.10
 *   依頼者側保険会社
 *   東京海上日動　岡田
 *   TEL:06-…  FAX:050-…  mail:
 *   相手方側保険会社
 *   JA共済
 *   物損担当　青木
 *   TEL:…
 */
export function parseContactMemo(text: string): ContactMemo {
  const lines = text
    .normalize('NFKC')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  let accidentDate: string | null = null;
  let accidentDateText: string | null = null;
  let role: CaseContactRole | null = null;
  let org: string | null = null;
  let cur: MemoContact | null = null;
  const contacts: MemoContact[] = [];

  const roleFor = (organization: string | null): CaseContactRole => role ?? (organization && INSURER_WORDS.test(organization) ? 'insurer' : 'other');
  const start = (name: string, department: string | null) => {
    cur = { role: roleFor(org), organization: org, department, name, phone: null, fax: null, emails: [] };
    contacts.push(cur);
    return cur;
  };
  // 担当者名の無い連絡先（会社の代表番号など）は、会社名を名前にする
  const target = (): MemoContact | null => cur ?? (org ? start(org, null) : null);

  for (const line of lines) {
    const date = /^事故(?:日|日時|発生日)\s*[:：]?\s*(.+)$/.exec(line);
    if (date) {
      accidentDateText = date[1]!.trim();
      accidentDate = parseJaDate(accidentDateText.split(' ')[0]);
      continue;
    }
    const sec = sectionRole(line);
    if (sec) {
      role = sec;
      org = null;
      cur = null;
      continue;
    }
    const phone = FIELD.phone.exec(line);
    const fax = FIELD.fax.exec(line);
    const mail = FIELD.mail.exec(line);
    if (phone || fax || mail) {
      const value = (phone ?? fax ?? mail)![1]!.trim();
      if (!value) continue;
      const c = target();
      if (!c) continue;
      if (phone) c.phone = c.phone ? `${c.phone} / ${value}` : value;
      else if (fax) c.fax = c.fax ? `${c.fax} / ${value}` : value;
      else c.emails.push(...value.split(/[\s,;、]+/).filter((v) => v.includes('@')));
      continue;
    }
    // 「物損担当 青木」「人損担当：森西」
    const dept = /^(.+?)担当(?:者)?\s*[:：]?\s*(.+)$/.exec(line);
    if (dept) {
      start(dept[2]!.trim(), dept[1]!.trim());
      continue;
    }
    // 「東京海上日動 岡田」（会社名と担当者名）
    const parts = line.split(' ');
    if (parts.length >= 2) {
      org = parts[0]!;
      start(parts.slice(1).join(' '), null);
      continue;
    }
    // 会社名だけの行（「JA共済」）。次の担当者の所属になる
    org = line;
    cur = null;
  }
  return { accidentDate, accidentDateText, contacts };
}
