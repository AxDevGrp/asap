// Ticket list query helpers for ASAP-7.
//
// Pure parsing/building pieces (unit-tested in __tests__/query.test.ts) plus the
// executor (`listTickets`) and shared tenant/ticket loaders used by the tickets
// API routes. All reads/writes through the service-role client are explicitly
// filtered by tenant_id.

import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { createSupabaseServerClient } from '@/lib/supabase-server';
import { requireTenantMember, type TenantRole } from '@/lib/auth';
import {
  ACTIVE_STATUSES,
  CLOSED_STATUSES,
  TICKET_STATUSES,
} from './status';
import type { TicketPriority, TicketStatus } from '@/lib/db';

export const TICKET_PRIORITIES = [
  'none',
  'low',
  'medium',
  'high',
  'urgent',
] as const satisfies readonly TicketPriority[];

export type SortKey = 'created' | 'updated' | 'priority' | 'number';

export const SORT_COLUMNS: Record<SortKey, string> = {
  created: 'created_at',
  updated: 'updated_at',
  priority: 'priority_rank',
  number: 'number',
};

const CATEGORY_STATUSES: Record<
  'triage' | 'active' | 'closed',
  readonly TicketStatus[]
> = {
  triage: ['triage'],
  active: ACTIVE_STATUSES,
  closed: CLOSED_STATUSES,
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Tenant resolution ─────────────────────────────────────────────────────────

export type CallerTenant =
  | { tenantId: string; userId: string; role: TenantRole }
  | { error: NextResponse };

/**
 * Caller tenant = `?tenant_id=` when present (must be a member), otherwise the
 * caller's primary membership (earliest created_at). Signed-out → 401, no
 * membership → 403.
 */
export async function resolveCallerTenant(
  request: Request
): Promise<CallerTenant> {
  const tenantIdParam = new URL(request.url).searchParams.get('tenant_id');

  if (tenantIdParam !== null && tenantIdParam !== '') {
    if (!UUID_RE.test(tenantIdParam)) {
      return {
        error: NextResponse.json(
          { error: 'You are not a member of this workspace' },
          { status: 403 }
        ),
      };
    }
    const member = await requireTenantMember(tenantIdParam);
    if ('error' in member) return { error: member.error };
    return {
      tenantId: tenantIdParam,
      userId: member.userId,
      role: member.role,
    };
  }

  const serverClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await serverClient.auth.getUser();
  if (!user) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const { data, error } = await serverClient
    .from('tenant_memberships')
    .select('tenant_id, role')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    return {
      error: NextResponse.json(
        { error: 'Membership lookup failed' },
        { status: 500 }
      ),
    };
  }
  if (!data) {
    return {
      error: NextResponse.json(
        { error: 'You are not a member of any workspace' },
        { status: 403 }
      ),
    };
  }

  return {
    tenantId: data.tenant_id,
    userId: user.id,
    role: data.role as TenantRole,
  };
}

// ── Query schema ──────────────────────────────────────────────────────────────

function collectMulti(searchParams: URLSearchParams, key: string): string[] {
  const values: string[] = [];
  for (const raw of searchParams.getAll(key)) {
    for (const part of raw.split(',')) {
      const value = part.trim();
      if (value) values.push(value);
    }
  }
  return values;
}

