import { z } from 'zod';

export const CHANNELS = ['line', 'chatwork', 'gmail'] as const;
export type Channel = (typeof CHANNELS)[number];
export const channelSchema = z.enum(CHANNELS);

export const CHANNEL_LABEL: Record<Channel, string> = {
  line: 'LINE公式',
  chatwork: 'Chatwork',
  gmail: 'Gmail',
};

export const TASK_STATUSES = ['open', 'waiting_client', 'waiting_other', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  open: '対応中',
  waiting_client: '依頼者の返信待ち',
  waiting_other: '相手方・裁判所待ち',
  done: '完了',
};

export const EVENT_KINDS = ['hearing', 'meeting', 'consult', 'hold', 'other'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  hearing: '期日',
  meeting: '打合せ',
  consult: '相談',
  hold: '仮押さえ',
  other: 'その他',
};

export const ALERT_TYPES = [
  'waiting_overdue',
  'next_hearing_missing',
  'unassigned_file',
  'unlinked_contact',
  'reply_received',
  'scheduling_stale',
  'line_quota',
  'creditor_overdue',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];
export const ALERT_TYPE_LABEL: Record<AlertType, string> = {
  waiting_overdue: '返信待ちが期限超過',
  next_hearing_missing: '次回期日が未入力',
  unassigned_file: '振り分け待ちファイル',
  unlinked_contact: '未紐付けの連絡先',
  reply_received: '返信が届きました',
  scheduling_stale: '日程調整が停滞',
  line_quota: 'LINE 通数が上限に接近',
  creditor_overdue: '債権者対応の期限超過',
};

export const ATTACHMENT_STATUSES = ['pending', 'stored', 'unassigned', 'failed'] as const;
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];

export const SCHEDULING_KINDS = ['面談', 'WEB', '打合せ', '期日'] as const;
export type SchedulingKind = (typeof SCHEDULING_KINDS)[number];

export const clientInputSchema = z.object({
  name: z.string().min(1),
  kana: z.string().optional().nullable(),
  aliases: z.array(z.string()).default([]),
  emails: z.array(z.string().email()).default([]),
  lineUserId: z.string().optional().nullable(),
  chatworkRoomId: z.number().int().optional().nullable(),
  chatworkAccountId: z.number().int().optional().nullable(),
  onedriveFolderPath: z.string().optional().nullable(),
  preferredChannel: channelSchema.optional().nullable(),
  notes: z.string().optional().nullable(),
});
export type ClientInput = z.infer<typeof clientInputSchema>;

export const caseInputSchema = z.object({
  clientId: z.number().int(),
  title: z.string().min(1),
  courtName: z.string().optional().nullable(),
  caseNumber: z.string().optional().nullable(),
  status: z.enum(['active', 'closed']).default('active'),
});
export type CaseInput = z.infer<typeof caseInputSchema>;

