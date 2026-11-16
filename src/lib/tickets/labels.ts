import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import {
  recordEvent,
  TicketNotFoundError,
  type Actor,
} from './service';

export interface Label {
  id: string;
  tenant_id: string;
  name: string;
  color: string;
  description: string | null;
  created_at: string;
}

export class DuplicateLabelError extends Error {
  constructor() {
    super('A label with that name already exists');
    this.name = 'DuplicateLabelError';
  }
}

export class LabelNotFoundError extends Error {
  constructor(labelId: string) {
    super(`Label not found: ${labelId}`);
    this.name = 'LabelNotFoundError';
  }
}

interface ClientOptions {
  client?: SupabaseClient<any>;
}

export interface LabelInput {
  name: string;
  color?: string;
  description?: string | null;
}

export interface LabelPatch {
  name?: string;
  color?: string;
  description?: string | null;
}

export interface LabelContextOptions extends ClientOptions {
  tenantId?: string;
}

const LABEL_COLUMNS = 'id, tenant_id, name, color, description, created_at';

function isDuplicateCode(error: { code?: string } | null): boolean {
  return error?.code === '23505';
}

export async function listLabels(
  tenantId: string,
  opts: ClientOptions = {}
): Promise<Label[]> {
  const client = opts.client ?? supabase;
  const { data, error } = await client
    .from('labels')
    .select(LABEL_COLUMNS)
    .eq('tenant_id', tenantId)
    .order('name', { ascending: true });

  if (error) throw error;
  return (data ?? []) as Label[];
}

export async function createLabel(
  tenantId: string,
  input: LabelInput,
  opts: ClientOptions = {}
): Promise<Label> {
  const client = opts.client ?? supabase;
  const { data, error } = await client
    .from('labels')
    .insert({
      tenant_id: tenantId,
      name: input.name.trim(),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    })
    .select(LABEL_COLUMNS)
    .single();

  if (isDuplicateCode(error)) throw new DuplicateLabelError();
  if (error) throw error;
  return data as Label;
}

export async function updateLabel(
  tenantId: string,
  labelId: string,
  patch: LabelPatch,
  opts: ClientOptions = {}
): Promise<Label> {
  const client = opts.client ?? supabase;
  const updates: Record<string, unknown> = {};
  if (patch.name !== undefined) updates.name = patch.name.trim();
  if (patch.color !== undefined) updates.color = patch.color;
  if (patch.description !== undefined) updates.description = patch.description;

  const { data, error } = await client
    .from('labels')
    .update(updates)
    .eq('id', labelId)
    .eq('tenant_id', tenantId)
    .select(LABEL_COLUMNS);

  if (isDuplicateCode(error)) throw new DuplicateLabelError();
  if (error) throw error;

  const rows = (data ?? []) as Label[];
  if (rows.length !== 1) throw new LabelNotFoundError(labelId);
  return rows[0];
}

export async function deleteLabel(
  tenantId: string,
  labelId: string,
  opts: ClientOptions = {}
): Promise<void> {
  const client = opts.client ?? supabase;
  const { data, error } = await client
    .from('labels')
    .delete()
    .eq('id', labelId)
    .eq('tenant_id', tenantId)
    .select('id');

  if (error) throw error;
  if (!data || data.length === 0) throw new LabelNotFoundError(labelId);
}

async function loadTicketAndLabel(
  client: SupabaseClient<any>,
  ticketId: string,
  labelId: string,
  tenantId: string | undefined
): Promise<{ tenantId: string; label: Label }> {
  const { data: ticket, error: ticketError } = await client
    .from('tickets')
    .select('id, tenant_id')
    .eq('id', ticketId)
    .maybeSingle();

  if (ticketError) throw ticketError;
  if (!ticket) throw new TicketNotFoundError(ticketId);
  if (tenantId !== undefined && ticket.tenant_id !== tenantId) {
    throw new TicketNotFoundError(ticketId);
  }

  const { data: label, error: labelError } = await client
    .from('labels')
    .select(LABEL_COLUMNS)
    .eq('id', labelId)
    .eq('tenant_id', ticket.tenant_id)
    .maybeSingle();

  if (labelError) throw labelError;
  if (!label) throw new LabelNotFoundError(labelId);

  return { tenantId: ticket.tenant_id, label: label as Label };
}

async function findAssociation(
  client: SupabaseClient<any>,
  ticketId: string,
  labelId: string
): Promise<boolean> {
  const { data, error } = await client
    .from('ticket_labels')
    .select('ticket_id')
    .eq('ticket_id', ticketId)
    .eq('label_id', labelId)
    .maybeSingle();

  if (error) throw error;
  return data !== null;
}

export async function addLabel(
  ticketId: string,
  labelId: string,
  actor: Actor,
  opts: LabelContextOptions = {}
): Promise<Label> {
  const client = opts.client ?? supabase;
  const { tenantId, label } = await loadTicketAndLabel(
    client,
    ticketId,
    labelId,
    opts.tenantId
  );

  if (await findAssociation(client, ticketId, labelId)) return label;

  const { error } = await client.from('ticket_labels').insert({
    ticket_id: ticketId,
    label_id: labelId,
    added_by_type: actor.type,
    added_by_id: actor.id ?? null,
  });

  // A concurrent request may have added the same label; that is still a no-op.
  if (error && !isDuplicateCode(error)) throw error;

  if (!error) {
    await recordEvent(
      {
        tenantId,
        ticketId,
        kind: 'label_added',
        actor,
        to: label.name,
        data: { label_id: label.id },
      },
      client
    );
  }

  return label;
}

export async function removeLabel(
  ticketId: string,
  labelId: string,
  actor: Actor,
  opts: LabelContextOptions = {}
): Promise<Label> {
  const client = opts.client ?? supabase;
  const { tenantId, label } = await loadTicketAndLabel(
    client,
    ticketId,
    labelId,
    opts.tenantId
  );

  if (!(await findAssociation(client, ticketId, labelId))) return label;

  const { error } = await client
    .from('ticket_labels')
    .delete()
    .eq('ticket_id', ticketId)
    .eq('label_id', labelId);

  if (error) throw error;

  await recordEvent(
    {
      tenantId,
      ticketId,
      kind: 'label_removed',
      actor,
      from: label.name,
      data: { label_id: label.id },
    },
    client
  );

  return label;
}

interface TicketLabelRow {
  labels: Label | Label[] | null;
}

export async function listTicketLabels(
  ticketId: string,
  opts: ClientOptions = {}
): Promise<Label[]> {
  const client = opts.client ?? supabase;
  const { data, error } = await client
    .from('ticket_labels')
    .select(`label_id, labels (${LABEL_COLUMNS})`)
    .eq('ticket_id', ticketId);

  if (error) throw error;

  return ((data ?? []) as TicketLabelRow[])
    .flatMap((row) => (Array.isArray(row.labels) ? row.labels : row.labels ? [row.labels] : []))
    .sort((a, b) => a.name.localeCompare(b.name));
}