const listParamsObjectSchema = z.object({
  statuses: z.array(z.enum(TICKET_STATUSES)).optional(),
  categories: z.array(z.enum(['triage', 'active', 'closed'])).optional(),
  priorities: z.array(z.enum(TICKET_PRIORITIES)).optional(),
  owner: z.union([z.enum(['me', 'unassigned']), z.string().uuid()]).optional(),
  labels: z.array(z.string().min(1)).optional(),
  agent: z.boolean().optional(),
  q: z.string().min(1).max(200).optional(),
  sort: z.enum(['created', 'updated', 'priority', 'number']).default('updated'),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export type TicketListParams = z.infer<typeof listParamsObjectSchema>;

export const ticketListQuerySchema = z
  .instanceof(URLSearchParams)
  .transform((searchParams) => {
    const raw: Record<string, unknown> = {};

    const statuses = collectMulti(searchParams, 'status');
    if (statuses.length) raw.statuses = statuses;

    const categories = collectMulti(searchParams, 'category');
    if (categories.length) raw.categories = categories;

    const priorities = collectMulti(searchParams, 'priority');
    if (priorities.length) raw.priorities = priorities;

    const owner = searchParams.get('owner');
    if (owner) raw.owner = owner;

    const labels = collectMulti(searchParams, 'label');
    if (labels.length) raw.labels = labels;

    const agent = searchParams.get('agent');
    if (agent !== null && agent !== '') {
      raw.agent = agent === 'true' ? true : agent === 'false' ? false : agent;
    }

    const q = searchParams.get('q');
    if (q !== null) raw.q = q;

    const sort = searchParams.get('sort');
    if (sort) raw.sort = sort;

    const cursor = searchParams.get('cursor');
    if (cursor) raw.cursor = cursor;

    const limit = searchParams.get('limit');
    if (limit !== null && limit !== '') raw.limit = Number(limit);

    return raw;
  })
  .pipe(listParamsObjectSchema);

// ── Cursor ────────────────────────────────────────────────────────────────────

export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

function valueKindFor(sort: SortKey): 'string' | 'number' {
  return sort === 'priority' || sort === 'number' ? 'number' : 'string';
}

export function encodeCursor(
  sort: SortKey,
  value: string | number,
  id: string
): string {
  return Buffer.from(JSON.stringify({ s: sort, v: value, id })).toString(
    'base64url'
  );
}

export function decodeCursor(
  raw: string,
  expectedSort: SortKey
): { s: SortKey; v: string | number; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidCursorError();
  }

  const cursor = parsed as Record<string, unknown>;
  if (cursor.s !== expectedSort) throw new InvalidCursorError();
  if (typeof cursor.id !== 'string' || cursor.id.length === 0) {
    throw new InvalidCursorError();
  }

  const kind = valueKindFor(expectedSort);
  const v = cursor.v;
  if (kind === 'number') {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new InvalidCursorError();
    }
  } else if (typeof v !== 'string') {
    throw new InvalidCursorError();
  }

  return { s: expectedSort, v: v as string | number, id: cursor.id };
}

// ── Filters ───────────────────────────────────────────────────────────────────

