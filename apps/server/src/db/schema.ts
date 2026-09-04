import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

const now = () => sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const clients = sqliteTable('clients', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  kana: text('kana'),
  aliases: text('aliases', { mode: 'json' }).$type<string[]>().notNull().default([]),
  emails: text('emails', { mode: 'json' }).$type<string[]>().notNull().default([]),
  lineUserId: text('line_user_id'),
  chatworkRoomId: integer('chatwork_room_id'),
  chatworkAccountId: integer('chatwork_account_id'),
  onedriveFolderPath: text('onedrive_folder_path'),
  preferredChannel: text('preferred_channel'),
  notes: text('notes'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
});

export const caseTypes = sqliteTable('case_types', {
  key: text('key').primaryKey(),
  label: text('label').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  hasCreditors: integer('has_creditors', { mode: 'boolean' }).notNull().default(false),
  creditorStages: text('creditor_stages', { mode: 'json' }).$type<string[]>().notNull().default([]),
  docTypeKeywords: text('doc_type_keywords', { mode: 'json' }).$type<Record<string, string[]>>().notNull().default({}),
});

export const cases = sqliteTable('cases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientId: integer('client_id').notNull().references(() => clients.id),
  caseType: text('case_type').notNull().default('general_civil'),
  title: text('title').notNull(),
  courtName: text('court_name'),
  caseNumber: text('case_number'),
  status: text('status').notNull().default('active'),
  stage: text('stage'),
  policy: text('policy'),
  policyUpdatedAt: text('policy_updated_at'),
  summary: text('summary'),
  summaryGeneratedAt: text('summary_generated_at'),
  nextHearingAt: text('next_hearing_at'),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
});

export const caseNotes = sqliteTable(
  'case_notes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    caseId: integer('case_id').notNull().references(() => cases.id),
    clientId: integer('client_id').references(() => clients.id),
    kind: text('kind').notNull().default('memo'), // phone | meeting | court | memo | progress | policy
    occurredAt: text('occurred_at').notNull(),
    counterpart: text('counterpart'),
    rawText: text('raw_text'),
    gist: text('gist'),
    decisions: text('decisions', { mode: 'json' }).$type<string[]>().notNull().default([]),
    nextActions: text('next_actions', { mode: 'json' }).$type<{ title: string; due?: string | null; taskId?: number | null }[]>().notNull().default([]),
    waitingFor: text('waiting_for'),
    attachments: text('attachments', { mode: 'json' }).$type<{ name: string; url?: string; driveItemId?: string }[]>().notNull().default([]),
    createdBy: text('created_by').notNull().default('user'), // user | ai | system
    createdAt: text('created_at').notNull().default(now()),
  },
  (t) => [index('note_case').on(t.caseId, t.occurredAt)],
);

export const creditors = sqliteTable(
  'creditors',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    caseId: integer('case_id').notNull().references(() => cases.id),
    name: text('name').notNull(),
    kana: text('kana'),
    kind: text('kind'),
    address: text('address'),
    phone: text('phone'),
    fax: text('fax'),
    emails: text('emails', { mode: 'json' }).$type<string[]>().notNull().default([]),
    contactPerson: text('contact_person'),
    claimAmount: integer('claim_amount'),
    claimKind: text('claim_kind'),
    stage: text('stage'),
    lastContactAt: text('last_contact_at'),
    nextAction: text('next_action'),
    nextActionDue: text('next_action_due'),
    note: text('note'),
    source: text('source').notNull().default('manual'),
    externalKey: text('external_key'),
    createdAt: text('created_at').notNull().default(now()),
    updatedAt: text('updated_at').notNull().default(now()),
  },
  (t) => [index('creditor_case').on(t.caseId), index('creditor_stage').on(t.caseId, t.stage)],
);

