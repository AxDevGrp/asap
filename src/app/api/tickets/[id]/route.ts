// GET  /api/tickets/[id]  — fetch ticket + messages + outbound messages
// PATCH /api/tickets/[id] — update ticket status or assign (agent actions)

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase-server';

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// ── Auth helper ────────────────────────────────────────────────────────────────

async function getAuthedTenantId(): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from('tenant_memberships')
    .select('tenant_id')
    .eq('user_id', user.id)
    .limit(1)
    .single();

  return data?.tenant_id ?? null;
}

// ── GET ────────────────────────────────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const tenantId = await getAuthedTenantId();
  if (!tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getServiceClient();
  const ticketId = params.id;

  // Fetch ticket
  const { data: ticket, error: ticketError } = await db
    .from('tickets')
    .select('*')
    .eq('id', ticketId)
    .eq('tenant_id', tenantId)
    .single();

  if (ticketError || !ticket) {
    return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
  }

  // Fetch messages (conversation thread)
  const { data: messages } = await db
    .from('messages')
    .select('id, direction, content, sender_name, created_at')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true });

  // Fetch outbound messages (sent via Resend)
  const { data: outboundMessages } = await db
    .from('outbound_messages')
    .select('id, to_email, from_email, subject, body_text, status, created_at')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true });

  return NextResponse.json({
    ticket,
    messages: messages ?? [],
    outboundMessages: outboundMessages ?? [],
  });
}

// ── PATCH ──────────────────────────────────────────────────────────────────────

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const tenantId = await getAuthedTenantId();
  if (!tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Only allow safe status updates from the agent interface
  const allowedFields = ['status', 'assigned_to'];
  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (field in body) updates[field] = body[field];
  }

  const validStatuses = ['open', 'resolved', 'pending'];
  if (updates.status && !validStatuses.includes(updates.status as string)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
  }

  const db = getServiceClient();
  const { data: ticket, error } = await db
    .from('tickets')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', params.id)
    .eq('tenant_id', tenantId)
    .select('*')
    .single();

  if (error || !ticket) {
    return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  }

  return NextResponse.json({ ticket });
}