export const sendMessageSchema = z.object({
  text: z.string().min(1),
  attachmentIds: z.array(z.number().int()).default([]),
  /** OneDrive 上のファイル（期日報告などで送るもの） */
  driveFiles: z
    .array(z.object({ itemId: z.string(), name: z.string(), path: z.string().optional() }))
    .default([]),
  draftId: z.number().int().optional().nullable(),
  createWaitingTask: z.boolean().default(false),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const draftRequestSchema = z.object({
  conversationId: z.number().int(),
  instruction: z.string().default(''),
  templateKey: z.string().optional().nullable(),
  extra: z.record(z.string(), z.string()).default({}),
});
export type DraftRequest = z.infer<typeof draftRequestSchema>;

export const taskInputSchema = z.object({
  title: z.string().min(1),
  clientId: z.number().int().optional().nullable(),
  caseId: z.number().int().optional().nullable(),
  conversationId: z.number().int().optional().nullable(),
  status: z.enum(TASK_STATUSES).default('open'),
  followUpAt: z.string().datetime({ offset: true }).optional().nullable(),
  note: z.string().optional().nullable(),
  syncToChatwork: z.boolean().default(false),
});
export type TaskInput = z.infer<typeof taskInputSchema>;

export const proposeSlotsSchema = z.object({
  conversationId: z.number().int(),
  kind: z.enum(SCHEDULING_KINDS),
  from: z.string(),
  to: z.string(),
  durationMinutes: z.number().int().min(15).max(480).default(60),
  maxCandidates: z.number().int().min(1).max(10).default(3),
  preferredHours: z.array(z.number().int().min(0).max(23)).optional(),
});
export type ProposeSlotsInput = z.infer<typeof proposeSlotsSchema>;

export const confirmSlotSchema = z.object({
  sessionId: z.number().int(),
  startAt: z.string(),
  durationMinutes: z.number().int().min(15).max(480).default(60),
  createZoom: z.boolean().default(false),
});
export type ConfirmSlotInput = z.infer<typeof confirmSlotSchema>;

export const nextHearingInputSchema = z.object({
  alertId: z.number().int(),
  decision: z.enum(['register', 'undecided']),
  startAt: z.string().optional(),
  durationMinutes: z.number().int().default(60),
  title: z.string().optional(),
  location: z.string().optional(),
});
export type NextHearingInput = z.infer<typeof nextHearingInputSchema>;

export const CASE_NOTE_KINDS = ['phone', 'meeting', 'court', 'memo', 'progress', 'policy'] as const;
export type CaseNoteKind = (typeof CASE_NOTE_KINDS)[number];
export const CASE_NOTE_KIND_LABEL: Record<CaseNoteKind, string> = {
  phone: '電話',
  meeting: '打合せ',
  court: '期日',
  memo: 'メモ',
  progress: '進捗',
  policy: '方針',
};

export const WAITING_FOR = ['none', 'client', 'counterpart', 'court', 'creditor', 'other'] as const;
export type WaitingFor = (typeof WAITING_FOR)[number];
export const WAITING_FOR_LABEL: Record<WaitingFor, string> = {
  none: 'なし',
  client: '依頼者',
  counterpart: '相手方',
  court: '裁判所',
  creditor: '債権者',
  other: 'その他',
};

export const CREDITOR_EVENT_CHANNELS = ['gmail', 'phone', 'fax', 'post', 'chatwork', 'line', 'memo', 'stage'] as const;
export type CreditorEventChannel = (typeof CREDITOR_EVENT_CHANNELS)[number];
export const CREDITOR_EVENT_CHANNEL_LABEL: Record<CreditorEventChannel, string> = {
  gmail: 'メール',
  phone: '電話',
  fax: 'FAX',
  post: '郵送',
  chatwork: 'Chatwork',
  line: 'LINE',
  memo: 'メモ',
  stage: '段階変更',
};

export const DEFAULT_CREDITOR_STAGES = [
  '受任通知送付',
  '債権調査票送付',
  '債権届出・残高回答受領',
  '債権認否・査定',
  '説明会・債権者集会',
  '弁済・配当',
  '完了',
];

export const DEFAULT_CASE_TYPES: { key: string; label: string; hasCreditors: boolean }[] = [
  { key: 'general_civil', label: '一般民事', hasCreditors: false },
  { key: 'divorce', label: '離婚・男女問題', hasCreditors: false },
  { key: 'inheritance', label: '相続', hasCreditors: false },
  { key: 'debt_personal', label: '債務整理（個人）', hasCreditors: true },
  { key: 'bankruptcy_corp', label: '法人破産', hasCreditors: true },
  { key: 'rehabilitation', label: '民事再生・事業再生', hasCreditors: true },
  { key: 'traffic', label: '交通事故', hasCreditors: false },
  { key: 'labor', label: '労働', hasCreditors: false },
  { key: 'criminal', label: '刑事', hasCreditors: false },
  { key: 'corporate', label: '企業法務', hasCreditors: false },
  { key: 'other', label: 'その他', hasCreditors: false },
];

export const DOC_TYPE_KEYWORDS: Record<string, string[]> = {
  訴状: ['訴状'],
  答弁書: ['答弁書'],
  準備書面: ['準備書面'],
  申立書: ['申立書', '申立て書', '申立'],
  上申書: ['上申書'],
  意見書: ['意見書'],
  陳述書: ['陳述書'],
  証拠説明書: ['証拠説明書'],
  契約書: ['契約書', '合意書', '覚書'],
  内容証明: ['内容証明', '通知書', '催告書'],
  受任通知: ['受任通知'],
  債権調査票: ['債権調査票', '債権届出'],
  報告書: ['報告書'],
  和解書: ['和解', '示談'],
  遺産分割: ['遺産分割', '遺言'],
};

export function inferDocType(filename: string, keywords: Record<string, string[]> = DOC_TYPE_KEYWORDS): string | null {
  for (const [docType, kws] of Object.entries(keywords)) {
    if (kws.some((k) => filename.includes(k))) return docType;
  }
  return null;
}

export const caseNoteInputSchema = z.object({
  caseId: z.number().int(),
  kind: z.enum(CASE_NOTE_KINDS).default('memo'),
  occurredAt: z.string().optional(),
  counterpart: z.string().optional().nullable(),
  rawText: z.string().default(''),
  gist: z.string().optional().nullable(),
  decisions: z.array(z.string()).default([]),
  nextActions: z.array(z.object({ title: z.string(), due: z.string().optional().nullable(), taskId: z.number().int().optional().nullable() })).default([]),
  waitingFor: z.enum(WAITING_FOR).optional().nullable(),
  attachments: z.array(z.object({ name: z.string(), url: z.string().optional(), driveItemId: z.string().optional() })).default([]),
});
export type CaseNoteInput = z.infer<typeof caseNoteInputSchema>;

export const creditorInputSchema = z.object({
  caseId: z.number().int(),
  name: z.string().min(1),
  kana: z.string().optional().nullable(),
  kind: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  fax: z.string().optional().nullable(),
  emails: z.array(z.string()).default([]),
  contactPerson: z.string().optional().nullable(),
  claimAmount: z.number().int().optional().nullable(),
  claimKind: z.string().optional().nullable(),
  stage: z.string().optional().nullable(),
  nextAction: z.string().optional().nullable(),
  nextActionDue: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
});
export type CreditorInput = z.infer<typeof creditorInputSchema>;

export const creditorEventInputSchema = z.object({
  creditorId: z.number().int(),
  occurredAt: z.string().optional(),
  channel: z.enum(CREDITOR_EVENT_CHANNELS).default('memo'),
  direction: z.enum(['in', 'out']).optional().nullable(),
  summary: z.string().default(''),
  attachments: z.array(z.object({ name: z.string(), url: z.string().optional(), driveItemId: z.string().optional() })).default([]),
  stageAfter: z.string().optional().nullable(),
});
export type CreditorEventInput = z.infer<typeof creditorEventInputSchema>;

export const CREDITOR_IMPORT_FIELDS = ['name', 'kana', 'kind', 'address', 'phone', 'fax', 'email', 'contactPerson', 'claimAmount', 'claimKind', 'note'] as const;
export const CREDITOR_IMPORT_FIELD_LABEL: Record<(typeof CREDITOR_IMPORT_FIELDS)[number], string> = {
  name: '債権者名',
  kana: 'フリガナ',
  kind: '種別',
  address: '住所',
  phone: '電話',
  fax: 'FAX',
  email: 'メール',
  contactPerson: '担当者',
  claimAmount: '債権額',
  claimKind: '債権種別',
  note: '備考',
};

export const formDraftRequestSchema = z.object({
  templateIds: z.array(z.number().int()).min(1).max(3),
  caseId: z.number().int().optional().nullable(),
  instruction: z.string().default(''),
  facts: z.string().default(''),
  title: z.string().optional(),
  anonymizeSources: z.boolean().default(true),
  saveToClientFolder: z.boolean().default(true),
});
export type FormDraftRequest = z.infer<typeof formDraftRequestSchema>;
