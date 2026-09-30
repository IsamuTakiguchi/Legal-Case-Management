import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from './api';
import { useDraft, DraftHint } from './draft';
import { CASE_CONTACT_ROLES, CASE_CONTACT_ROLE_LABEL, formatWareki, type MemoContact } from '@lcm/shared';

interface Parsed {
  accidentDate: string | null;
  accidentDateText: string | null;
  contacts: MemoContact[];
  by: 'rule' | 'ai';
}

const PLACEHOLDER = `例:
事故日：R5.9.10

依頼者側保険会社
東京海上日動　岡田
TEL:06-0000-0000
FAX:050-0000-0000

相手方側保険会社
JA共済
物損担当　青木
TEL:0742-00-0000
人損担当　森西
TEL:0742-00-0000`;

/**
 * メモ（事故日・保険会社の担当者・電話・FAX など）を貼り付けて、まとめて関係者に登録する。
 * 読み取った内容は登録前に一覧で確かめ、区分や担当者名を直せる
 */
export function ContactMemoImport({ caseId, onDone, onClose }: { caseId: number; onDone: (summary: string) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const draft = useDraft(`case:${caseId}:contact-memo`, text, setText, '');
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [rows, setRows] = useState<(MemoContact & { use: boolean })[]>([]);
  const [useDate, setUseDate] = useState(true);
  const [err, setErr] = useState('');

  const read = useMutation({
    mutationFn: () => api.post<Parsed>(`/cases/${caseId}/contacts/parse`, { text }),
    onSuccess: (r) => {
      setParsed(r);
      setRows(r.contacts.map((c) => ({ ...c, use: true })));
      setUseDate(!!r.accidentDate);
      setErr(r.contacts.length || r.accidentDate ? '' : '事故日も連絡先も読み取れませんでした。「会社名 担当者名」「TEL:」「FAX:」の形で書くと読み取れます');
    },
    onError: (e) => setErr((e as Error).message),
  });
  const save = useMutation({
    mutationFn: () =>
      api.post<{ created: number; updated: number; accidentDate: string | null }>(`/cases/${caseId}/contacts/import`, {
        accidentDate: useDate ? parsed?.accidentDate : null,
        contacts: rows.filter((r) => r.use).map(({ use: _use, ...c }) => c),
      }),
    onSuccess: (r) => {
      draft.clear();
      const parts: string[] = [];
      if (useDate && parsed?.accidentDate) parts.push(`事故日を ${formatWareki(parsed.accidentDate)} にしました`);
      if (r.created) parts.push(`関係者を ${r.created} 件登録しました`);
      if (r.updated) parts.push(`登録済みの ${r.updated} 件に電話・FAX などを補いました`);
      onDone(parts.join('。') || '変更はありませんでした');
    },
    onError: (e) => setErr((e as Error).message),
  });
  const setRow = (i: number, patch: Partial<MemoContact & { use: boolean }>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const chosen = rows.filter((r) => r.use).length + (useDate && parsed?.accidentDate ? 1 : 0);

  return (
    <div className="fade-in mb-3 space-y-2 rounded-md border border-blue-200 bg-blue-50/40 p-2">
      <div className="text-xs text-slate-600">事故日や保険会社の担当者・電話・FAX を書いたメモを貼り付けると、まとめて登録できます。</div>
      <textarea
        className="input min-h-36 w-full font-mono text-xs"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setParsed(null);
        }}
        placeholder={PLACEHOLDER}
        aria-label="貼り付けるメモ"
      />
      <DraftHint handle={draft} />
      {!parsed && (
        <div className="flex gap-2">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => read.mutate()} disabled={!text.trim() || read.isPending}>
            {read.isPending ? '読み取り中…' : '読み取る'}
          </button>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            やめる
          </button>
        </div>
      )}
      {parsed && (parsed.contacts.length > 0 || parsed.accidentDate || parsed.accidentDateText) && (
        <div className="space-y-2">
          <div className="text-xs font-semibold text-slate-700">読み取った内容（確かめてから登録してください{parsed.by === 'ai' ? '・AI で読み取りました' : ''}）</div>
          {(parsed.accidentDate || parsed.accidentDateText) && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={useDate && !!parsed.accidentDate} disabled={!parsed.accidentDate} onChange={(e) => setUseDate(e.target.checked)} />
              <span className="badge badge-gray">事故日</span>
              {parsed.accidentDate ? (
                <span>
                  {formatWareki(parsed.accidentDate)}
                  <span className="ml-1 text-xs text-slate-500">（{parsed.accidentDate.replace(/-/g, '/')}）</span>
                </span>
              ) : (
                <span className="text-xs text-orange-700">「{parsed.accidentDateText}」を日付として読めませんでした。事件情報の「事故日」に直接入れてください</span>
              )}
            </label>
          )}
          <ul className="space-y-1.5">
            {rows.map((r, i) => (
              <li key={i} className={`rounded border border-slate-200 bg-white p-1.5 text-xs ${r.use ? '' : 'opacity-50'}`}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <input type="checkbox" checked={r.use} onChange={(e) => setRow(i, { use: e.target.checked })} aria-label="登録する" />
                  <select className="input w-auto py-0.5 text-xs" value={r.role} onChange={(e) => setRow(i, { role: e.target.value as MemoContact['role'] })} aria-label="区分">
                    {CASE_CONTACT_ROLES.map((x) => (
                      <option key={x} value={x}>
                        {CASE_CONTACT_ROLE_LABEL[x]}
                      </option>
                    ))}
                  </select>
                  <input className="input w-28 py-0.5 text-xs" value={r.organization ?? ''} onChange={(e) => setRow(i, { organization: e.target.value || null })} placeholder="会社名" aria-label="会社名" />
                  <input className="input w-16 py-0.5 text-xs" value={r.department ?? ''} onChange={(e) => setRow(i, { department: e.target.value || null })} placeholder="担当" aria-label="担当の区分" />
                  <input className="input w-24 py-0.5 text-xs" value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} placeholder="担当者名" aria-label="担当者名" />
                </div>
                <div className="mt-0.5 pl-5 text-slate-600">
                  {r.phone && <span className="mr-3 whitespace-nowrap">TEL {r.phone}</span>}
                  {r.fax && <span className="mr-3 whitespace-nowrap">FAX {r.fax}</span>}
                  {r.emails.length > 0 && <span>{r.emails.join(', ')}</span>}
                </div>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => save.mutate()} disabled={!chosen || rows.some((r) => r.use && !r.name.trim()) || save.isPending}>
              {save.isPending ? '登録中…' : '登録する'}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setParsed(null)}>
              メモを直す
            </button>
            <button type="button" className="btn btn-sm" onClick={onClose}>
              やめる
            </button>
          </div>
        </div>
      )}
      {err && <div className="text-xs text-red-600">{err}</div>}
    </div>
  );
}