export const creditorEvents = sqliteTable(
  'creditor_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    creditorId: integer('creditor_id').notNull().references(() => creditors.id),
    occurredAt: text('occurred_at').notNull(),
    channel: text('channel').notNull().default('memo'), // gmail | phone | fax | post | chatwork | line | memo | stage
    direction: text('direction'), // in | out
    summary: text('summary').notNull().default(''),
    conversationId: integer('conversation_id'),
    messageId: integer('message_id'),
    attachments: text('attachments', { mode: 'json' }).$type<{ name: string; url?: string; driveItemId?: string }[]>().notNull().default([]),
    stageAfter: text('stage_after'),
    createdBy: text('created_by').notNull().default('user'),
    createdAt: text('created_at').notNull().default(now()),
  },
  (t) => [index('cev_creditor').on(t.creditorId, t.occurredAt), uniqueIndex('cev_message').on(t.creditorId, t.messageId)],
);

export const formTemplates = sqliteTable(
  'form_templates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    driveItemId: text('drive_item_id').notNull(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    webUrl: text('web_url'),
    ext: text('ext'),
    modifiedAt: text('modified_at'),
    eTag: text('etag'),
    size: integer('size'),
    caseType: text('case_type'),
    docType: text('doc_type'),
    source: text('source').notNull().default('library'), // library | client_folder
    clientId: integer('client_id'),
    extractedText: text('extracted_text'),
    extractError: text('extract_error'),
    manualOverride: integer('manual_override', { mode: 'boolean' }).notNull().default(false),
    indexedAt: text('indexed_at').notNull().default(now()),
  },
  (t) => [uniqueIndex('form_drive_item').on(t.driveItemId), index('form_type').on(t.caseType, t.docType)],
);

export const conversations = sqliteTable(
  'conversations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channel: text('channel').notNull(),
    externalThreadId: text('external_thread_id').notNull(),
    clientId: integer('client_id').references(() => clients.id),
    subject: text('subject'),
    counterpartName: text('counterpart_name'),
    counterpartAddress: text('counterpart_address'),
    lastMessageAt: text('last_message_at'),
    lastInboundAt: text('last_inbound_at'),
    lastOutboundAt: text('last_outbound_at'),
    unread: integer('unread').notNull().default(0),
    needsReply: integer('needs_reply', { mode: 'boolean' }).notNull().default(false),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    createdAt: text('created_at').notNull().default(now()),
  },
  (t) => [uniqueIndex('conv_channel_thread').on(t.channel, t.externalThreadId), index('conv_client').on(t.clientId)],
);

export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    conversationId: integer('conversation_id').notNull().references(() => conversations.id),
    channel: text('channel').notNull(),
    externalId: text('external_id').notNull(),
    direction: text('direction').notNull(), // in | out
    senderName: text('sender_name'),
    senderAddress: text('sender_address'),
    body: text('body').notNull().default(''),
    sentAt: text('sent_at').notNull(),
    raw: text('raw', { mode: 'json' }).$type<Record<string, unknown>>(),
    replyToken: text('reply_token'),
    replyTokenAt: text('reply_token_at'),
    draftId: integer('draft_id'),
    createdAt: text('created_at').notNull().default(now()),
  },
  (t) => [uniqueIndex('msg_channel_ext').on(t.channel, t.externalId), index('msg_conv').on(t.conversationId, t.sentAt)],
);

export const attachments = sqliteTable(
  'attachments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    messageId: integer('message_id').notNull().references(() => messages.id),
    clientId: integer('client_id').references(() => clients.id),
    filename: text('filename').notNull(),
    mime: text('mime'),
    size: integer('size'),
    status: text('status').notNull().default('pending'),
    channelRef: text('channel_ref', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    storedPath: text('stored_path'),
    driveItemId: text('drive_item_id'),
    shareUrl: text('share_url'),
    error: text('error'),
    createdAt: text('created_at').notNull().default(now()),
  },
  (t) => [index('att_status').on(t.status)],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    note: text('note'),
    clientId: integer('client_id').references(() => clients.id),
    caseId: integer('case_id').references(() => cases.id),
    conversationId: integer('conversation_id').references(() => conversations.id),
    status: text('status').notNull().default('open'),
    waitingSince: text('waiting_since'),
    followUpAt: text('follow_up_at'),
    lastNudgedAt: text('last_nudged_at'),
    chatworkRoomId: integer('chatwork_room_id'),
    chatworkTaskId: integer('chatwork_task_id'),
    dueAt: text('due_at'),
    completedAt: text('completed_at'),
    createdAt: text('created_at').notNull().default(now()),
    updatedAt: text('updated_at').notNull().default(now()),
  },
  (t) => [index('task_status').on(t.status), uniqueIndex('task_cw').on(t.chatworkTaskId)],
);

