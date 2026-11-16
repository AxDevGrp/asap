import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { TicketPriority, TicketStatus } from '@/lib/db';
import {
  canTransition,
  categoryOf,
  CLOSED_STATUSES,
} from './status';

export type Actor = {
  type: 'user' | 'agent' | 'system' | 'rule';
  id?: string;
};

export class InvalidTransitionError extends Error {
  readonly from: TicketStatus;
  readonly to: TicketStatus;

  constructor(from: TicketStatus, to: TicketStatus) {
    super(`Invalid ticket transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export class TicketNotFoundError extends Error {
  constructor(ticketId: string) {
    super(`Ticket not found: ${ticketId}`);
    this.name = 'TicketNotFoundError';
  }
}

export class ConcurrentUpdateError extends Error {
  constructor(ticketId: string) {
    super(`Ticket was modified concurrently: ${ticketId}`);
    this.name = 'ConcurrentUpdateError';
  }
}

export type TicketEventKind =
  | 'created'
  | 'status_changed'
  | 'priority_changed'
  | 'owner_changed'
  | 'label_added'
  | 'label_removed'
  | 'merged'
  | 'snoozed'
  | 'unsnoozed'
  | 'declined'
  | 'accepted'
  | 'reopened'
  | 'agent_delegated'
  | 'agent_undelegated'
  | 'comment_added'
  | 'sla_at_risk'
  | 'sla_breached'
  | 'contact_notified';

export interface TicketEvent {
  id: string;
  tenant_id: string;
  ticket_id: string;
  kind: TicketEventKind;
  actor_type: Actor['type'];
  actor_id: string | null;
  from_value: string | null;
  to_value: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

export type TicketEventListener = (event: TicketEvent) => void;

const listeners: TicketEventListener[] = [];

/**
 * Register a listener for ticket events. Returns an unsubscribe function.
 * Listeners are in-process only and never persisted.
 */
export function onTicketEvent(listener: TicketEventListener): () => void {
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index !== -1) listeners.splice(index, 1);
  };
}

/**
 * Notify listeners. A throwing listener is logged and skipped so it can never
 * break the database write that emitted the event.
 */
export function emitTicketEvent(event: TicketEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (err) {
      console.error('[tickets] ticket event listener failed:', err);
    }
  }
}

interface TicketRecord {
  id: string;
  tenant_id: string;
  status: TicketStatus;
  accepted_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  priority?: TicketPriority;
  owner_id?: string | null;
  agent_delegated?: boolean;
}

export interface TicketEventInput {
  tenantId: string;
  ticketId: string;
  kind: TicketEventKind;
  actor: Actor;
  from?: string | null;
  to?: string | null;
  data?: Record<string, unknown>;
}

/** Insert one ticket_events row, then emit it to in-process listeners. */
export async function recordEvent(
  input: TicketEventInput,
  client: SupabaseClient<any> = supabase
): Promise<TicketEvent> {
  const { data, error } = await client
    .from('ticket_events')
    .insert({
      tenant_id: input.tenantId,
      ticket_id: input.ticketId,
      kind: input.kind,
      actor_type: input.actor.type,
      actor_id: input.actor.id ?? null,
      from_value: input.from ?? null,
      to_value: input.to ?? null,
      data: input.data ?? {},
    })
    .select()
    .single();

  if (error) {
    throw new Error(`recordEvent failed: ${error.message}`);
  }

  const event = data as TicketEvent;
  emitTicketEvent(event);
  return event;
}

async function loadTicket(
  client: SupabaseClient<any>,
  ticketId: string,
  tenantId: string | undefined,
  columns: string
): Promise<TicketRecord> {
  const { data, error } = await client
    .from('tickets')
    .select(columns)
    .eq('id', ticketId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new TicketNotFoundError(ticketId);

  const ticket = data as unknown as TicketRecord;
  if (tenantId !== undefined && ticket.tenant_id !== tenantId) {
    throw new TicketNotFoundError(ticketId);
  }
  return ticket;
}

function requireSingleRow<T>(rows: T[] | null, ticketId: string): T {
  if (!rows || rows.length !== 1) throw new ConcurrentUpdateError(ticketId);
  return rows[0];
}

const TRANSITION_COLUMNS =
  'id, tenant_id, status, accepted_at, resolved_at, closed_at';

export interface TransitionOptions {
  tenantId?: string;
  data?: Record<string, unknown>;
  client?: SupabaseClient<any>;
}

/**
 * Move a ticket to a new status, enforcing the transition matrix and writing
 * exactly one timeline event. Throws before writing anything when the
 * transition is illegal or the ticket belongs to another tenant.
 */
export async function transitionTicket(
  ticketId: string,
  to: TicketStatus,
  actor: Actor,
  opts: TransitionOptions = {}
): Promise<TicketRecord> {
  const client = opts.client ?? supabase;
  const ticket = await loadTicket(client, ticketId, opts.tenantId, TRANSITION_COLUMNS);
  const from = ticket.status;

  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { status: to };

  if (from === 'triage' && categoryOf(to) === 'active' && !ticket.accepted_at) {
    updates.accepted_at = now;
  }

  if (to === 'resolved') {
    updates.resolved_at = now;
    updates.closed_at = now;
  } else if (to === 'canceled' || to === 'duplicate') {
    updates.resolved_at = null;
    updates.closed_at = now;
  } else if (CLOSED_STATUSES.includes(from) && to === 'todo') {
    updates.resolved_at = null;
    updates.closed_at = null;
  }

  const { data, error } = await client
    .from('tickets')
    .update(updates)
    .eq('id', ticketId)
    .eq('status', from)
    .select();

  if (error) throw error;
  const updated = requireSingleRow(data as TicketRecord[] | null, ticketId);

  const kind: TicketEventKind =
    CLOSED_STATUSES.includes(from) && to === 'todo'
      ? 'reopened'
      : from === 'triage' && categoryOf(to) === 'active'
        ? 'accepted'
        : 'status_changed';

  await recordEvent(
    {
      tenantId: ticket.tenant_id,
      ticketId,
      kind,
      actor,
      from,
      to,
      data: opts.data,
    },
    client
  );

  return updated;
}

export interface WriteOptions {
  tenantId?: string;
  data?: Record<string, unknown>;
  client?: SupabaseClient<any>;
}

async function writeEvent(
  client: SupabaseClient<any>,
  ticket: TicketRecord,
  ticketId: string,
  updates: Record<string, unknown>,
  event: Omit<TicketEventInput, 'tenantId' | 'ticketId' | 'actor'>,
  actor: Actor,
  data: Record<string, unknown> | undefined
): Promise<TicketRecord> {
  const { data: rows, error } = await client
    .from('tickets')
    .update(updates)
    .eq('id', ticketId)
    .select();

  if (error) throw error;
  const updated = requireSingleRow(rows as TicketRecord[] | null, ticketId);

  await recordEvent(
    {
      ...event,
      tenantId: ticket.tenant_id,
      ticketId,
      actor,
      data,
    },
    client
  );

  return updated;
}

/** Set priority, writing an event only when the value actually changes. */
export async function setPriority(
  ticketId: string,
  priority: TicketPriority,
  actor: Actor,
  opts: WriteOptions = {}
): Promise<TicketRecord> {
  const client = opts.client ?? supabase;
  const ticket = await loadTicket(
    client,
    ticketId,
    opts.tenantId,
    'id, tenant_id, status, priority'
  );

  if (ticket.priority === priority) return ticket;

  return writeEvent(
    client,
    ticket,
    ticketId,
    { priority },
    {
      kind: 'priority_changed',
      from: ticket.priority ?? null,
      to: priority,
    },
    actor,
    opts.data
  );
}

/** Set the owner (or clear it), writing an event only on change. */
export async function setOwner(
  ticketId: string,
  ownerId: string | null,
  actor: Actor,
  opts: WriteOptions = {}
): Promise<TicketRecord> {
  const client = opts.client ?? supabase;
  const ticket = await loadTicket(
    client,
    ticketId,
    opts.tenantId,
    'id, tenant_id, status, owner_id'
  );

  if ((ticket.owner_id ?? null) === ownerId) return ticket;

  return writeEvent(
    client,
    ticket,
    ticketId,
    { owner_id: ownerId },
    {
      kind: 'owner_changed',
      from: ticket.owner_id ?? null,
      to: ownerId,
    },
    actor,
    opts.data
  );
}

/** Delegate a ticket to the agent (or take it back), event only on change. */
export async function setAgentDelegated(
  ticketId: string,
  delegated: boolean,
  actor: Actor,
  opts: WriteOptions = {}
): Promise<TicketRecord> {
  const client = opts.client ?? supabase;
  const ticket = await loadTicket(
    client,
    ticketId,
    opts.tenantId,
    'id, tenant_id, status, agent_delegated'
  );

  if ((ticket.agent_delegated ?? false) === delegated) return ticket;

  return writeEvent(
    client,
    ticket,
    ticketId,
    { agent_delegated: delegated },
    {
      kind: delegated ? 'agent_delegated' : 'agent_undelegated',
      from: String(ticket.agent_delegated ?? false),
      to: String(delegated),
    },
    actor,
    opts.data
  );
}
