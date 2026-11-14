import { normalizePhones, clientNameCore, legalFormOf, looksLikeCorporation } from '@lcm/shared';
import { getSetting, setSetting } from './settings.js';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { logger } from '../logger.js';

/**
 * 同じ依頼者を二重に登録してしまったときの統合。
 * 事件・会話・タスク・記録・ファイルなどの紐付けを「残す依頼者」へ付け替え、
 * メールアドレスや LINE の紐付けをまとめてから、余分な依頼者を削除する。
 */

/** 名前の見た目の違い（空白・全角半角）を無視した比較用のキー */
export function normalizeClientName(name: string): string {
  return name.normalize('NFKC').replace(/[\s　]/g, '').toLowerCase();
}

export interface MergeCandidate {
  id: number;
  name: string;
  kana: string | null;
  emails: string[];
  phones: string[];
  aliases: string[];
  lineUserId: string | null;
  chatworkRoomId: number | null;
  onedriveFolderPath: string | null;
  preferredChannel: string | null;
  notes: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  counts: { cases: number; conversations: number; messages: number; tasks: number; notes: number; attachments: number; events: number };
  /** 情報の多さ（既定で「残す側」に選ぶ目安） */
  score: number;
}

export interface DuplicateGroup {
  key: string;
  name: string;
  clients: MergeCandidate[];
  /** 既定で残す依頼者（情報が最も多いもの。同じなら古い方） */
  suggestedKeepId: number;
  /** 名前が同じ（空白・全角半角の違いだけ）か。false なら法人格などが違うだけの似た名前 */
  exact: boolean;
  /** 1 文字違いの名前の組（別人のことも多いので、よく確かめる） */
  fuzzy: boolean;
  /** 似ていると判断した理由（法人格の有無・違い など） */
  reasons: string[];
  /** 統合後の名前に選べるもの（法人格の付いた正式な名前が先） */
  names: string[];
  /** 統合後の名前の既定（似た名前なら、法人格の付いた正式な名前） */
  suggestedName: string;
}

function countsFor(clientId: number): MergeCandidate['counts'] {
  const d = db();
  const n = (rows: unknown[]) => rows.length;
  const cases = d.select({ id: schema.cases.id }).from(schema.cases).where(eq(schema.cases.clientId, clientId)).all();
  const caseIds = cases.map((c) => c.id);
  return {
    cases: n(cases),
    conversations: n(d.select({ id: schema.conversations.id }).from(schema.conversations).where(eq(schema.conversations.clientId, clientId)).all()),
    messages: n(d.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.clientId, clientId)).all()),
    tasks: n(d.select({ id: schema.tasks.id }).from(schema.tasks).where(eq(schema.tasks.clientId, clientId)).all()),
    notes: n(caseIds.length ? d.select({ id: schema.caseNotes.id }).from(schema.caseNotes).where(inArray(schema.caseNotes.caseId, caseIds)).all() : []),
    attachments: n(d.select({ id: schema.attachments.id }).from(schema.attachments).where(eq(schema.attachments.clientId, clientId)).all()),
    events: n(d.select({ id: schema.calendarEvents.id }).from(schema.calendarEvents).where(eq(schema.calendarEvents.clientId, clientId)).all()),
  };
}

function candidate(c: typeof schema.clients.$inferSelect): MergeCandidate {
  const counts = countsFor(c.id);
  const score =
    counts.cases * 10 +
    counts.notes * 5 +
    counts.conversations * 3 +
    counts.tasks * 2 +
    counts.messages +
    counts.attachments +
    counts.events +
    (c.onedriveFolderPath ? 5 : 0) +
    (c.lineUserId ? 3 : 0) +
    (c.chatworkRoomId ? 3 : 0) +
    c.emails.length * 2 +
    (c.phones ?? []).length * 2 +
    (c.kana ? 1 : 0);
  return {
    id: c.id,
    name: c.name,
    kana: c.kana,
    emails: c.emails,
    phones: c.phones ?? [],
    aliases: c.aliases,
    lineUserId: c.lineUserId,
    chatworkRoomId: c.chatworkRoomId,
    onedriveFolderPath: c.onedriveFolderPath,
    preferredChannel: c.preferredChannel,
    notes: c.notes,
    archived: c.archived,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    counts,
    score,
  };
}

