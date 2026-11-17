import { supabase } from './supabase';
import { embedDocument } from './embeddings';
import { createClient } from '@supabase/supabase-js';

// Service-role client for server-side writes that bypass RLS
function getServiceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

// ── Knowledge Base ─────────────────────────────────────────────────────────────

export interface KBArticleInsert {
  product: string;
  title: string;
  content: string;
  tenant_id?: string | null;
}

export interface KBArticleRow extends KBArticleInsert {
  id: string;
  created_at: string;
  updated_at: string;
}

/**
 * Insert a new KB article, embedding it automatically.
 */
export async function createKBArticle(data: KBArticleInsert): Promise<KBArticleRow | null> {
  let embedding: number[] | null = null;
  try {
    embedding = await embedDocument(data.title, data.content);
  } catch (err) {
    console.error('[DB] createKBArticle: embedding failed, inserting without embedding:', err);
  }

  const { data: row, error } = await supabase
    .from('knowledge_base')
    .insert({ ...data, embedding })
    .select('id, product, tenant_id, title, content, created_at, updated_at')
    .single();

  if (error) {
    console.error('[DB] createKBArticle error:', error);
    return null;
  }
  return row as KBArticleRow;
}

/**
 * List a tenant's KB articles (no embeddings returned).
 */
export async function listKBArticles(tenantId: string): Promise<KBArticleRow[]> {
  const { data, error } = await supabase
    .from('knowledge_base')
    .select('id, product, tenant_id, title, content, created_at, updated_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[DB] listKBArticles error:', error);
    return [];
  }
  return (data ?? []) as KBArticleRow[];
}

/**
 * Update a KB article by ID. Re-embeds on title/content change.
 */
export async function updateKBArticle(
  id: string,
  updates: Partial<Pick<KBArticleInsert, 'title' | 'content' | 'product'>>,
  tenantId: string
): Promise<KBArticleRow | null> {
  const updateData: Record<string, unknown> = { ...updates };

  // Re-embed if title or content changed
  if (updates.title || updates.content) {
    // Need both title and content for embedding — fetch current if only one changed
    if (!updates.title || !updates.content) {
      const { data: current } = await supabase
        .from('knowledge_base')
        .select('title, content')
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();
      if (current) {
        const title = updates.title ?? current.title;
        const content = updates.content ?? current.content;
        try {
          updateData.embedding = await embedDocument(title, content);
        } catch (err) {
          console.error('[DB] updateKBArticle: re-embedding failed:', err);
        }
      }
    } else {
      try {
        updateData.embedding = await embedDocument(updates.title, updates.content);
      } catch (err) {
        console.error('[DB] updateKBArticle: re-embedding failed:', err);
      }
    }
  }

  const { data: row, error } = await supabase
    .from('knowledge_base')
    .update(updateData)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select('id, product, tenant_id, title, content, created_at, updated_at')
    .single();

  if (error) {
    console.error('[DB] updateKBArticle error:', error);
    return null;
  }
  return row as KBArticleRow;
}

/**
 * Delete a KB article by ID.
 */
export async function deleteKBArticle(id: string, tenantId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('knowledge_base')
    .delete()
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select('id');
  if (error) {
    console.error('[DB] deleteKBArticle error:', error);
    return false;
  }
  return (data ?? []).length > 0;
}

// ── Conversations (Custom Engine) ─────────────────────────────────────────────────────────────

export interface ConversationInsert {
  tenant_id: string;
  customer_email: string;
  customer_name?: string | null;
  subject: string;
  status?: 'open' | 'pending' | 'closed' | 'spam';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
}

export interface ConversationRow extends ConversationInsert {
  id: string;
  created_at: string;
  updated_at: string;
}

/**
 * Create or find a conversation for a specific customer/tenant.
 */
export async function findOrCreateConversation(data: ConversationInsert): Promise<ConversationRow | null> {
  const db = getServiceSupabase();

  // 1. Try to find an existing open conversation for this email/tenant
  const { data: existing } = await db
    .from('conversations')
    .select('*')
    .eq('tenant_id', data.tenant_id)
    .eq('customer_email', data.customer_email)
    .eq('status', 'open')
    .maybeSingle();

  if (existing) return existing as ConversationRow;

  // 2. Otherwise, create a new one
  const { data: newConvo, error } = await db
    .from('conversations')
    .insert(data)
    .select('*')
    .single();

  if (error) {
    console.error('[DB] findOrCreateConversation error:', error);
    return null;
  }

  return newConvo as ConversationRow;
}