export interface TicketFilters {
  tenantId: string;
  statuses?: TicketStatus[];
  priorities?: TicketPriority[];
  owner?: { kind: 'id'; id: string } | { kind: 'unassigned' };
  agentDelegated?: boolean;
  q?: string;
  labelIds?: string[];
  labelNames?: string[];
  sort: { key: SortKey; column: string; ascending: false };
  cursor?: { s: SortKey; v: string | number; id: string };
  limit: number;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function buildTicketFilters(
  params: TicketListParams,
  ctx: { tenantId: string; userId: string }
): TicketFilters {
  let statuses: TicketStatus[] | undefined;

  if (params.categories?.length) {
    const expanded = new Set<TicketStatus>();
    for (const category of params.categories) {
      for (const status of CATEGORY_STATUSES[category]) expanded.add(status);
    }
    statuses = params.statuses?.length
      ? unique(params.statuses.filter((status) => expanded.has(status)))
      : Array.from(expanded);
  } else if (params.statuses?.length) {
    statuses = unique(params.statuses);
  }

  let owner: TicketFilters['owner'];
  if (params.owner === 'me') {
    owner = { kind: 'id', id: ctx.userId };
  } else if (params.owner === 'unassigned') {
    owner = { kind: 'unassigned' };
  } else if (params.owner) {
    owner = { kind: 'id', id: params.owner };
  }

  let labelIds: string[] | undefined;
  let labelNames: string[] | undefined;
  if (params.labels?.length) {
    labelIds = unique(params.labels.filter((value) => UUID_RE.test(value)));
    labelNames = unique(
      params.labels.filter((value) => !UUID_RE.test(value))
    );
  }

  const sortKey = params.sort;
  const filters: TicketFilters = {
    tenantId: ctx.tenantId,
    ...(statuses ? { statuses } : {}),
    ...(params.priorities?.length
      ? { priorities: unique(params.priorities) }
      : {}),
    ...(owner ? { owner } : {}),
    ...(params.agent !== undefined ? { agentDelegated: params.agent } : {}),
    ...(params.q !== undefined ? { q: params.q } : {}),
    ...(labelIds ? { labelIds } : {}),
    ...(labelNames ? { labelNames } : {}),
    sort: {
      key: sortKey,
      column: SORT_COLUMNS[sortKey],
      ascending: false,
    },
    ...(params.cursor
      ? { cursor: decodeCursor(params.cursor, sortKey) }
      : {}),
    limit: params.limit,
  };

  return filters;
}

// ── PostgREST filter serialisation ────────────────────────────────────────────

/** Escape LIKE metacharacters so user input is matched literally. */
function escapeLike(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

/** Double-quote a filter value so PostgREST treats commas/parens/etc literally. */
function quoteValue(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function escapeSearchTerm(term: string): string {
  return quoteValue(`%${escapeLike(term)}%`);
}

export function buildSearchOr(term: string): string {
  const pattern = escapeSearchTerm(term);
  return [
    `subject.ilike.${pattern}`,
    `body.ilike.${pattern}`,
    `title.ilike.${pattern}`,
  ].join(',');
}

export function buildKeysetOr(
  column: string,
  value: string | number,
  id: string
): string {
  const quotedValue = quoteValue(String(value));
  const quotedId = quoteValue(id);
  return [
    `${column}.lt.${quotedValue}`,
    `and(${column}.eq.${quotedValue},id.lt.${quotedId})`,
  ].join(',');
}

// ── Keys / loaders ────────────────────────────────────────────────────────────

export function parseTicketKey(
  key: string
): { prefix: string; number: number } | null {
  const match = /^([a-z]{2,6})-(\d+)$/i.exec(key.trim());
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { prefix: match[1].toUpperCase(), number };
}

export async function getTenantTicketPrefix(
  tenantId: string,
  client: SupabaseClient<any> = supabase
): Promise<string | null> {
  const { data, error } = await client
    .from('tenants')
    .select('ticket_prefix')
    .eq('id', tenantId)
    .maybeSingle();

  if (error) throw error;
  return data?.ticket_prefix ?? null;
}

export interface TicketDetail {
  ticket: Record<string, any>;
  messages: Record<string, any>[];
  outboundMessages: Record<string, any>[];
}

export async function loadTicketDetail(
  tenantId: string,
  lookup: { id?: string; number?: number },
  client: SupabaseClient<any> = supabase
): Promise<TicketDetail | null> {
  let query = client.from('tickets').select('*').eq('tenant_id', tenantId);
  if (lookup.id !== undefined) {
    query = query.eq('id', lookup.id);
  } else if (lookup.number !== undefined) {
    query = query.eq('number', lookup.number);
  } else {
    return null;
  }

  const { data: ticket, error } = await query.maybeSingle();
  if (error) throw error;
  if (!ticket) return null;

  const [messagesResult, outboundResult] = await Promise.all([
    client
      .from('messages')
      .select('id, direction, content, sender_name, created_at')
      .eq('ticket_id', ticket.id)
      .order('created_at', { ascending: true }),
    client
      .from('outbound_messages')
      .select('id, to_email, from_email, subject, body_text, status, created_at')
      .eq('ticket_id', ticket.id)
      .order('created_at', { ascending: true }),
  ]);

  if (messagesResult.error) throw messagesResult.error;
  if (outboundResult.error) throw outboundResult.error;

  return {
    ticket,
    messages: messagesResult.data ?? [],
    outboundMessages: outboundResult.data ?? [],
  };
}

// ── List executor ─────────────────────────────────────────────────────────────

export interface TicketLabel {
  id: string;
  name: string;
  color: string;
}

export interface TicketListItem {
  id: string;
  number: number | null;
  key: string | null;
  title: string | null;
  subject: string | null;
  status: TicketStatus;
  priority: TicketPriority;
  owner_id: string | null;
  agent_delegated: boolean;
  contact_email: string | null;
  contact_name: string | null;
  triage_type: string | null;
  created_at: string;
  updated_at: string;
  snoozed_until: string | null;
  accepted_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  labels: TicketLabel[];
  owner: { id: string; email: string | null } | null;
  counts: { messages: number };
}

export interface TicketListResult {
  tickets: TicketListItem[];
  nextCursor: string | null;
}

const TICKET_SELECT =
  'id, number, title, subject, status, priority, owner_id, agent_delegated, ' +
  'contact_email, contact_name, triage_type, created_at, updated_at, ' +
  'snoozed_until, accepted_at, resolved_at, closed_at, messages(count)';

async function resolveLabelTicketIds(
  filters: TicketFilters,
  client: SupabaseClient<any>
): Promise<string[] | null> {
  const wantsLabels =
    (filters.labelIds?.length ?? 0) > 0 || (filters.labelNames?.length ?? 0) > 0;
  if (!wantsLabels) return null;

  const labelIds = new Set(filters.labelIds ?? []);
  const names = (filters.labelNames ?? []).map((name) => name.toLowerCase());

  if (names.length > 0) {
    const { data, error } = await client
      .from('labels')
      .select('id, name')
      .eq('tenant_id', filters.tenantId);
    if (error) throw error;
    for (const row of (data ?? []) as { id: string; name: string }[]) {
      if (names.includes(row.name.toLowerCase())) labelIds.add(row.id);
    }
  }

  if (labelIds.size === 0) return [];

  const { data, error } = await client
    .from('ticket_labels')
    .select('ticket_id')
    .in('label_id', Array.from(labelIds));
  if (error) throw error;

  return unique(
    ((data ?? []) as { ticket_id: string }[]).map((row) => row.ticket_id)
  );
}

async function loadLabelsForTickets(
  ticketIds: string[],
  client: SupabaseClient<any>
): Promise<Record<string, TicketLabel[]>> {
  const byTicket: Record<string, TicketLabel[]> = {};
  if (ticketIds.length === 0) return byTicket;

  const { data, error } = await client
    .from('ticket_labels')
    .select('ticket_id, labels (id, name, color)')
    .in('ticket_id', ticketIds);
  if (error) throw error;

  for (const row of (data ?? []) as {
    ticket_id: string;
    labels: TicketLabel | TicketLabel[] | null;
  }[]) {
    const label = Array.isArray(row.labels) ? row.labels[0] : row.labels;
    if (!label) continue;
    (byTicket[row.ticket_id] ??= []).push({
      id: label.id,
      name: label.name,
      color: label.color,
    });
  }

  for (const labels of Object.values(byTicket)) {
    labels.sort((a, b) => a.name.localeCompare(b.name));
  }
  return byTicket;
}

async function loadOwnerEmails(
  ownerIds: string[],
  client: SupabaseClient<any>
): Promise<Record<string, string | null>> {
  const emails: Record<string, string | null> = {};
  for (const id of unique(ownerIds)) {
    try {
      const { data, error } = await client.auth.admin.getUserById(id);
      emails[id] = error ? null : (data.user?.email ?? null);
    } catch {
      emails[id] = null;
    }
  }
  return emails;
}

export async function listTickets(
  filters: TicketFilters,
  client: SupabaseClient<any> = supabase
): Promise<TicketListResult> {
  const empty: TicketListResult = { tickets: [], nextCursor: null };

  if (filters.statuses && filters.statuses.length === 0) return empty;

  const labelTicketIds = await resolveLabelTicketIds(filters, client);
  if (labelTicketIds !== null && labelTicketIds.length === 0) return empty;

  let query = client
    .from('tickets')
    .select(TICKET_SELECT)
    .eq('tenant_id', filters.tenantId);

  if (filters.statuses) query = query.in('status', filters.statuses);
  if (filters.priorities) query = query.in('priority', filters.priorities);

  if (filters.owner) {
    query =
      filters.owner.kind === 'unassigned'
        ? query.is('owner_id', null)
        : query.eq('owner_id', filters.owner.id);
  }

  if (filters.agentDelegated !== undefined) {
    query = query.eq('agent_delegated', filters.agentDelegated);
  }

  if (filters.q) query = query.or(buildSearchOr(filters.q));
  if (labelTicketIds !== null) query = query.in('id', labelTicketIds);

  if (filters.cursor) {
    query = query.or(
      buildKeysetOr(filters.sort.column, filters.cursor.v, filters.cursor.id)
    );
  }

  query = query
    .order(filters.sort.column, { ascending: false })
    .order('id', { ascending: false })
    .limit(filters.limit + 1);

  const { data, error } = await query;
  if (error) throw error;

  const rows = (data ?? []) as any[];
  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;

  const [ticketPrefix, labelsByTicket, ownerEmails] = await Promise.all([
    getTenantTicketPrefix(filters.tenantId, client),
    loadLabelsForTickets(
      page.map((row) => row.id as string),
      client
    ),
    loadOwnerEmails(
      page
        .map((row) => row.owner_id as string | null)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
      client
    ),
  ]);

  const tickets: TicketListItem[] = page.map((row) => {
    const ownerId = (row.owner_id as string | null) ?? null;
    return {
      id: row.id as string,
      number: (row.number as number | null) ?? null,
      key:
        row.number != null && ticketPrefix
          ? `${ticketPrefix}-${row.number as number}`
          : null,
      title: (row.title as string | null) ?? null,
      subject: (row.subject as string | null) ?? null,
      status: row.status as TicketStatus,
      priority: row.priority as TicketPriority,
      owner_id: ownerId,
      agent_delegated: Boolean(row.agent_delegated),
      contact_email: (row.contact_email as string | null) ?? null,
      contact_name: (row.contact_name as string | null) ?? null,
      triage_type: (row.triage_type as string | null) ?? null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      snoozed_until: (row.snoozed_until as string | null) ?? null,
      accepted_at: (row.accepted_at as string | null) ?? null,
      resolved_at: (row.resolved_at as string | null) ?? null,
      closed_at: (row.closed_at as string | null) ?? null,
      labels: labelsByTicket[row.id as string] ?? [],
      owner: ownerId
        ? { id: ownerId, email: ownerEmails[ownerId] ?? null }
        : null,
      counts: { messages: Number(row.messages?.[0]?.count ?? 0) },
    };
  });

  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor(
          filters.sort.key,
          last[filters.sort.column] as string | number,
          last.id as string
        )
      : null;

  return { tickets, nextCursor };
}
