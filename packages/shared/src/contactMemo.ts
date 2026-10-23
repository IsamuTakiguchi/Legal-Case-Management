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
  /** 受付番号・証券番号など（「受付番号: 23-631-86252」） */
  note: string | null;
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
/** 会社・団体の名前らしい語（担当者名と見分ける） */
const COMPANY_WORDS = /保険|共済|損保|海上|火災|ほけん|株式会社|会社|\(株\)|事務所|法律|銀行|病院|クリニック|センター|組合|協会|Inc|Co\.|ニッセイ|日動|あいおい|ソニー|セゾン|アクサ|チューリッヒ|イーデザイン|SBI|三井住友|損害/;
/** 受付番号・証券番号などの行 */
const NUMBER_FIELD = /^((?:事故)?受付(?:番号|No\.?)|証券(?:番号|No\.?)|整理番号|事故番号|管理番号)\s*[:：]?\s*(.+)$/;

/** 「桧垣⇒岡田(物損)」→ 名前「桧垣⇒岡田」・区分「物損」 */
function splitDepartment(name: string): { name: string; department: string | null } {
  const m = /^(.+?)\s*\(([^()]{1,12})\)$/.exec(name);
  return m ? { name: m[1]!.trim(), department: m[2]!.trim().replace(/担当$/, '') } : { name, department: null };
}

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
  // 続けて書かれた担当者（「桧垣⇒岡田（物損）」「あさおか（人損）」）のあとの TEL・FAX は、その全員の番号（同じ窓口）
  let group: MemoContact[] = [];
  let groupHasFields = false;

  const roleFor = (organization: string | null): CaseContactRole => role ?? (organization && INSURER_WORDS.test(organization) ? 'insurer' : 'other');
  const start = (rawName: string, department: string | null) => {
    const sp = splitDepartment(rawName);
    cur = { role: roleFor(org), organization: org, department: department ?? sp.department, name: sp.name, phone: null, fax: null, emails: [], note: null };
    contacts.push(cur);
    if (groupHasFields) {
      group = [];
      groupHasFields = false;
    }
    group.push(cur);
    return cur;
  };
  const resetGroup = () => {
    group = [];
    groupHasFields = false;
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
      resetGroup();
      continue;
    }
    // 受付番号・証券番号など。その窓口の担当者全員のメモに残す
    const num = NUMBER_FIELD.exec(line);
    if (num) {
      const c = target();
      const label = `${num[1]}: ${num[2]!.trim()}`;
      for (const x of group.length ? group : c ? [c] : []) x.note = x.note ? `${x.note}\n${label}` : label;
      groupHasFields = true;
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
      for (const x of group.length ? group : [c]) {
        if (phone) x.phone = x.phone ? `${x.phone} / ${value}` : value;
        else if (fax) x.fax = x.fax ? `${x.fax} / ${value}` : value;
        else x.emails.push(...value.split(/[\s,;、]+/).filter((v) => v.includes('@')));
      }
      groupHasFields = true;
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
      resetGroup();
      start(parts.slice(1).join(' '), null);
      continue;
    }
    // 会社の担当者が続けて書かれた行（「あさおか（人損）」「森西様」）。会社名らしくなければ、同じ会社の担当者
    if (org && !COMPANY_WORDS.test(line) && (/\([^()]+\)$/.test(line) || /(様|さん|氏)$/.test(line) || cur)) {
      start(line, null);
      continue;
    }
    // 会社名だけの行（「JA共済」）。次の担当者の所属になる
    org = line;
    cur = null;
    resetGroup();
  }
  return { accidentDate, accidentDateText, contacts };
}

export interface InsurerPerson {
  id: number;
  name: string;
  organization: string | null;
  department: string | null;
  phone: string | null;
  fax: string | null;
  emails: string[];
  note: string | null;
}

/** 事件の概要に出す保険会社の連絡先（依頼者側・相手方・どちらか分からない、の順。会社ごとに、登録した順で担当者をまとめる） */
export function insurerSides<T extends InsurerPerson & { role: string }>(contacts: T[]): { role: CaseContactRole; companies: { organization: string; people: T[] }[] }[] {
  const order: CaseContactRole[] = ['client_insurer', 'opponent_insurer', 'insurer'];
  return order
    .map((role) => {
      const companies: { organization: string; people: T[] }[] = [];
      for (const c of contacts.filter((x) => x.role === role).sort((a, b) => a.id - b.id)) {
        const organization = c.organization?.trim() || c.name;
        const co = companies.find((x) => x.organization === organization);
        if (co) co.people.push(c);
        else companies.push({ organization, people: [c] });
      }
      return { role, companies };
    })
    .filter((s) => s.companies.length);
}

/** 「06-1111-2222 / 090-…」のように複数書かれた番号を分ける */
export function splitNumbers(s: string | null | undefined): string[] {
  return (s ?? '')
    .split(/\s*\/\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
}