/**
 * Log an inbound message into a conversation.
 */
export async function createInboundMessage(data: {
  conversation_id: string;
  tenant_id: string;
  from_email: string;
  subject: string;
  body_text: string;
  body_html?: string | null;
  message_id?: string | null;
}) {
  const db = getServiceSupabase();
  const { error } = await db
    .from('inbound_messages')
    .insert({
      conversation_id: data.conversation_id,
      tenant_id: data.tenant_id,
      from_email: data.from_email,
      subject: data.subject,
      body_text: data.body_text,
      body_html: data.body_html ?? null,
      message_id: data.message_id ?? null,
    });

  if (error) {
    console.error('[DB] createInboundMessage error:', error);
  }
}

/**
 * Check whether an inbound message with this provider message ID was already
 * processed (used to deduplicate webhook retries).
 */
export async function hasInboundMessage(messageId: string): Promise<boolean> {
  const db = getServiceSupabase();
  const { data } = await db
    .from('inbound_messages')
    .select('id')
    .eq('message_id', messageId)
    .limit(1)
    .maybeSingle();
  return Boolean(data);
}

// ── Tickets ─────────────────────────────────────────────────────────────────────

export type TicketStatus =
  | 'triage'
  | 'todo'
  | 'in_progress'
  | 'waiting_on_customer'
  | 'waiting_on_approval'
  | 'resolved'
  | 'canceled'
  | 'duplicate';

export type TicketPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

/** Map AI triage urgency onto the ticket priority scale. */
export function urgencyToPriority(
  urgency: string | null | undefined
): TicketPriority {
  switch (urgency) {
    case 'critical':
      return 'urgent';
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    case 'low':
      return 'low';
    default:
      return 'none';
  }
}

export interface TicketInsert {
  product?: string | null;
  tenant_id?: string | null;
  conversation_id?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  subject?: string | null;
  title?: string | null;
  body?: string | null;
  triage_type?: string | null;
  triage_urgency?: 'low' | 'medium' | 'high' | 'critical' | null;
  triage_summary?: string | null;
  triage_confidence?: number | null;
  ai_suggested_priority?: 'low' | 'medium' | 'high' | 'urgent' | null;
  ai_suggested_type?: string | null;
  ai_suggested_label_ids?: string[] | null;
  ai_spam_probability?: number | null;
  ai_needs_human_probability?: number | null;
  auto_reply_sent?: boolean;
  auto_reply_text?: string | null;
  auto_resolved?: boolean;
  resolve_reason?: string | null;
  status?: TicketStatus;
  priority?: TicketPriority;
  number?: number | null;
  owner_id?: string | null;
  agent_delegated?: boolean;
  duplicate_of?: string | null;
  snoozed_until?: string | null;
  snooze_until_reply?: boolean;
  decline_kind?: 'spam' | 'not_actionable' | null;
  accepted_at?: string | null;
  first_response_at?: string | null;
  resolved_at?: string | null;
  closed_at?: string | null;
}

export interface TicketRow extends TicketInsert {
  id: string;
  created_at: string;
  updated_at: string;
}

export interface ResolveAuditInsert {
  ticket_id?: string | null;
  product: string;
  tenant_id?: string | null;
  auto_send: boolean;
  reason: string;
  triage_confidence?: number | null;
  triage_type?: string | null;
  triage_urgency?: string | null;
  kb_hits?: number;
  top_kb_similarity?: number | null;
  policy_version?: number | null;
}

export interface MessageInsert {
  ticket_id: string;
  direction: 'incoming' | 'outgoing';
  content: string;
  sender_name?: string | null;
  tenant_id?: string | null;
}

/**
 * Create a new ticket record. Returns the created ticket or null on error.
 */
export async function createTicket(data: TicketInsert) {
  const { data: ticket, error } = await supabase
    .from('tickets')
    .insert(data)
    .select()
    .single();

  if (error) {
    console.error('[DB] createTicket error:', error);
    return null;
  }
  return ticket;
}

/**
 * Update a ticket by its ID.
 */
export async function updateTicket(id: string, updates: Partial<TicketInsert>) {
  const { error } = await supabase
    .from('tickets')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) {
    console.error('[DB] updateTicket error:', error);
  }
}

/**
 * Get all messages for a ticket, ordered chronologically.
 */
export async function getMessagesByTicketId(ticketId: string) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[DB] getMessagesByTicketId error:', error);
    return [];
  }
  return data ?? [];
}

