import { and, desc, eq, lt } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { draftReply } from './style.js';
import { sendToConversation } from './send.js';
import { createTask, defaultFollowUp } from './tasks.js';
import { activeCasesForClient } from './cases.js';
import { availableChannels, ensureClientConversation } from './hearingNotice.js';
import { clientOwnConversations, contactRoleLabel, listContacts, type ContactRow } from './contacts.js';
import { getClientPerson } from './clientPersons.js';
import { adapterFor } from '../channels/registry.js';
import { stripChatworkMarkup } from '../channels/chatwork.js';
import { isConfigured } from '../config.js';
import { logger } from '../logger.js';
import { CHANNEL_LABEL, familyName, formatJaDateTime, type Channel } from '@lcm/shared';

/**
 * 連絡の取次ぎ（伝える）。
 * - 依頼者から来た連絡・質問を、弁護士から相手方代理人など事件の関係者への連絡に書き直して送る（to_counterparty）
 * - 相手方代理人など事件の関係者から来た連絡・質問を、弁護士から依頼者への連絡に書き直して送る（to_client）
 * どちらも AI が本人の文体で下書きし、弁護士が確認・修正してから送る。送った記録は元のメッセージに残す
 */

export type RelayDirection = 'to_counterparty' | 'to_client';
export type RelayChannel = 'gmail' | 'line' | 'chatwork';

export interface RelayTarget {
  /** 画面で選ぶときの鍵（例: contact:3:gmail / client:12:line / contact:3:manual） */
  key: string;
  kind: 'contact' | 'client';
  contactId: number | null;
  /** 依頼者の窓口・担当者宛なら、その人 */
  personId: number | null;
  /** 送る手段。null は連絡先が無く送れない（FAX・郵送用に文面だけ作る） */
  channel: RelayChannel | null;
  /** 宛名（相手方代理人の氏名、依頼者名など） */
  recipient: string;
  /** 関係者の立場（相手方代理人など）。依頼者宛は null */
  roleLabel: string | null;
  organization: string | null;
  /** 宛先の表示（メールアドレス、LINE など） */
  to: string;
  /** 既存の会話（無ければ送ったときに作る） */
  conversationId: number | null;
  /** Gmail の既存スレッドの件名（返信になる）。新しいメールなら null */
  subject: string | null;
  /** FAX 番号（送れない相手のとき、FAX で送る目安に出す） */
  fax: string | null;
}

/** 元のメッセージに残す「伝えた」記録 */
export interface RelayRecord {
  direction: RelayDirection;
  targetKey: string;
  recipient: string;
  /** manual は FAX・郵送などアプリの外で送ったもの */
  channel: RelayChannel | 'manual';
  conversationId: number | null;
  messageId: number | null;
  at: string;
}

export interface RelayContext {
  messageId: number;
  direction: RelayDirection;
  message: { senderName: string | null; sentAt: string; body: string };
  /** 直前のやり取り（参考） */
  earlier: { senderName: string | null; direction: string; sentAt: string; body: string }[];
  clientId: number | null;
  clientName: string | null;
  caseId: number | null;
  caseTitle: string | null;
  cases: { id: number; title: string }[];
  /** 元の連絡をくれた関係者（to_client のとき） */
  from: { contactId: number; name: string; roleLabel: string } | null;
  targets: RelayTarget[];
  defaultTargetKey: string | null;
  defaultFollowUpAt: string;
  sent: RelayRecord[];
  /** 送れない理由（事件が無い、関係者が未登録 など） */
  blocked: string | null;
}

type MessageRow = typeof schema.messages.$inferSelect;
type ConversationRow = typeof schema.conversations.$inferSelect;

function channelConfigured(channel: Channel): boolean {
  try {
    return adapterFor(channel).isConfigured();
  } catch {
    return false;
  }
}

function recordsOf(msg: MessageRow): RelayRecord[] {
  const raw = (msg.raw ?? {}) as { relays?: RelayRecord[] };
  return Array.isArray(raw.relays) ? raw.relays : [];
}

