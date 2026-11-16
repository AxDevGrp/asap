// POST   /api/tickets/[id]/labels — add a label to a ticket (any member)
// DELETE /api/tickets/[id]/labels — remove a label from a ticket (any member)
//
// Body: { "labelId": "<uuid>" }. DELETE also accepts ?labelId=<uuid>.
// Both return the ticket's labels after the change.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantMember } from '@/lib/auth';
import { checkApiWriteLimit } from '@/lib/rate-limit';
import { supabase } from '@/lib/supabase';
import {
  addLabel,
  LabelNotFoundError,
  listTicketLabels,
  removeLabel,
} from '@/lib/tickets/labels';
import { TicketNotFoundError } from '@/lib/tickets/service';

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({ labelId: z.string().uuid() }).strict();

function rateLimited() {
  return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
}

async function getTicketTenantId(ticketId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('tickets')
    .select('tenant_id')
    .eq('id', ticketId)
    .maybeSingle();

  if (error) throw error;
  return data?.tenant_id ?? null;
}

async function mutate(
  ticketId: string,
  labelId: string,
  action: 'add' | 'remove'
): Promise<NextResponse> {
  let tenantId: string | null;
  try {
    tenantId = await getTicketTenantId(ticketId);
  } catch {
    return NextResponse.json({ error: 'Failed to load ticket' }, { status: 500 });
  }
  if (!tenantId) {
    return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
  }

  const member = await requireTenantMember(tenantId);
  if ('error' in member) return member.error;
  if (!checkApiWriteLimit(tenantId)) return rateLimited();

  const actor = { type: 'user' as const, id: member.userId };

  try {
    if (action === 'add') {
      await addLabel(ticketId, labelId, actor, { tenantId });
    } else {
      await removeLabel(ticketId, labelId, actor, { tenantId });
    }
    return NextResponse.json(await listTicketLabels(ticketId));
  } catch (err) {
    if (err instanceof TicketNotFoundError || err instanceof LabelNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid label', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  return mutate(id, parsed.data.labelId, 'add');
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { id } = await params;

  const queryLabelId = new URL(request.url).searchParams.get('labelId');
  let raw: unknown = queryLabelId ? { labelId: queryLabelId } : null;

  if (!raw) {
    try {
      raw = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid label', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  return mutate(id, parsed.data.labelId, 'remove');
}
