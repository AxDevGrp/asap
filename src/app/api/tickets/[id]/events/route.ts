// GET /api/tickets/[id]/events — ticket timeline, oldest first.

import { NextRequest, NextResponse } from 'next/server';
import { checkApiReadLimit } from '@/lib/rate-limit';
import { supabase } from '@/lib/supabase';
import { resolveCallerTenant } from '@/lib/tickets/query';

type Params = { params: { id: string } };

export async function GET(request: NextRequest, { params }: Params) {
  const tenant = await resolveCallerTenant(request);
  if ('error' in tenant) return tenant.error;

  if (!checkApiReadLimit(tenant.tenantId)) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const { data: ticket, error: ticketError } = await supabase
    .from('tickets')
    .select('id')
    .eq('id', params.id)
    .eq('tenant_id', tenant.tenantId)
    .maybeSingle();

  if (ticketError) {
    return NextResponse.json(
      { error: 'Failed to load ticket' },
      { status: 500 }
    );
  }
  if (!ticket) {
    return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
  }

  const { data: events, error: eventsError } = await supabase
    .from('ticket_events')
    .select('*')
    .eq('tenant_id', tenant.tenantId)
    .eq('ticket_id', params.id)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  if (eventsError) {
    return NextResponse.json(
      { error: 'Failed to load events' },
      { status: 500 }
    );
  }

  return NextResponse.json({ events: events ?? [] });
}