function loadSource(messageId: number): { msg: MessageRow; conv: ConversationRow; direction: RelayDirection } {
  const d = db();
  const msg = d.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
  if (!msg) throw new Error('メッセージが見つかりません');
  const conv = d.select().from(schema.conversations).where(eq(schema.conversations.id, msg.conversationId)).get();
  if (!conv) throw new Error('会話が見つかりません');
  if (msg.direction !== 'in') throw new Error('自分が送ったメッセージからは作れません');
  // 関係者（相手方代理人など）との会話なら依頼者へ、依頼者との会話なら関係者へ
  if (conv.contactId) return { msg, conv, direction: 'to_client' };
  if (conv.clientId && !(conv.meta as { staff?: boolean }).staff) return { msg, conv, direction: 'to_counterparty' };
  throw new Error('依頼者か事件の関係者と紐付いた会話のメッセージから作れます');
}

/** 関係者に送れる手段（メール・LINE）と、それぞれの既存の会話。連絡先が無ければ「文面だけ」の宛先にする */
function contactTargets(contacts: ContactRow[]): RelayTarget[] {
  // 相手方代理人を先に、次に相手方・保険会社など
  const rank = (r: string) => (r === 'opponent_counsel' ? 0 : r === 'opponent' ? 1 : r === 'opponent_insurer' ? 2 : 3);
  const out: RelayTarget[] = [];
  for (const k of [...contacts].sort((a, b) => rank(a.role) - rank(b.role))) {
    const convs = db()
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.contactId, k.id))
      .all()
      .filter((c) => !c.archived)
      .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
    const base = { kind: 'contact' as const, contactId: k.id, personId: null, recipient: k.name, roleLabel: contactRoleLabel(k.role), organization: k.organization, fax: k.fax };
    let any = false;
    if (k.emails[0] && channelConfigured('gmail')) {
      const conv = convs.find((c) => c.channel === 'gmail') ?? null;
      const isNew = !conv || conv.externalThreadId.startsWith('new:');
      out.push({ ...base, key: `contact:${k.id}:gmail`, channel: 'gmail', to: k.emails[0], conversationId: conv?.id ?? null, subject: isNew ? null : (conv?.subject ?? null) });
      any = true;
    }
    if (k.lineUserId && channelConfigured('line')) {
      const conv = convs.find((c) => c.channel === 'line') ?? null;
      out.push({ ...base, key: `contact:${k.id}:line`, channel: 'line', to: 'LINE', conversationId: conv?.id ?? null, subject: null });
      any = true;
    }
    // 送る手段が無い相手（FAX・郵送でやり取りする代理人など）は、文面だけ作れるようにする
    if (!any) out.push({ ...base, key: `contact:${k.id}:manual`, channel: null, to: k.fax ? `FAX ${k.fax}` : '連絡先（メール・LINE）未登録', conversationId: null, subject: null });
  }
  return out;
}

/** 依頼者本人（窓口・担当者を含む）に送れる手段 */
function clientTargets(client: typeof schema.clients.$inferSelect): RelayTarget[] {
  const own = clientOwnConversations(client.id).filter((c) => !c.archived);
  return availableChannels(client)
    .filter((x): x is typeof x & { channel: RelayChannel } => x.channel === 'gmail' || x.channel === 'line' || x.channel === 'chatwork')
    .map((x) => {
      const conv = own.filter((c) => c.channel === x.channel && (c.clientPersonId ?? null) === x.personId).sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''))[0] ?? null;
      const isNew = !conv || conv.externalThreadId.startsWith('new:');
      return {
        key: `client:${x.personId ?? 0}:${x.channel}`,
        kind: 'client' as const,
        contactId: null,
        personId: x.personId,
        channel: x.channel,
        recipient: x.recipient,
        roleLabel: null,
        organization: null,
        to: x.to,
        conversationId: conv?.id ?? null,
        subject: x.channel === 'gmail' && !isNew ? (conv?.subject ?? null) : null,
        fax: null,
      };
    });
}