/**
 * Log a message to the messages table.
 */
export async function createMessage(data: MessageInsert) {
  const { error } = await supabase
    .from('messages')
    .insert(data);

  if (error) {
    console.error('[DB] createMessage error:', error);
  }
}

/**
 * Insert an audit record for an auto-resolve decision.
 * Every decision (both auto-send and draft-only) is logged for analysis.
 */
export async function createResolveAudit(data: ResolveAuditInsert): Promise<void> {
  const { error } = await supabase
    .from('resolve_audit')
    .insert(data);

  if (error) {
    console.error('[DB] createResolveAudit error:', error);
  }
}

// ── Outbound Messages (Resend email delivery tracking) ───────────────────────

export interface OutboundMessageInsert {
  tenant_id: string;
  ticket_id?: string | null;
  resend_message_id?: string | null;
  to_email: string;
  from_email: string;
  subject: string;
  body_text: string;
  body_html?: string | null;
  status?: 'pending' | 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed';
  error_message?: string | null;
  idempotency_key?: string | null;
}

export interface OutboundMessageRow extends OutboundMessageInsert {
  id: string;
  created_at: string;
  updated_at: string;
}

/**
 * Log an outbound email (Resend send attempt) to the database.
 */
export async function createOutboundMessage(
  data: OutboundMessageInsert
): Promise<OutboundMessageRow | null> {
  const { data: row, error } = await supabase
    .from('outbound_messages')
    .insert(data)
    .select('*')
    .single();

  if (error) {
    console.error('[DB] createOutboundMessage error:', error);
    return null;
  }
  return row as OutboundMessageRow;
}

/**
 * Reserve an outbound message (insert). Distinguishes a unique-key conflict
 * (code 23505, e.g. idempotency_key already reserved) from real errors:
 * conflict -> { row: null, conflict: true }; other errors throw so callers can
 * retry instead of silently treating a failure as "already sent".
 */
export async function reserveOutboundMessage(
  data: OutboundMessageInsert
): Promise<{ row: OutboundMessageRow | null; conflict: boolean }> {
  const { data: row, error } = await supabase
    .from('outbound_messages')
    .insert(data)
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') {
      return { row: null, conflict: true };
    }
    throw new Error(`reserveOutboundMessage failed: ${error.message}`);
  }
  return { row: row as OutboundMessageRow, conflict: false };
}

/**
 * Update an outbound message by its Resend message ID (e.g. on delivery webhook).
 */
export async function updateOutboundMessageByResendId(
  resendMessageId: string,
  updates: Partial<Pick<OutboundMessageInsert, 'status' | 'error_message'>>
): Promise<void> {
  const { error } = await supabase
    .from('outbound_messages')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('resend_message_id', resendMessageId);

  if (error) {
    console.error('[DB] updateOutboundMessageByResendId error:', error);
  }
}

/**
 * Get all outbound messages for a ticket.
 */
export async function getOutboundMessagesByTicketId(
  ticketId: string
): Promise<OutboundMessageRow[]> {
  const { data, error } = await supabase
    .from('outbound_messages')
    .select('*')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[DB] getOutboundMessagesByTicketId error:', error);
    return [];
  }
  return (data ?? []) as OutboundMessageRow[];
}

/**
 * Get all outbound messages for a tenant (for analytics / review UI).
 */
export async function getOutboundMessagesByTenantId(
  tenantId: string,
  limit = 50
): Promise<OutboundMessageRow[]> {
  const { data, error } = await supabase
    .from('outbound_messages')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[DB] getOutboundMessagesByTenantId error:', error);
    return [];
  }
  return (data ?? []) as OutboundMessageRow[];
}

/**
 * Get an outbound message by its idempotency key (used to dedupe sends).
 */
export async function getOutboundMessageByIdempotencyKey(
  key: string
): Promise<OutboundMessageRow | null> {
  const { data, error } = await supabase
    .from('outbound_messages')
    .select('*')
    .eq('idempotency_key', key)
    .maybeSingle();

  if (error) {
    console.error('[DB] getOutboundMessageByIdempotencyKey error:', error);
    return null;
  }
  return (data as OutboundMessageRow) ?? null;
}

/**
 * Update an outbound message by its ID.
 */
export async function updateOutboundMessage(
  id: string,
  updates: Partial<OutboundMessageInsert>
): Promise<void> {
  const { error } = await supabase
    .from('outbound_messages')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) {
    console.error('[DB] updateOutboundMessage error:', error);
  }
}
