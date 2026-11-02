import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { CASE_CONTACT_ROLE_LABEL, phoneDigits, type CaseContactRole } from '@lcm/shared';

/**
 * 記録の「相手」「電話番号」の候補。
 * 過去の記録に入れた相手・電話番号と、登録してある依頼者・担当者・事件の関係者の電話番号から作り、
 * 画面でボタンを押すとそのまま入力できるようにする
 */
export interface NoteContactSuggestion {
  name: string;
  phone: string | null;
  /** 候補の出どころ（画面の補足に出す。例: 「この事件の記録 3 回」「相手方代理人」） */
  hint: string;
}

/** 相手として意味のある記録の種別（進捗・メモの「依頼者に確認」などは候補にしない） */
const CONTACT_KINDS = ['phone', 'meeting', 'court'];

const norm = (s: string) => s.replace(/[\s　]/g, '');

export function noteContactSuggestions(caseId: number | null, limit = 150): NoteContactSuggestion[] {
  const d = db();
  const kase = caseId ? d.select().from(schema.cases).where(eq(schema.cases.id, caseId)).get() : null;
  const out: (NoteContactSuggestion & { key: string })[] = [];
  const add = (name: string | null | undefined, phone: string | null | undefined, hint: string) => {
    const n = name?.trim() ?? '';
    const p = phone?.trim() || null;
    if (!n && !p) return;
    const key = `${norm(n)}|${p ? phoneDigits(p) : ''}`;
    if (out.some((x) => x.key === key)) return;
    // 名前だけの候補は、同じ名前で電話番号のある候補があれば要らない（逆に後から番号付きが来たら置き換える）
    if (!p && out.some((x) => norm(x.name) === norm(n) && x.phone)) return;
    if (p) {
      const i = out.findIndex((x) => norm(x.name) === norm(n) && !x.phone);
      if (i >= 0) {
        out[i] = { name: n, phone: p, hint: out[i]!.hint, key };
        return;
      }
    }
    out.push({ name: n, phone: p, hint, key });
  };

  // 過去の記録（新しい順）。同じ相手は回数をまとめる
  const history = (where: ReturnType<typeof and>, label: string) => {
    const rows = d
      .select({ counterpart: schema.caseNotes.counterpart, phone: schema.caseNotes.phone })
      .from(schema.caseNotes)
      .where(where)
      .orderBy(desc(schema.caseNotes.occurredAt))
      .limit(300)
      .all();
    const counts = new Map<string, number>();
    for (const r of rows) {
      const key = `${norm(r.counterpart ?? '')}|${r.phone ? phoneDigits(r.phone) : ''}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const r of rows) {
      const key = `${norm(r.counterpart ?? '')}|${r.phone ? phoneDigits(r.phone) : ''}`;
      const n = counts.get(key) ?? 1;
      add(r.counterpart, r.phone, n > 1 ? `${label} ${n} 回` : label);
    }
  };

  if (kase) {
    history(and(eq(schema.caseNotes.caseId, kase.id), inArray(schema.caseNotes.kind, CONTACT_KINDS)), 'この事件の記録');
    // 登録してある連絡先: 事件の関係者 → 依頼者 → 法人の担当者
    for (const c of d.select().from(schema.caseContacts).where(eq(schema.caseContacts.caseId, kase.id)).all()) {
      const role = CASE_CONTACT_ROLE_LABEL[c.role as CaseContactRole] ?? '関係者';
      add(c.name, c.phone, c.organization ? `${role}（${c.organization}）` : role);
    }
    const client = d.select().from(schema.clients).where(eq(schema.clients.id, kase.clientId)).get();
    if (client) {
      if (client.phones.length) for (const p of client.phones) add(client.name, p, '依頼者');
      else add(client.name, null, '依頼者');
      for (const p of d.select().from(schema.clientPersons).where(eq(schema.clientPersons.clientId, client.id)).all()) {
        const hint = p.title ? `依頼者の担当者（${p.title}）` : '依頼者の担当者';
        if (p.phones.length) for (const ph of p.phones) add(p.name, ph, hint);
        else add(p.name, null, hint);
      }
      history(and(eq(schema.caseNotes.clientId, client.id), inArray(schema.caseNotes.kind, CONTACT_KINDS)), '同じ依頼者の記録');
    }
  }
  // ほかの事件の記録（裁判所の書記官や保険会社など、事件をまたいで電話する相手）
  history(inArray(schema.caseNotes.kind, CONTACT_KINDS), 'ほかの事件の記録');
  return out.slice(0, limit).map(({ key: _key, ...s }) => s);
}
