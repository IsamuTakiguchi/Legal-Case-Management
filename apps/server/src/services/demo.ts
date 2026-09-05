import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getSetting, setSetting } from './settings.js';

/**
 * デモデータ。架空の依頼者・事件・会話・タスク・アラート・債権者を投入し、あとでまとめて削除できる。
 * 投入した行の ID は settings.demo_ids に JSON で記録する。
 */
interface DemoIds {
  clients: number[];
  cases: number[];
  caseNotes: number[];
  creditors: number[];
  creditorEvents: number[];
  conversations: number[];
  messages: number[];
  attachments: number[];
  tasks: number[];
  calendarEvents: number[];
  alerts: number[];
  schedulingSessions: number[];
}

const KEY = 'demo_ids';

export function demoStatus(): { seeded: boolean; seededAt: string | null } {
  const raw = getSetting(KEY);
  if (!raw) return { seeded: false, seededAt: null };
  try {
    const parsed = JSON.parse(raw) as DemoIds & { seededAt?: string };
    return { seeded: (parsed.clients?.length ?? 0) > 0, seededAt: parsed.seededAt ?? null };
  } catch {
    return { seeded: false, seededAt: null };
  }
}

const iso = (daysFromNow: number, hour = 10, minute = 0) => {
  const d = new Date();
  d.setUTCHours(hour - 9, minute, 0, 0); // JST → UTC
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString();
};

