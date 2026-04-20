import { supabase } from './supabase';
import { embedText } from './embeddings';

// ── Knowledge Base ─────────────────────────────────────────────────────────────

export interface KBArticleInsert {
  product: string;
  title: string;
  content: string;
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
    embedding = await embedText(`${data.title}\n${data.content}`);
  } catch (err) {
    console.error('[DB] createKBArticle: embedding failed, inserting without embedding:', err);
  }

  const { data: row, error } = await supabase
    .from('knowledge_base')
    .insert({ ...data, embedding })
    .select('id, product, title, content, created_at, updated_at')
    .single();

  if (error) {
    console.error('[DB] createKBArticle error:', error);
    return null;
  }
  return row as KBArticleRow;
}

/**
 * List all KB articles for a product (no embeddings returned).
 */
export async function listKBArticles(product?: string): Promise<KBArticleRow[]> {
  let query = supabase
    .from('knowledge_base')
    .select('id, product, title, content, created_at, updated_at')
    .order('created_at', { ascending: false });

  if (product) query = query.eq('product', product);

  const { data, error } = await query;
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
  updates: Partial<Pick<KBArticleInsert, 'title' | 'content' | 'product'>>
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
        .single();
      if (current) {
        const title = updates.title ?? current.title;
        const content = updates.content ?? current.content;
        try {
          updateData.embedding = await embedText(`${title}\n${content}`);
        } catch (err) {
          console.error('[DB] updateKBArticle: re-embedding failed:', err);
        }
      }
    } else {
      try {
        updateData.embedding = await embedText(`${updates.title}\n${updates.content}`);
      } catch (err) {
        console.error('[DB] updateKBArticle: re-embedding failed:', err);
      }
    }
  }

  const { data: row, error } = await supabase
    .from('knowledge_base')
    .update(updateData)
    .eq('id', id)
    .select('id, product, title, content, created_at, updated_at')
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
export async function deleteKBArticle(id: string): Promise<boolean> {
  const { error } = await supabase.from('knowledge_base').delete().eq('id', id);
  if (error) {
    console.error('[DB] deleteKBArticle error:', error);
    return false;
  }
  return true;
}

// ── Tickets ─────────────────────────────────────────────────────────────────────

export interface TicketInsert {
  chatwoot_inbox_id: number;
  chatwoot_convo_id: number;
  product: string;
  contact_name?: string | null;
  contact_email?: string | null;
  triage_type?: string;
  triage_urgency?: 'low' | 'medium' | 'high' | 'critical';
  triage_summary?: string;
  triage_confidence?: number;
  auto_reply_sent?: boolean;
  auto_reply_text?: string;
  status?: 'open' | 'resolved' | 'pending';
}

export interface MessageInsert {
  ticket_id: string;
  chatwoot_message_id: number;
  direction: 'incoming' | 'outgoing';
  content: string;
  sender_name?: string | null;
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
 * Update a ticket by its Chatwoot conversation ID.
 */
export async function updateTicketByConvoId(
  chatwootConvoId: number,
  updates: Partial<TicketInsert>
) {
  const { error } = await supabase
    .from('tickets')
    .update(updates)
    .eq('chatwoot_convo_id', chatwootConvoId);

  if (error) {
    console.error('[DB] updateTicket error:', error);
  }
}

/**
 * Get a ticket by Chatwoot conversation ID.
 */
export async function getTicketByConvoId(chatwootConvoId: number) {
  const { data, error } = await supabase
    .from('tickets')
    .select('*')
    .eq('chatwoot_convo_id', chatwootConvoId)
    .single();

  if (error) return null;
  return data;
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
