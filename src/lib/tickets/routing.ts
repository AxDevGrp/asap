// Inbound routing: decide whether a new email starts a new ticket, appends to
// the conversation's canonical ticket, or is dropped (spam), then apply the
// status effects through the ticket service.

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { TicketStatus } from '@/lib/db';
import { canTransition } from './status';
import {
  InvalidTransitionError,
  recordEvent,
  transitionTicket,
  type Actor,
} from './service';

/** A resolved ticket can be reopened by a reply within this window. */
export const REOPEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type RoutingEffect = 'move_to_todo' | 'unsnooze' | 'reopen';

export interface RoutingTicket {
  id: string;
  tenant_id?: string;
  status: TicketStatus;
  duplicate_of?: string | null;
  snoozed_until?: string | null;
  snooze_until_reply?: boolean | null;
  resolved_at?: string | null;
  closed_at?: string | null;
  updated_at?: string | null;
}

export type RouteDecision =
  | { action: 'drop'; reason: 'spam' }
  | { action: 'new_ticket' }
  | { action: 'append'; ticketId: string; effects: RoutingEffect[] };

const SYSTEM: Actor = { type: 'system' };

/**
 * Pure routing decision. `ticket` is the canonical latest ticket for the
 * conversation, or null when the conversation has none.
 */
export function decideRoute(input: {
  ticket: RoutingTicket | null;
  conversationStatus: string | null | undefined;
  now: Date;
}): RouteDecision {
  const { ticket, conversationStatus, now } = input;

  if (conversationStatus === 'spam') {
    return { action: 'drop', reason: 'spam' };
  }
  if (!ticket) {
    return { action: 'new_ticket' };
  }

  const { status } = ticket;

  if (status === 'triage') {
    const effects: RoutingEffect[] = [];
    if (isSnoozed(ticket)) effects.push('unsnooze');
    return { action: 'append', ticketId: ticket.id, effects };
  }

  if (status === 'canceled' || status === 'duplicate') {
    // A duplicate reaching this point has no resolvable canonical ticket.
    return { action: 'new_ticket' };
  }

  if (status === 'resolved') {
    const closedAt = firstValidTime(
      ticket.resolved_at,
      ticket.closed_at,
      ticket.updated_at
    );
    if (closedAt !== null && now.getTime() - closedAt <= REOPEN_WINDOW_MS) {
      return { action: 'append', ticketId: ticket.id, effects: ['reopen'] };
    }
    return { action: 'new_ticket' };
  }

  // Active statuses: todo, in_progress, waiting_on_customer, waiting_on_approval.
  const effects: RoutingEffect[] = [];
  if (status === 'waiting_on_customer') effects.push('move_to_todo');
  if (isSnoozed(ticket)) effects.push('unsnooze');
  return { action: 'append', ticketId: ticket.id, effects };
}

function isSnoozed(ticket: RoutingTicket): boolean {
  return ticket.snooze_until_reply === true || Boolean(ticket.snoozed_until);
}

function firstValidTime(...values: (string | null | undefined)[]): number | null {
  for (const value of values) {
    if (!value) continue;
    const time = new Date(value).getTime();
    if (!Number.isNaN(time)) return time;
  }
  return null;
}

export interface RouteInboundInput {
  tenantId: string;
  conversationId: string;
  receivedAt: Date;
}

export interface RouteInboundDeps {
  /** Injectable for tests; defaults to the service-role client. */
  client?: SupabaseClient<any>;
}

const TICKET_COLUMNS =
  'id, tenant_id, status, duplicate_of, snoozed_until, snooze_until_reply, resolved_at, closed_at, updated_at';

/**
 * Load the conversation's canonical latest ticket, decide the route and apply
 * the resulting effects. Effects are retry-safe: transitions that are no longer
 * legal (e.g. an earlier attempt already moved the ticket) are skipped.
 */
export async function routeInbound(
  input: RouteInboundInput,
  deps: RouteInboundDeps = {}
): Promise<RouteDecision> {
  const client = deps.client ?? supabase;
  const { tenantId, conversationId, receivedAt } = input;

  const { data: conversation, error: convoError } = await client
    .from('conversations')
    .select('id, status')
    .eq('id', conversationId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (convoError) throw convoError;

  const { data: latest, error: ticketError } = await client
    .from('tickets')
    .select(TICKET_COLUMNS)
    .eq('conversation_id', conversationId)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (ticketError) throw ticketError;

  let canonical = (latest as RoutingTicket | null) ?? null;

  // Follow duplicate_of links to the canonical ticket (max 5 hops).
  let hops = 0;
  while (canonical?.status === 'duplicate' && canonical.duplicate_of && hops < 5) {
    const { data: parent, error: parentError } = await client
      .from('tickets')
      .select(TICKET_COLUMNS)
      .eq('id', canonical.duplicate_of)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (parentError) throw parentError;
    if (!parent) break;
    canonical = parent as RoutingTicket;
    hops++;
  }

  const decision = decideRoute({
    ticket: canonical,
    conversationStatus: (conversation as { status?: string } | null)?.status,
    now: receivedAt,
  });

  if (decision.action !== 'append') return decision;

  await applyEffects(client, tenantId, decision.ticketId, decision.effects);
  return decision;
}

async function applyEffects(
  client: SupabaseClient<any>,
  tenantId: string,
  ticketId: string,
  effects: RoutingEffect[]
): Promise<void> {
  for (const effect of effects) {
    if (effect === 'move_to_todo' || effect === 'reopen') {
      await safeTransition(client, tenantId, ticketId, 'todo');
    } else if (effect === 'unsnooze') {
      await unsnooze(client, tenantId, ticketId);
    }
  }
}

async function safeTransition(
  client: SupabaseClient<any>,
  tenantId: string,
  ticketId: string,
  to: TicketStatus
): Promise<void> {
  const { data, error } = await client
    .from('tickets')
    .select('status')
    .eq('id', ticketId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw error;
  const from = (data as { status?: TicketStatus } | null)?.status;
  if (!from || !canTransition(from, to)) return;

  try {
    await transitionTicket(ticketId, to, SYSTEM, { tenantId, client });
  } catch (err) {
    // A concurrent retry may have moved it between the read and the write.
    if (err instanceof InvalidTransitionError) return;
    throw err;
  }
}

async function unsnooze(
  client: SupabaseClient<any>,
  tenantId: string,
  ticketId: string
): Promise<void> {
  const { data, error } = await client
    .from('tickets')
    .select('snoozed_until, snooze_until_reply')
    .eq('id', ticketId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw error;

  const row = data as
    | { snoozed_until?: string | null; snooze_until_reply?: boolean | null }
    | null;
  if (!row || (!row.snooze_until_reply && !row.snoozed_until)) return;

  const { error: updateError } = await client
    .from('tickets')
    .update({ snoozed_until: null, snooze_until_reply: false })
    .eq('id', ticketId)
    .eq('tenant_id', tenantId);
  if (updateError) throw updateError;

  await recordEvent(
    { tenantId, ticketId, kind: 'unsnoozed', actor: SYSTEM },
    client
  );
}