export function relayContext(messageId: number, opts: { caseId?: number | null } = {}): RelayContext {
  const d = db();
  const { msg, conv, direction } = loadSource(messageId);
  let client: typeof schema.clients.$inferSelect | null = null;
  let kase: typeof schema.cases.$inferSelect | null = null;
  let from: RelayContext['from'] = null;
  let cases: { id: number; title: string }[] = [];
  let targets: RelayTarget[] = [];

  if (direction === 'to_client') {
    // 関係者の事件の依頼者へ
    const contact = d.select().from(schema.caseContacts).where(eq(schema.caseContacts.id, conv.contactId!)).get();
    if (!contact) throw new Error('関係者が見つかりません');
    kase = d.select().from(schema.cases).where(eq(schema.cases.id, contact.caseId)).get() ?? null;
    client = kase ? (d.select().from(schema.clients).where(eq(schema.clients.id, kase.clientId)).get() ?? null) : null;
    from = { contactId: contact.id, name: contact.name, roleLabel: contactRoleLabel(contact.role) };
    cases = kase ? [{ id: kase.id, title: kase.title }] : [];
    targets = client ? clientTargets(client) : [];
  } else {
    // 依頼者の事件の関係者へ。事件: 画面で選んだもの → メッセージ・会話の事件 → 進行中の事件の先頭
    client = d.select().from(schema.clients).where(eq(schema.clients.id, conv.clientId!)).get() ?? null;
    const active = client ? activeCasesForClient(client.id) : [];
    cases = active.map((k) => ({ id: k.id, title: k.title }));
    const wanted = opts.caseId ?? msg.caseId ?? conv.caseId ?? null;
    const w = wanted ? (d.select().from(schema.cases).where(eq(schema.cases.id, wanted)).get() ?? null) : null;
    kase = w && w.clientId === client?.id ? w : (active[0] ?? null);
    if (kase && !cases.some((k) => k.id === kase!.id)) cases = [{ id: kase.id, title: kase.title }, ...cases];
    targets = kase ? contactTargets(listContacts(kase.id)) : [];
  }

  const earlier = d
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conv.id), lt(schema.messages.sentAt, msg.sentAt)))
    .orderBy(desc(schema.messages.sentAt))
    .limit(3)
    .all()
    .reverse()
    .map((m) => ({ senderName: m.senderName, direction: m.direction, sentAt: m.sentAt, body: stripChatworkMarkup(m.body).slice(0, 800) }));

  const blocked = !client
    ? '依頼者が分かりません'
    : !kase
      ? direction === 'to_counterparty'
        ? `${client.name}さんの事件が登録されていません`
        : '事件が分かりません'
      : targets.length === 0
        ? direction === 'to_counterparty'
          ? `「${kase.title}」に相手方代理人などの関係者が登録されていません。事件ページの「関係者」で登録してください`
          : `${client.name}さんのメールアドレス・LINE・Chatwork ルームが登録されていないか、そのチャネルがアプリに接続されていません`
        : null;
  // 既定の宛先: 送れる相手を先に（相手方代理人のメール → … ）。依頼者宛は希望のチャネル
  const sendable = targets.filter((t) => t.channel);
  const preferred = direction === 'to_client' ? sendable.find((t) => t.channel === client?.preferredChannel) : null;
  const defaultTarget = preferred ?? sendable[0] ?? targets[0] ?? null;

  return {
    messageId: msg.id,
    direction,
    message: { senderName: msg.senderName, sentAt: msg.sentAt, body: stripChatworkMarkup(msg.body) },
    earlier,
    clientId: client?.id ?? null,
    clientName: client?.name ?? null,
    caseId: kase?.id ?? null,
    caseTitle: kase?.title ?? null,
    cases,
    from,
    targets,
    defaultTargetKey: defaultTarget?.key ?? null,
    defaultFollowUpAt: defaultFollowUp().toISOString(),
    sent: recordsOf(msg),
    blocked,
  };
}

