import { supabase } from './supabase';

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