export const schedulingSessions = sqliteTable('scheduling_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientId: integer('client_id').references(() => clients.id),
  conversationId: integer('conversation_id').references(() => conversations.id),
  kind: text('kind').notNull(),
  state: text('state').notNull().default('proposing'),
  candidates: text('candidates', { mode: 'json' }).$type<{ startAt: string; endAt: string; eventId?: string }[]>().notNull().default([]),
  confirmedEventId: text('confirmed_event_id'),
  confirmedStartAt: text('confirmed_start_at'),
  zoom: text('zoom', { mode: 'json' }).$type<{ id: string; joinUrl: string; password: string } | null>(),
  proposedAt: text('proposed_at'),
  createdAt: text('created_at').notNull().default(now()),
  updatedAt: text('updated_at').notNull().default(now()),
});

export const calendarEvents = sqliteTable(
  'calendar_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    googleEventId: text('google_event_id').notNull(),
    clientId: integer('client_id').references(() => clients.id),
    caseId: integer('case_id').references(() => cases.id),
    kind: text('kind').notNull().default('other'),
    title: text('title').notNull(),
    startAt: text('start_at').notNull(),
    endAt: text('end_at').notNull(),
    location: text('location'),
    description: text('description'),
    status: text('status'),
    processedPostEvent: integer('processed_post_event', { mode: 'boolean' }).notNull().default(false),
    syncedAt: text('synced_at').notNull().default(now()),
  },
  (t) => [uniqueIndex('cal_google_id').on(t.googleEventId), index('cal_start').on(t.startAt)],
);

export const alerts = sqliteTable(
  'alerts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    dedupeKey: text('dedupe_key'),
    title: text('title').notNull(),
    body: text('body'),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('open'), // open | resolved | dismissed
    notifiedAt: text('notified_at'),
    resolvedAt: text('resolved_at'),
    createdAt: text('created_at').notNull().default(now()),
  },
  (t) => [uniqueIndex('alert_dedupe').on(t.dedupeKey), index('alert_status').on(t.status)],
);

export const styleSamples = sqliteTable(
  'style_samples',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channel: text('channel').notNull(),
    clientId: integer('client_id').references(() => clients.id),
    text: text('text').notNull(),
    contextText: text('context_text'),
    source: text('source').notNull(), // import | sent | edited | manual
    externalId: text('external_id'),
    sentAt: text('sent_at'),
    createdAt: text('created_at').notNull().default(now()),
  },
  (t) => [uniqueIndex('style_ext').on(t.channel, t.externalId)],
);

export const styleProfiles = sqliteTable('style_profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channel: text('channel').notNull().unique(), // line | chatwork | gmail | all
  profileMarkdown: text('profile_markdown').notNull(),
  generatedAt: text('generated_at').notNull().default(now()),
});

export const drafts = sqliteTable('drafts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  conversationId: integer('conversation_id').notNull().references(() => conversations.id),
  instruction: text('instruction'),
  generatedText: text('generated_text').notNull(),
  finalText: text('final_text'),
  status: text('status').notNull().default('draft'), // draft | sent | discarded
  createdAt: text('created_at').notNull().default(now()),
});

export const syncState = sqliteTable('sync_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().default(now()),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().default(now()),
});

export const oauthTokens = sqliteTable('oauth_tokens', {
  provider: text('provider').primaryKey(), // google | microsoft
  data: text('data').notNull(), // 暗号化 JSON
  account: text('account'),
  updatedAt: text('updated_at').notNull().default(now()),
});

export const jobRuns = sqliteTable('job_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  startedAt: text('started_at').notNull().default(now()),
  finishedAt: text('finished_at'),
  ok: integer('ok', { mode: 'boolean' }),
  error: text('error'),
  summary: text('summary'),
});

export const lineQuota = sqliteTable('line_quota', {
  month: text('month').primaryKey(), // YYYY-MM
  pushCount: integer('push_count').notNull().default(0),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().default(now()),
});