/** AI への指示 */
export function relayInstruction(ctx: Pick<RelayContext, 'direction' | 'message' | 'earlier' | 'clientName' | 'caseTitle' | 'from'>, target: Pick<RelayTarget, 'recipient' | 'roleLabel'>, extra?: string | null): string {
  const earlier = ctx.earlier.map((m) => `[${m.direction === 'out' ? '弁護士' : (m.senderName ?? '相手')}] ${m.body}`).join('\n');
  const rules =
    ctx.direction === 'to_counterparty'
      ? [
          `依頼者（${ctx.clientName ?? '依頼者'}）から届いた連絡・質問のうち、${target.roleLabel ?? '相手方代理人'}（${target.recipient}）に伝えるべきことを、依頼者の代理人である弁護士から相手方への連絡文に書き直してください。`,
          '・代理人間の連絡として、丁寧で簡潔な文にする（「当方依頼者によれば〜とのことです」「〜についてご回答をお願いいたします」など）。',
          '・依頼者の感情的な表現、内心、交渉の方針・譲歩の余地、依頼者に不利になり得る事情、相手方に伝える必要のない私的な事情は書かない。伝えてよいか判断が要る点は〔要確認〕と書く。',
          '・依頼者の文面をそのまま引用せず、要旨にする。依頼者の個人的な連絡先などは書かない。',
          '・相手方に尋ねることや求めることがあれば、番号を付けて並べる。',
          '・依頼者の連絡に無い事実・金額・期限は足さない。',
        ]
      : [
          `${ctx.from?.roleLabel ?? '相手方代理人'}（${ctx.from?.name ?? ''}）から届いた連絡・質問を、弁護士から依頼者（${target.recipient}）に伝えるメッセージに書き直してください。`,
          `・「${ctx.from?.roleLabel ?? '相手方代理人'}から〜との連絡がありました」と、誰から何が来たかが分かるように伝える。`,
          '・法律用語や代理人どうしの言い回しは、依頼者に分かる平易な言葉にする。',
          '・依頼者に答えてもらいたいこと・用意してもらいたいものがあれば、番号を付けて並べる。期限が書かれていれば入れる。',
          '・相手方の主張への評価や見通しは書かない（弁護士の追加の指示があればそれに従う）。強い表現や依頼者を責める表現は、そのまま伝えず要旨にする。',
          '・相手方の連絡に無い事実・金額・期限は足さない。',
        ];
  return [
    ...rules,
    ctx.caseTitle ? `・事件: ${ctx.caseTitle}` : '',
    '',
    `【${ctx.direction === 'to_counterparty' ? `依頼者（${ctx.message.senderName ?? ctx.clientName ?? '依頼者'}）からの連絡` : `${ctx.from?.roleLabel ?? '相手方'}からの連絡`}・${formatJaDateTime(new Date(ctx.message.sentAt))}】`,
    ctx.message.body,
    earlier ? `\n【その前のやり取り（参考。ここから伝える事項を増やさない）】\n${earlier}` : '',
    extra ? `\n【弁護士からの追加の指示（最優先）】\n${extra}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function pickTarget(ctx: RelayContext, key: string): RelayTarget {
  if (ctx.blocked) throw new Error(ctx.blocked);
  const t = ctx.targets.find((x) => x.key === key);
  if (!t) throw new Error('送り先が見つかりません');
  return t;
}

function defaultSubject(ctx: RelayContext): string {
  return ctx.direction === 'to_counterparty' ? `ご連絡${ctx.caseTitle ? `（${ctx.caseTitle}）` : ''}` : `相手方からの連絡について${ctx.caseTitle ? `（${ctx.caseTitle}）` : ''}`;
}

/** 伝える文を、本人の文体で下書きする */
export async function draftRelay(messageId: number, input: { caseId?: number | null; targetKey: string; instruction?: string | null }) {
  const ctx = relayContext(messageId, { caseId: input.caseId });
  const t = pickTarget(ctx, input.targetKey);
  if (!isConfigured('anthropic')) throw new Error('AI（Anthropic API キー）が未設定のため下書きを作れません。本文を直接入力してください');
  const d = db();
  const thread = t.conversationId
    ? d
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, t.conversationId))
        .orderBy(desc(schema.messages.sentAt))
        .limit(8)
        .all()
        .reverse()
        .map((m) => ({ direction: m.direction as 'in' | 'out', body: m.body.slice(0, 1500), sentAt: m.sentAt, senderName: m.senderName }))
    : [];
  const kase = ctx.caseId ? d.select().from(schema.cases).where(eq(schema.cases.id, ctx.caseId)).get() : null;
  // 文面だけ作る（FAX・郵送）相手は、メールの書き方で下書きする
  const channel: Channel = t.channel ?? 'gmail';
  const person = t.personId ? getClientPerson(t.personId) : null;
  const text = await draftReply(
    { conversationId: t.conversationId ?? 0, instruction: relayInstruction(ctx, t, input.instruction), templateKey: null, extra: {} },
    t.kind === 'contact'
      ? { channel, clientName: ctx.clientName, counterpartName: t.recipient, contactName: t.organization ? `${t.organization} ${t.recipient}` : t.recipient, contactRole: t.roleLabel, contactCaseTitle: ctx.caseTitle, thread, caseSummary: kase?.summary ?? null }
      : { channel, clientName: ctx.clientName, counterpartName: person?.name ?? ctx.clientName, personName: person?.name ?? null, thread, caseSummary: kase?.summary ?? null },
    ctx.clientId,
  );
  const subject = t.channel === 'gmail' && !t.subject ? defaultSubject(ctx) : null;
  return { text, subject };
}

/** 関係者との会話を開く（無ければ作る）。Gmail は新しいメール、LINE は相手とのトーク */
function ensureContactConversation(contact: ContactRow, channel: 'gmail' | 'line', kase: typeof schema.cases.$inferSelect): ConversationRow {
  const d = db();
  const own = d
    .select()
    .from(schema.conversations)
    .where(and(eq(schema.conversations.contactId, contact.id), eq(schema.conversations.channel, channel)))
    .all()
    .filter((c) => !c.archived)
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
  if (own[0]) return own[0];
  if (channel === 'line') {
    const existing = d
      .select()
      .from(schema.conversations)
      .where(and(eq(schema.conversations.channel, 'line'), eq(schema.conversations.externalThreadId, contact.lineUserId!)))
      .get();
    if (existing) {
      const patch = { archived: false, contactId: contact.id, clientId: kase.clientId, caseId: kase.id };
      d.update(schema.conversations).set(patch).where(eq(schema.conversations.id, existing.id)).run();
      return { ...existing, ...patch };
    }
  }
  return d
    .insert(schema.conversations)
    .values({
      channel,
      externalThreadId: channel === 'gmail' ? `new:contact${contact.id}:${Date.now()}` : contact.lineUserId!,
      clientId: kase.clientId,
      caseId: kase.id,
      contactId: contact.id,
      counterpartName: contact.organization ? `${contact.organization} ${contact.name}` : contact.name,
      counterpartAddress: channel === 'gmail' ? contact.emails[0]! : contact.lineUserId,
    })
    .returning()
    .get();
}

export interface RelaySendInput {
  caseId?: number | null;
  targetKey: string;
  text: string;
  /** 新しい Gmail の件名（既存スレッドへの返信では使わない） */
  subject?: string | null;
  /** 相手の回答待ちタスクを作る */
  createWaitingTask?: boolean;
  followUpAt?: string | null;
  /** 送らずに記録だけ残す（FAX・郵送などアプリの外で送ったとき） */
  manual?: boolean;
}

function appendRecord(messageId: number, record: RelayRecord, link: { clientId: number | null; caseId: number | null }) {
  const d = db();
  const q = d.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get()!;
  d.update(schema.messages)
    .set({
      raw: { ...((q.raw ?? {}) as Record<string, unknown>), relays: [...recordsOf(q), record] },
      // 元のメッセージが事件に付いていなければ、伝えた事件に付ける
      ...(q.caseId ? {} : { caseId: link.caseId, clientId: q.clientId ?? link.clientId }),
    })
    .where(eq(schema.messages.id, messageId))
    .run();
}

/** 伝える（送る、または FAX・郵送などで送った記録だけ残す）。続けて回答待ちタスク */
export async function sendRelay(messageId: number, input: RelaySendInput) {
  if (!input.text.trim()) throw new Error('伝える本文を入力してください');
  const ctx = relayContext(messageId, { caseId: input.caseId });
  const t = pickTarget(ctx, input.targetKey);
  const d = db();
  const kase = d.select().from(schema.cases).where(eq(schema.cases.id, ctx.caseId!)).get()!;
  let conversationId: number | null = null;
  let sentMessageId: number | null = null;
  let note: string | null = null;

  if (!input.manual) {
    if (!t.channel) throw new Error('この相手にはアプリから送れません（メール・LINE が未登録です）。FAX・郵送で送ったら「送ったことを記録」を使ってください');
    let conv: ConversationRow;
    if (t.kind === 'contact') {
      if (t.channel === 'chatwork') throw new Error('関係者には Chatwork では送れません');
      const contact = d.select().from(schema.caseContacts).where(eq(schema.caseContacts.id, t.contactId!)).get()!;
      conv = ensureContactConversation(contact, t.channel, kase);
    } else {
      const client = d.select().from(schema.clients).where(eq(schema.clients.id, ctx.clientId!)).get()!;
      conv = ensureClientConversation(client, t.channel, t.personId);
    }
    if (t.channel === 'gmail' && conv.externalThreadId.startsWith('new:')) {
      d.update(schema.conversations).set({ subject: input.subject?.trim() || defaultSubject(ctx) }).where(eq(schema.conversations.id, conv.id)).run();
    }
    const r = await sendToConversation(conv.id, { text: input.text, attachmentIds: [], driveFiles: [], createWaitingTask: false });
    d.update(schema.messages).set({ caseId: kase.id, clientId: kase.clientId }).where(eq(schema.messages.id, r.messageId)).run();
    conversationId = conv.id;
    sentMessageId = r.messageId;
    note = r.note ?? null;
  }

  appendRecord(
    messageId,
    { direction: ctx.direction, targetKey: t.key, recipient: t.recipient, channel: input.manual ? 'manual' : t.channel!, conversationId, messageId: sentMessageId, at: new Date().toISOString() },
    { clientId: ctx.clientId, caseId: kase.id },
  );

  let waitingTaskId: number | null = null;
  if (input.createWaitingTask) {
    const firstLine = input.text.split('\n').map((l) => l.trim()).find((l) => l && !/様$|先生$/.test(l) && !/^お世話になって/.test(l)) ?? '';
    const who = t.kind === 'contact' ? `${t.roleLabel ?? '相手方'}（${familyName(t.recipient)}）` : `${ctx.clientName}さん`;
    const task = await createTask({
      title: `${who}の回答待ち: ${firstLine.slice(0, 40)}`,
      clientId: kase.clientId,
      caseId: kase.id,
      conversationId,
      status: t.kind === 'contact' ? 'waiting_other' : 'waiting_client',
      followUpAt: input.followUpAt ?? ctx.defaultFollowUpAt,
      note: `${ctx.direction === 'to_counterparty' ? '依頼者' : (ctx.from?.roleLabel ?? '相手方')}からの連絡:\n${ctx.message.body.slice(0, 1000)}`,
      syncToChatwork: false,
    });
    waitingTaskId = task.id;
  }

  logger.info({ messageId, direction: ctx.direction, target: t.key, manual: !!input.manual, conversationId }, input.manual ? '伝えた記録を残しました' : '連絡を取り次ぎました');
  return {
    direction: ctx.direction,
    recipient: t.recipient,
    channel: input.manual ? ('manual' as const) : t.channel,
    channelLabel: input.manual ? 'FAX・郵送など' : CHANNEL_LABEL[t.channel!],
    conversationId,
    messageId: sentMessageId,
    note,
    waitingTaskId,
  };
}