/** 「別の依頼者」として、重複の候補に出さない組（依頼者 ID の小さい方-大きい方） */
const IGNORE_KEY = 'client_duplicate_ignored';
function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}
function ignoredPairs(): Set<string> {
  try {
    const v = JSON.parse(getSetting(IGNORE_KEY) || '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * 選んだ依頼者どうしを「別の依頼者」として、重複の候補に出さないようにする。
 * fuzzy（1 文字違いの組）のときは、1 文字違いのつながりだけを外す（名前が同じ・法人格だけ違う者どうしは候補に残す）
 */
export function ignoreDuplicate(clientIds: number[], opts: { fuzzy?: boolean } = {}): { ignored: number } {
  const ids = [...new Set(clientIds)];
  if (ids.length < 2) throw new Error('2 人以上選んでください');
  const set = ignoredPairs();
  const comp = opts.fuzzy ? nameComponents().find : null;
  let n = 0;
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      if (comp && comp(ids[i]!) === comp(ids[j]!)) continue;
      set.add(pairKey(ids[i]!, ids[j]!));
      n++;
    }
  setSetting(IGNORE_KEY, JSON.stringify([...set]));
  return { ignored: n };
}

/** 1 文字だけ違う（1 文字の置き換え・抜け・余分）か */
export function oneCharApart(a: string, b: string): boolean {
  if (a === b) return false;
  const [s, t] = a.length <= b.length ? [a, b] : [b, a];
  const x = [...s];
  const y = [...t];
  if (y.length - x.length > 1) return false;
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  // 同じ長さなら 1 文字の置き換え、1 文字長いなら 1 文字の余分（抜け）
  return x.length === y.length ? x.slice(i + 1).join('') === y.slice(i + 1).join('') : x.slice(i).join('') === y.slice(i + 1).join('');
}

/** 1 文字違いを拾う名前の長さの下限（法人格などを除いた長さ。2 文字の名前どうしは偶然の一致が多い） */
const FUZZY_MIN_LENGTH = 3;
/** 1 文字違いの組を一度に出す上限（統合・「別の依頼者」で減れば、次の確認で残りが出る） */
const FUZZY_MAX_GROUPS = 200;

/**
 * 名前の芯（法人格・括弧書き・「様」などを除いた名前）や別名が同じ依頼者を、つながりごとにまとめる。
 * 「別の依頼者」にした組はつながない
 */
function nameComponents() {
  const rows = db().select().from(schema.clients).all();
  const ignored = ignoredPairs();
  const parent = new Map<number, number>(rows.map((r) => [r.id, r.id]));
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const buckets = new Map<string, Set<number>>();
  const put = (key: string, id: number) => {
    if (key.length < 2) return; // 1 文字の名前どうしは偶然の一致が多いので見ない
    const b = buckets.get(key) ?? new Set<number>();
    b.add(id);
    buckets.set(key, b);
  };
  for (const r of rows) {
    put(clientNameCore(r.name), r.id);
    for (const a of r.aliases ?? []) put(clientNameCore(a), r.id);
  }
  for (const ids of buckets.values()) {
    const list = [...ids];
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        if (ignored.has(pairKey(list[i]!, list[j]!))) continue;
        parent.set(find(list[i]!), find(list[j]!));
      }
  }
  const comps = new Map<number, typeof rows>();
  for (const r of rows) {
    const root = find(r.id);
    comps.set(root, [...(comps.get(root) ?? []), r]);
  }
  return { rows, comps, find, ignored };
}

/**
 * 同じ依頼者の二重登録らしい組を探す。
 * - 名前が同じ（空白・全角半角の違いは無視）
 * - 法人格・括弧書き・「様」などを除くと同じ（「正行寺」と「宗教法人正行寺」、「㈱ミクニ管材」と「ミクニ管材（代表 三國）」）
 * - 一方の名前が、もう一方に登録した別名と同じ
 * - 法人格などを除いた名前が 1 文字だけ違う（「正行寺」と「正福寺」、「山田花子」と「山田華子」）。3 文字以上の名前だけ
 * 「別の依頼者」にした組は出さない
 */
export function findDuplicateClients(): DuplicateGroup[] {
  const { comps, ignored } = nameComponents();
  const out: DuplicateGroup[] = [];
  // 同じ依頼者が何組にも出ることがあるので、件数の数え直しを 1 回で済ませる
  const cache = new Map<number, MergeCandidate>();
  const cand = (m: typeof schema.clients.$inferSelect) => cache.get(m.id) ?? cache.set(m.id, candidate(m)).get(m.id)!;
  const build = (members: (typeof schema.clients.$inferSelect)[], fuzzy: boolean): DuplicateGroup => {
    const clients = members.map(cand).sort((a, b) => b.score - a.score || a.id - b.id);
    const exact = !fuzzy && new Set(members.map((m) => normalizeClientName(m.name))).size === 1;
    const reasons: string[] = [];
    if (fuzzy) reasons.push('1 文字違い');
    if (!exact) {
      const forms = new Set(members.map((m) => legalFormOf(m.name)));
      if (forms.size > 1) reasons.push('法人格の有無・違い');
      if (members.some((m) => /[（(【]/.test(m.name))) reasons.push('括弧書きの違い');
      const cores = new Set(members.map((m) => clientNameCore(m.name)));
      if (!fuzzy && cores.size > 1) reasons.push('別名に登録した名前と一致');
      if (!reasons.length) reasons.push('「様」などの違い');
    }
    // 統合後の名前の候補。括弧書き（「（代表取締役 ○○）」など）を外した名前も並べ、
    // 法人格の付いた正式な名前 → 括弧書きの無い名前 → 長い名前 の順にする（1 文字違いは、情報の多い依頼者の名前を先に）
    const withoutParens = (n: string) => n.replace(/[（(][^（）()]*[）)]/g, '').replace(/[\s　]+$/g, '').trim();
    const hasParens = (n: string) => /[（(]/.test(n);
    const ordered = fuzzy ? clients.map((c) => c.name) : members.map((m) => m.name);
    let names = [...new Set(ordered.flatMap((n) => [n.trim(), withoutParens(n)]).filter(Boolean))];
    if (!fuzzy) names = names.sort((a, b) => Number(!!legalFormOf(b)) - Number(!!legalFormOf(a)) || Number(hasParens(a)) - Number(hasParens(b)) || b.length - a.length);
    return {
      key: `${fuzzy ? 'f' : 'g'}:${clients.map((c) => c.id).sort((a, b) => a - b).join('-')}`,
      name: clients[0]!.name,
      clients,
      suggestedKeepId: clients[0]!.id,
      exact,
      fuzzy,
      reasons,
      names,
      suggestedName: exact ? clients[0]!.name : names[0]!,
    };
  };
  const compList = [...comps.values()];
  for (const members of compList) if (members.length >= 2) out.push(build(members, false));

  // 1 文字違い（つながりどうしを比べる）。どちらかの名前・別名の芯が 1 文字違いなら、2 つのつながりを 1 組にする
  const coresOf = (members: typeof compList[number]) => [...new Set(members.flatMap((m) => [m.name, ...(m.aliases ?? [])].map(clientNameCore)))].filter((k) => [...k].length >= FUZZY_MIN_LENGTH);
  const compCores = compList.map(coresOf);
  let fuzzyCount = 0;
  for (let i = 0; i < compList.length && fuzzyCount < FUZZY_MAX_GROUPS; i++) {
    if (!compCores[i]!.length) continue;
    for (let j = i + 1; j < compList.length && fuzzyCount < FUZZY_MAX_GROUPS; j++) {
      if (!compCores[j]!.length) continue;
      if (!compCores[i]!.some((a) => compCores[j]!.some((b) => oneCharApart(a, b)))) continue;
      // 「別の依頼者」にした組み合わせ（2 つのつながりの間がすべて外してある）は出さない
      const cross = compList[i]!.flatMap((a) => compList[j]!.map((b) => pairKey(a.id, b.id)));
      if (cross.every((k) => ignored.has(k))) continue;
      out.push(build([...compList[i]!, ...compList[j]!], true));
      fuzzyCount++;
    }
  }
  // 名前が同じもの → 法人格などの違い → 1 文字違い の順
  const rank = (g: DuplicateGroup) => (g.exact ? 0 : g.fuzzy ? 2 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'ja'));
}

export interface MergeResult {
  keepId: number;
  mergedIds: number[];
  moved: { cases: number; conversations: number; messages: number; tasks: number; notes: number; attachments: number; events: number; sessions: number; styleSamples: number; forms: number; alerts: number };
  /** そのままにした情報（残す側と食い違ったもの）。あとで手で直せるように返す */
  conflicts: string[];
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}

/**
 * sourceIds の依頼者を keepId の依頼者に統合する。
 * 事件はそのまま（削除せず）keepId に付け替えるので、同じ依頼者に複数の事件が並ぶ形になる。
 */
export function mergeClients(keepId: number, sourceIds: number[], opts: { name?: string | null } = {}): MergeResult {
  const d = db();
  const keep = d.select().from(schema.clients).where(eq(schema.clients.id, keepId)).get();
  if (!keep) throw new Error('残す依頼者が見つかりません');
  const ids = [...new Set(sourceIds)].filter((id) => id !== keepId);
  if (ids.length === 0) throw new Error('統合する依頼者を選んでください');
  const sources = d.select().from(schema.clients).where(inArray(schema.clients.id, ids)).all();
  if (sources.length !== ids.length) throw new Error('統合する依頼者が見つかりません');

  const moved: MergeResult['moved'] = { cases: 0, conversations: 0, messages: 0, tasks: 0, notes: 0, attachments: 0, events: 0, sessions: 0, styleSamples: 0, forms: 0, alerts: 0 };
  const conflicts: string[] = [];
  const now = new Date().toISOString();

  d.transaction(() => {
    for (const src of sources) {
      const c = countsFor(src.id);
      moved.cases += c.cases;
      moved.conversations += c.conversations;
      moved.messages += c.messages;
      moved.tasks += c.tasks;
      moved.attachments += c.attachments;
      moved.events += c.events;
      moved.notes += d.select({ id: schema.caseNotes.id }).from(schema.caseNotes).where(eq(schema.caseNotes.clientId, src.id)).all().length;
      moved.sessions += d.select({ id: schema.schedulingSessions.id }).from(schema.schedulingSessions).where(eq(schema.schedulingSessions.clientId, src.id)).all().length;
      moved.styleSamples += d.select({ id: schema.styleSamples.id }).from(schema.styleSamples).where(eq(schema.styleSamples.clientId, src.id)).all().length;
      moved.forms += d.select({ id: schema.formTemplates.id }).from(schema.formTemplates).where(eq(schema.formTemplates.clientId, src.id)).all().length;

      // 紐付けの付け替え（事件・記録・会話・メッセージ・添付・タスク・日程調整・予定・文体サンプル・書式）
      d.update(schema.cases).set({ clientId: keepId, updatedAt: now }).where(eq(schema.cases.clientId, src.id)).run();
      d.update(schema.caseNotes).set({ clientId: keepId }).where(eq(schema.caseNotes.clientId, src.id)).run();
      d.update(schema.conversations).set({ clientId: keepId }).where(eq(schema.conversations.clientId, src.id)).run();
      d.update(schema.messages).set({ clientId: keepId }).where(eq(schema.messages.clientId, src.id)).run();
      d.update(schema.attachments).set({ clientId: keepId }).where(eq(schema.attachments.clientId, src.id)).run();
      d.update(schema.tasks).set({ clientId: keepId, updatedAt: now }).where(eq(schema.tasks.clientId, src.id)).run();
      d.update(schema.schedulingSessions).set({ clientId: keepId }).where(eq(schema.schedulingSessions.clientId, src.id)).run();
      d.update(schema.calendarEvents).set({ clientId: keepId }).where(eq(schema.calendarEvents.clientId, src.id)).run();
      d.update(schema.styleSamples).set({ clientId: keepId }).where(eq(schema.styleSamples.clientId, src.id)).run();
      d.update(schema.formTemplates).set({ clientId: keepId }).where(eq(schema.formTemplates.clientId, src.id)).run();
      // 法人の担当者も残す側へ（主担当は残す側にいればそちらを優先）
      const keepHasPrimary = !!d.select().from(schema.clientPersons).where(and(eq(schema.clientPersons.clientId, keepId), eq(schema.clientPersons.primary, true))).get();
      d.update(schema.clientPersons).set({ clientId: keepId, ...(keepHasPrimary ? { primary: false } : {}), updatedAt: now }).where(eq(schema.clientPersons.clientId, src.id)).run();

      // 要確認（アラート）の中の依頼者 ID も付け替える
      for (const a of d.select().from(schema.alerts).all()) {
        const payload = a.payload as Record<string, unknown>;
        if (Number(payload?.clientId) !== src.id) continue;
        d.update(schema.alerts).set({ payload: { ...payload, clientId: keepId } }).where(eq(schema.alerts.id, a.id)).run();
        moved.alerts++;
      }
    }

    // 連絡先などの情報をまとめる（残す側の値を優先し、空いているところだけ埋める）
    const patch: Partial<typeof schema.clients.$inferInsert> = { updatedAt: now };
    patch.emails = uniq([...keep.emails, ...sources.flatMap((s) => s.emails)]);
    // 電話番号は書き方が違っても同じ番号なら 1 つにする（残す側の書き方を優先）
    patch.phones = normalizePhones([...(keep.phones ?? []), ...sources.flatMap((s) => s.phones ?? [])]);
    // 統合後の名前（「宗教法人正行寺」など、選んだ正式な名前）。前の名前は別名に残す（メール・予定の照合に使う）
    const finalName = opts.name?.trim() || keep.name;
    if (finalName !== keep.name) patch.name = finalName;
    patch.aliases = uniq([...keep.aliases, keep.name, ...sources.flatMap((s) => [...s.aliases, s.name])]).filter((a) => a !== finalName);
    patch.kana = keep.kana ?? sources.find((s) => s.kana)?.kana ?? null;
    // 法人の代表者は、残す側に無ければ統合する側から引き継ぐ
    if (!keep.representativeName) {
      const s = sources.find((x) => x.representativeName);
      if (s) {
        patch.representativeTitle = s.representativeTitle;
        patch.representativeName = s.representativeName;
        patch.representativeKana = s.representativeKana;
      }
    }
    if (keep.entityType !== 'corporation' && (sources.some((s) => s.entityType === 'corporation') || looksLikeCorporation(finalName))) patch.entityType = 'corporation';
    patch.preferredChannel = keep.preferredChannel ?? sources.find((s) => s.preferredChannel)?.preferredChannel ?? null;
    if (!keep.lineUserId) {
      patch.lineUserId = sources.find((s) => s.lineUserId)?.lineUserId ?? null;
    } else {
      for (const s of sources) if (s.lineUserId && s.lineUserId !== keep.lineUserId) conflicts.push(`${s.name}（ID ${s.id}）の LINE の紐付けは引き継いでいません（残す側に別の紐付けがあるため）`);
    }
    if (!keep.chatworkRoomId) {
      const s = sources.find((x) => x.chatworkRoomId);
      patch.chatworkRoomId = s?.chatworkRoomId ?? null;
      patch.chatworkAccountId = keep.chatworkAccountId ?? s?.chatworkAccountId ?? null;
    } else {
      for (const s of sources) if (s.chatworkRoomId && s.chatworkRoomId !== keep.chatworkRoomId) conflicts.push(`${s.name}（ID ${s.id}）の Chatwork ルームは引き継いでいません（残す側に別のルームがあるため）`);
    }
    if (!keep.onedriveFolderPath?.trim()) {
      const s = sources.find((x) => x.onedriveFolderPath?.trim());
      patch.onedriveFolderPath = s?.onedriveFolderPath ?? null;
      patch.onedriveItemId = s?.onedriveItemId ?? keep.onedriveItemId ?? null;
    } else {
      for (const s of sources) {
        const p = s.onedriveFolderPath?.trim();
        if (p && p !== keep.onedriveFolderPath?.trim()) conflicts.push(`OneDrive のフォルダ「${p}」は統合していません。中身は手で移してください（残す側は「${keep.onedriveFolderPath}」）`);
      }
    }
    const log = `${now.slice(0, 10)} ${sources.map((s) => `${s.name}（ID ${s.id}）`).join('、')}を統合`;
    patch.notes = [keep.notes, ...sources.map((s) => s.notes).filter((n) => n && n.trim()), log].filter((n): n is string => !!n && !!n.trim()).join('\n');
    // 片方が非表示でも、統合後は表示する
    patch.archived = false;
    d.update(schema.clients).set(patch).where(eq(schema.clients.id, keepId)).run();

    d.delete(schema.clients).where(inArray(schema.clients.id, ids)).run();
  });

  logger.info({ keepId, mergedIds: ids, moved }, '依頼者を統合しました');
  return { keepId, mergedIds: ids, moved, conflicts };
}
