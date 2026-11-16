// GET   /api/tickets/[id] — fetch ticket + messages + outbound messages
// PATCH /api/tickets/[id] — status / priority / owner / title updates

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkApiReadLimit, checkApiWriteLimit } from '@/lib/rate-limit';
import { supabase } from '@/lib/supabase';
import {
  ConcurrentUpdateError,
  InvalidTransitionError,
  setOwner,
  setPriority,
  TicketNotFoundError,
  transitionTicket,
} from '@/lib/tickets/service';
import {
  loadTicketDetail,
  resolveCallerTenant,
  TICKET_PRIORITIES,
} from '@/lib/tickets/query';
import { TICKET_STATUSES } from '@/lib/tickets/status';

type Params = { params: { id: string } };

const patchSchema = z
  .object({
    status: z.enum(TICKET_STATUSES).optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    owner_id: z.string().uuid().nullable().optional(),
    title: z.string().min(1).max(300).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required',
  });

function rateLimited() {
  return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
}

export async function GET(request: NextRequest, { params }: Params) {
  const tenant = await resolveCallerTenant(request);
  if ('error' in tenant) return tenant.error;

  if (!checkApiReadLimit(tenant.tenantId)) return rateLimited();

  const detail = await loadTicketDetail(tenant.tenantId, { id: params.id });
  if (!detail) {
    return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
  }

  return NextResponse.json(detail);
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const tenant = await resolveCallerTenant(request);
  if ('error' in tenant) return tenant.error;

  if (!checkApiWriteLimit(tenant.tenantId)) return rateLimited();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid ticket update', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const patch = parsed.data;
  const ticketId = params.id;

  const { data: current, error: loadError } = await supabase
    .from('tickets')
    .select('id')
    .eq('id', ticketId)
    .eq('tenant_id', tenant.tenantId)
    .maybeSingle();

  if (loadError) {
    return NextResponse.json({ error: 'Failed to load ticket' }, { status: 500 });
  }
  if (!current) {
    return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
  }

  if (patch.owner_id) {
    const { data: membership, error: membershipError } = await supabase
      .from('tenant_memberships')
      .select('user_id')
      .eq('user_id', patch.owner_id)
      .eq('tenant_id', tenant.tenantId)
      .maybeSingle();

    if (membershipError) {
      return NextResponse.json(
        { error: 'Failed to verify owner' },
        { status: 500 }
      );
    }
    if (!membership) {
      return NextResponse.json(
        { error: 'owner_id must be a member of this workspace' },
        { status: 400 }
      );
    }
  }

  const actor = { type: 'user' as const, id: tenant.userId };

  try {
    // Status first, as required by the transition rules.
    if (patch.status !== undefined) {
      await transitionTicket(ticketId, patch.status, actor, {
        tenantId: tenant.tenantId,
      });
    }

    if (patch.priority !== undefined) {
      await setPriority(ticketId, patch.priority, actor, {
        tenantId: tenant.tenantId,
      });
    }

    if (patch.owner_id !== undefined) {
      await setOwner(ticketId, patch.owner_id, actor, {
        tenantId: tenant.tenantId,
      });
    }

    if (patch.title !== undefined) {
      // There is no ticket_events kind for title changes, so this is a direct
      // tenant-scoped update. updated_at is maintained by the DB trigger.
      const { error } = await supabase
        .from('tickets')
        .update({ title: patch.title })
        .eq('id', ticketId)
        .eq('tenant_id', tenant.tenantId);

      if (error) throw error;
    }
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      return NextResponse.json(
        { error: err.message, from: err.from, to: err.to },
        { status: 409 }
      );
    }
    if (err instanceof TicketNotFoundError) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }
    if (err instanceof ConcurrentUpdateError) {
      return NextResponse.json(
        { error: 'Ticket was modified concurrently' },
        { status: 409 }
      );
    }
    throw err;
  }

  const { data: ticket, error: reloadError } = await supabase
    .from('tickets')
    .select('*')
    .eq('id', ticketId)
    .eq('tenant_id', tenant.tenantId)
    .single();

  if (reloadError || !ticket) {
    return NextResponse.json({ error: 'Failed to reload ticket' }, { status: 500 });
  }

  return NextResponse.json({ ticket });
}