export function seedDemoData(): DemoIds {
  if (demoStatus().seeded) clearDemoData();
  const d = db();
  const ids: DemoIds = { clients: [], cases: [], caseNotes: [], creditors: [], creditorEvents: [], conversations: [], messages: [], attachments: [], tasks: [], calendarEvents: [], alerts: [], schedulingSessions: [] };

  d.transaction((t) => {
    // ---- 依頼者 ----
    const yamada = t
      .insert(schema.clients)
      .values({ name: '【デモ】山田 花子', kana: 'やまだ はなこ', aliases: ['山田'], emails: ['demo-yamada@example.com'], preferredChannel: 'gmail', onedriveFolderPath: '山田花子', notes: '離婚調停。子ども 2 人。平日日中は仕事のため夕方以降の連絡希望。' })
      .returning()
      .get();
    const sato = t
      .insert(schema.clients)
      .values({ name: '【デモ】佐藤 太郎', kana: 'さとう たろう', aliases: ['佐藤'], emails: ['demo-sato@example.com'], lineUserId: 'Udemo0000000000000000000000000001', preferredChannel: 'line', onedriveFolderPath: '佐藤太郎', notes: '交通事故（被害者側）。LINE 希望。' })
      .returning()
      .get();
    const suzuki = t
      .insert(schema.clients)
      .values({ name: '【デモ】株式会社スズキ商事', kana: 'すずきしょうじ', aliases: ['スズキ商事', '鈴木'], emails: ['demo-suzuki@example.com'], chatworkRoomId: 999000001, preferredChannel: 'chatwork', onedriveFolderPath: 'スズキ商事', notes: '法人破産申立て。代表者 鈴木一郎。Chatwork のグループで連絡。' })
      .returning()
      .get();
    ids.clients.push(yamada.id, sato.id, suzuki.id);

    // ---- 事件 ----
    const c1 = t
      .insert(schema.cases)
      .values({ clientId: yamada.id, caseType: 'divorce', title: '離婚調停申立事件', courtName: '奈良家庭裁判所', caseNumber: '令和8年（家イ）第123号', status: 'active', stage: '第2回調停期日待ち', policy: '親権は母（依頼者）で争いなし。養育費は算定表どおり月 6 万円を主張。財産分与は自宅の評価額が争点になる見込みのため、査定書を取得する。', nextHearingAt: iso(12, 10, 30) })
      .returning()
      .get();
    const c2 = t
      .insert(schema.cases)
      .values({ clientId: sato.id, caseType: 'traffic', title: '交通事故損害賠償請求事件', courtName: null, caseNumber: null, status: 'active', stage: '示談交渉中（保険会社と）', policy: '後遺障害 14 級認定済み。保険会社提示額（約 90 万円）は裁判基準の半分程度のため、弁護士基準で 180 万円を提示して交渉。応じなければ訴訟提起。' })
      .returning()
      .get();
    const c3 = t
      .insert(schema.cases)
      .values({ clientId: suzuki.id, caseType: 'bankruptcy_corp', title: '株式会社スズキ商事 破産手続開始申立事件', courtName: '奈良地方裁判所', caseNumber: '令和8年（フ）第45号', status: 'active', stage: '債権調査中', policy: '受任通知は全債権者に送付済み。取引先の売掛金回収を優先し、申立前に在庫の任意売却を検討。従業員の未払賃金は立替払制度を案内。', nextHearingAt: iso(25, 13, 30) })
      .returning()
      .get();
    ids.cases.push(c1.id, c2.id, c3.id);

    // ---- 事件ノート ----
    const notes = [
      { caseId: c1.id, clientId: yamada.id, kind: 'phone', occurredAt: iso(-3, 17, 15), counterpart: '山田 花子', rawText: '相手方から養育費 4 万円の提案があったが納得できないとのこと。自宅の査定は不動産業者 2 社に依頼済み、来週には出る見込み。次回期日は出席できる。', gist: '相手方提案（養育費 4 万円）には応じない方針。自宅査定は来週入手予定。', decisions: ['養育費は算定表どおり 6 万円を維持', '査定書 2 通が揃い次第、財産分与の主張書面を作成'], nextActions: [{ title: '査定書の受領確認（山田様）', due: iso(5) }], waitingFor: '依頼者', createdBy: 'ai' },
      { caseId: c1.id, clientId: yamada.id, kind: 'court', occurredAt: iso(-20, 10, 30), counterpart: '奈良家裁 調停委員', rawText: '第1回調停。親権は争いなし。養育費と財産分与が争点。次回までに双方が資料を提出。', gist: '第1回調停。争点は養育費と財産分与に絞られた。', decisions: [], nextActions: [], waitingFor: null, createdBy: 'user' },
      { caseId: c2.id, clientId: sato.id, kind: 'phone', occurredAt: iso(-1, 11, 0), counterpart: '○○損保 担当者', rawText: '弁護士基準での提示（180 万円）に対し、社内決裁に 2 週間ほしいとのこと。', gist: '保険会社は 2 週間以内に回答予定。', decisions: [], nextActions: [{ title: '保険会社の回答待ち', due: iso(14) }], waitingFor: '相手方', createdBy: 'ai' },
      { caseId: c3.id, clientId: suzuki.id, kind: 'meeting', occurredAt: iso(-7, 14, 0), counterpart: '鈴木 一郎 代表', rawText: '債権者一覧の Excel を受領。取引先 3 社の売掛金は回収見込み。従業員 5 名は月末で解雇予定。', gist: '債権者一覧受領。売掛金回収と従業員対応の方針を確認。', decisions: ['未払賃金立替払制度の案内を従業員に配布', '在庫は買取業者に見積依頼'], nextActions: [{ title: '在庫の見積取得', due: iso(7) }], waitingFor: null, createdBy: 'user' },
    ] as const;
    for (const n of notes) {
      const row = t.insert(schema.caseNotes).values({ ...n, decisions: [...n.decisions], nextActions: [...n.nextActions] }).returning().get();
      ids.caseNotes.push(row.id);
    }

    // ---- 債権者（法人破産） ----
    const creditors = [
      { name: '○○銀行 奈良支店', kind: '金融機関', claimAmount: 25_000_000, claimKind: '証書貸付', stage: '債権届出・残高回答受領', lastContactAt: iso(-4), emails: ['demo-bank@example.com'], phone: '0742-00-0001' },
      { name: '△△信用金庫', kind: '金融機関', claimAmount: 8_000_000, claimKind: '手形貸付', stage: '債権調査票送付', lastContactAt: iso(-15), nextAction: '残高証明の督促', nextActionDue: iso(-2), emails: ['demo-shinkin@example.com'] },
      { name: '奈良税務署', kind: '公租公課', claimAmount: 1_200_000, claimKind: '源泉所得税', stage: '受任通知送付', lastContactAt: iso(-30), nextAction: '納税証明の取得', nextActionDue: iso(3), fax: '0742-00-0002' },
      { name: '株式会社□□リース', kind: 'リース', claimAmount: 3_400_000, claimKind: 'リース残債', stage: '債権認否・査定', lastContactAt: iso(-2), emails: ['demo-lease@example.com'] },
      { name: '有限会社◇◇運輸', kind: '取引先', claimAmount: 950_000, claimKind: '買掛金', stage: '受任通知送付', lastContactAt: iso(-33), nextAction: '債権調査票の送付', nextActionDue: iso(-5), phone: '0742-00-0003' },
    ];
    for (const cr of creditors) {
      const row = t.insert(schema.creditors).values({ caseId: c3.id, source: 'excel', ...cr, emails: cr.emails ?? [] }).returning().get();
      ids.creditors.push(row.id);
      const ev = t.insert(schema.creditorEvents).values({ creditorId: row.id, occurredAt: iso(-35, 15, 0), channel: 'post', direction: 'out', summary: '受任通知を郵送', stageAfter: '受任通知送付', createdBy: 'user' }).returning().get();
      ids.creditorEvents.push(ev.id);
      if (cr.lastContactAt && cr.stage !== '受任通知送付') {
        const ev2 = t.insert(schema.creditorEvents).values({ creditorId: row.id, occurredAt: cr.lastContactAt, channel: cr.emails?.length ? 'gmail' : 'phone', direction: 'in', summary: cr.stage === '債権届出・残高回答受領' ? '残高証明書を受領' : '債権調査票の到着確認の連絡', stageAfter: cr.stage, createdBy: 'user' }).returning().get();
        ids.creditorEvents.push(ev2.id);
      }
    }

    // ---- 会話・メッセージ ----
    const convs: { conv: typeof schema.conversations.$inferInsert; msgs: Omit<typeof schema.messages.$inferInsert, 'conversationId' | 'channel'>[] }[] = [
      {
        conv: { channel: 'gmail', externalThreadId: 'demo-thread-yamada', clientId: yamada.id, subject: '査定書について', counterpartName: '山田 花子', counterpartAddress: 'demo-yamada@example.com', lastMessageAt: iso(0, 9, 12), lastInboundAt: iso(0, 9, 12), unread: 1, needsReply: true },
        msgs: [
          { externalId: 'demo-m1', direction: 'out', senderName: '瀧口勇', body: '山田様\n\nお世話になっております。弁護士の瀧口です。\n自宅の査定書が届きましたら、PDF でお送りいただけますでしょうか。\n\nよろしくお願いいたします。', sentAt: iso(-5, 16, 40) },
          { externalId: 'demo-m2', direction: 'in', senderName: '山田 花子', senderAddress: 'demo-yamada@example.com', body: '瀧口先生\n\nお世話になっております。\n2 社のうち 1 社の査定書が届きましたので添付いたします。もう 1 社は来週になるそうです。\n次回の期日は 10 時 30 分からで間違いないでしょうか。\n\n山田', sentAt: iso(0, 9, 12) },
        ],
      },
      {
        conv: { channel: 'line', externalThreadId: 'Udemo0000000000000000000000000001', clientId: sato.id, subject: null, counterpartName: '佐藤 太郎', lastMessageAt: iso(-1, 19, 5), lastInboundAt: iso(-1, 19, 5), unread: 0, needsReply: false },
        msgs: [
          { externalId: 'demo-l1', direction: 'in', senderName: '佐藤 太郎', body: '先生、保険会社から連絡は来ましたか？', sentAt: iso(-1, 18, 30) },
          { externalId: 'demo-l2', direction: 'out', senderName: '瀧口勇', body: '佐藤様\n本日、保険会社の担当者と電話で話しました。こちらの提示額について社内で検討するとのことで、2 週間ほどで回答が来る見込みです。\n回答が届き次第ご連絡します。', sentAt: iso(-1, 19, 5) },
        ],
      },
      {
        conv: { channel: 'chatwork', externalThreadId: '999000001', clientId: suzuki.id, subject: 'スズキ商事 破産関係', counterpartName: '鈴木 一郎', lastMessageAt: iso(0, 8, 45), lastInboundAt: iso(0, 8, 45), unread: 1, needsReply: true },
        msgs: [
          { externalId: 'demo-c1', direction: 'in', senderName: '鈴木 一郎', body: '瀧口先生\n在庫の見積が 2 社から届きました。ファイルを添付します。どちらで進めるのがよいでしょうか。[download:demo-file-1]', sentAt: iso(0, 8, 45) },
        ],
      },
      {
        conv: { channel: 'gmail', externalThreadId: 'demo-thread-new', clientId: null, subject: '法律相談のお願い（相続）', counterpartName: '田中 一郎', counterpartAddress: 'demo-tanaka@example.com', lastMessageAt: iso(-2, 21, 3), lastInboundAt: iso(-2, 21, 3), unread: 1, needsReply: true },
        msgs: [{ externalId: 'demo-n1', direction: 'in', senderName: '田中 一郎', senderAddress: 'demo-tanaka@example.com', body: 'はじめまして。父が先月亡くなり、兄と遺産分割で揉めております。一度ご相談したいのですが、来週以降で面談は可能でしょうか。平日の午後が都合がよいです。', sentAt: iso(-2, 21, 3) }],
      },
    ];
    const convIds: Record<string, number> = {};
    for (const { conv, msgs } of convs) {
      const row = t.insert(schema.conversations).values(conv).returning().get();
      ids.conversations.push(row.id);
      convIds[conv.externalThreadId] = row.id;
      for (const m of msgs) {
        const mr = t.insert(schema.messages).values({ ...m, conversationId: row.id, channel: conv.channel }).returning().get();
        ids.messages.push(mr.id);
        if (m.externalId === 'demo-m2') {
          const a = t.insert(schema.attachments).values({ messageId: mr.id, clientId: yamada.id, filename: '査定書_A社.pdf', mime: 'application/pdf', size: 384_000, status: 'stored', storedPath: '/依頼者/山田花子/受領資料/20260905_gmail_査定書_A社.pdf' }).returning().get();
          ids.attachments.push(a.id);
        }
        if (m.externalId === 'demo-c1') {
          const a = t.insert(schema.attachments).values({ messageId: mr.id, clientId: null, filename: '在庫見積_2社.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 52_000, status: 'unassigned', storedPath: '/依頼者/_未振分/20260905_chatwork_在庫見積_2社.xlsx' }).returning().get();
          ids.attachments.push(a.id);
        }
      }
    }

    // ---- タスク ----
    const tasks = [
      { title: '査定書（2 社目）の受領', clientId: yamada.id, caseId: c1.id, conversationId: convIds['demo-thread-yamada'], status: 'waiting_client', waitingSince: iso(-5), followUpAt: iso(-1) },
      { title: '保険会社からの回答', clientId: sato.id, caseId: c2.id, conversationId: convIds['Udemo0000000000000000000000000001'], status: 'waiting_other', waitingSince: iso(-1), followUpAt: iso(13) },
      { title: '財産分与の主張書面を作成', clientId: yamada.id, caseId: c1.id, status: 'open', dueAt: iso(8) },
      { title: '在庫の見積を比較して代表者に回答', clientId: suzuki.id, caseId: c3.id, conversationId: convIds['999000001'], status: 'open', dueAt: iso(1) },
      { title: '従業員向け 立替払制度の案内文を作成', clientId: suzuki.id, caseId: c3.id, status: 'open', dueAt: iso(4) },
    ];
    for (const tk of tasks) {
      const row = t.insert(schema.tasks).values(tk).returning().get();
      ids.tasks.push(row.id);
    }

    // ---- カレンダー ----
    const events = [
      { googleEventId: 'demo-ev-1', clientId: yamada.id, caseId: c1.id, kind: 'hearing', title: '山田 第2回調停期日', startAt: iso(12, 10, 30), endAt: iso(12, 12, 0), location: '奈良家庭裁判所', status: 'confirmed' },
      { googleEventId: 'demo-ev-2', clientId: suzuki.id, caseId: c3.id, kind: 'hearing', title: 'スズキ商事 債権者集会', startAt: iso(25, 13, 30), endAt: iso(25, 14, 30), location: '奈良地方裁判所', status: 'confirmed' },
      { googleEventId: 'demo-ev-3', clientId: sato.id, caseId: c2.id, kind: 'meeting', title: '佐藤 打合せ', startAt: iso(0, 15, 0), endAt: iso(0, 16, 0), location: '登大路総合法律事務所', status: 'confirmed' },
      { googleEventId: 'demo-ev-4', clientId: null, caseId: null, kind: 'consult', title: '田中 相談 仮', startAt: iso(6, 14, 0), endAt: iso(6, 15, 0), location: '登大路総合法律事務所', status: 'tentative' },
      { googleEventId: 'demo-ev-5', clientId: sato.id, caseId: c2.id, kind: 'meeting', title: '佐藤 電話打合せ', startAt: iso(-8, 11, 0), endAt: iso(-8, 11, 30), status: 'confirmed', processedPostEvent: true },
    ];
    for (const ev of events) {
      const row = t.insert(schema.calendarEvents).values(ev).returning().get();
      ids.calendarEvents.push(row.id);
    }

    // ---- 日程調整 ----
    const ss = t.insert(schema.schedulingSessions).values({ clientId: null, conversationId: convIds['demo-thread-new'], kind: '面談', state: 'proposing', candidates: [{ startAt: iso(6, 14, 0), endAt: iso(6, 15, 0), eventId: 'demo-ev-4' }, { startAt: iso(7, 15, 0), endAt: iso(7, 16, 0) }], proposedAt: iso(-1, 9, 0) }).returning().get();
    ids.schedulingSessions.push(ss.id);

    // ---- アラート ----
    const alerts = [
      { type: 'waiting_overdue', dedupeKey: 'demo-alert-1', title: '依頼者の返信待ちが期限超過: 【デモ】山田 花子 / 査定書（2 社目）の受領', body: '5 日前から返信待ち。催促文を作成できます。', payload: { taskId: ids.tasks[0], conversationId: convIds['demo-thread-yamada'] } },
      { type: 'unassigned_file', dedupeKey: 'demo-alert-2', title: '振り分け待ちのファイル: 在庫見積_2社.xlsx（Chatwork）', body: '依頼者フォルダを選んで振り分けてください。', payload: { attachmentId: ids.attachments[1] } },
      { type: 'unlinked_contact', dedupeKey: 'demo-alert-3', title: '未紐付けの連絡先: 田中 一郎（gmail）', body: 'demo-tanaka@example.com からの受信。既存の依頼者に紐付けるか、新規登録してください。', payload: { conversationId: convIds['demo-thread-new'] } },
      { type: 'next_hearing_missing', dedupeKey: 'demo-alert-4', title: '次回期日が未入力: 【デモ】佐藤 太郎 佐藤 電話打合せ', body: '終了した打合せの後に、同じ依頼者の次回予定が見つかりません。', payload: { clientId: sato.id, caseId: c2.id, eventId: 'demo-ev-5' } },
      { type: 'creditor_overdue', dedupeKey: 'demo-alert-5', title: '債権者対応の期限超過: 【デモ】株式会社スズキ商事 / △△信用金庫', body: '次のアクション「残高証明の督促」の期限を過ぎています。', payload: { caseId: c3.id, creditorId: ids.creditors[1] } },
    ];
    for (const a of alerts) {
      const row = t.insert(schema.alerts).values(a).returning().get();
      ids.alerts.push(row.id);
    }
  });
  setSetting(KEY, JSON.stringify({ ...ids, seededAt: new Date().toISOString() }));
  return ids;
}

export function clearDemoData(): number {
  const raw = getSetting(KEY);
  if (!raw) return 0;
  let ids: Partial<DemoIds>;
  try {
    ids = JSON.parse(raw) as DemoIds;
  } catch {
    setSetting(KEY, '');
    return 0;
  }
  const d = db();
  let n = 0;
  const del = <T extends { id: unknown }>(table: T, col: Parameters<typeof inArray>[0], list?: number[]) => {
    if (!list?.length) return;
    n += d.delete(table as never).where(inArray(col, list)).run().changes;
  };
  d.transaction(() => {
    del(schema.alerts, schema.alerts.id, ids.alerts);
    del(schema.schedulingSessions, schema.schedulingSessions.id, ids.schedulingSessions);
    del(schema.calendarEvents, schema.calendarEvents.id, ids.calendarEvents);
    del(schema.tasks, schema.tasks.id, ids.tasks);
    del(schema.attachments, schema.attachments.id, ids.attachments);
    if (ids.messages?.length) {
      const drafts = d.select({ id: schema.drafts.id }).from(schema.drafts).where(inArray(schema.drafts.conversationId, ids.conversations ?? [])).all();
      del(schema.drafts, schema.drafts.id, drafts.map((x) => x.id));
    }
    del(schema.messages, schema.messages.id, ids.messages);
    del(schema.conversations, schema.conversations.id, ids.conversations);
    del(schema.creditorEvents, schema.creditorEvents.id, ids.creditorEvents);
    del(schema.creditors, schema.creditors.id, ids.creditors);
    del(schema.caseNotes, schema.caseNotes.id, ids.caseNotes);
    if (ids.cases?.length) {
      // 事件に紐付いた後付けのタスク・ノートも削除
      const extraTasks = d.select({ id: schema.tasks.id }).from(schema.tasks).where(inArray(schema.tasks.caseId, ids.cases)).all();
      del(schema.tasks, schema.tasks.id, extraTasks.map((x) => x.id));
      const extraNotes = d.select({ id: schema.caseNotes.id }).from(schema.caseNotes).where(inArray(schema.caseNotes.caseId, ids.cases)).all();
      del(schema.caseNotes, schema.caseNotes.id, extraNotes.map((x) => x.id));
    }
    del(schema.cases, schema.cases.id, ids.cases);
    if (ids.clients?.length) {
      for (const cid of ids.clients) {
        d.update(schema.conversations).set({ clientId: null }).where(eq(schema.conversations.clientId, cid)).run();
        d.update(schema.attachments).set({ clientId: null }).where(eq(schema.attachments.clientId, cid)).run();
        d.update(schema.styleSamples).set({ clientId: null }).where(eq(schema.styleSamples.clientId, cid)).run();
      }
    }
    del(schema.clients, schema.clients.id, ids.clients);
  });
  setSetting(KEY, '');
  return n;
}
