// POST /api/send — send an outbound reply email to a customer via Resend
//
// This endpoint sends a reply on behalf of a tenant using their custom domain.
// Signed-in tenant members only; the reply must belong to one of the tenant's
// tickets and go to that ticket's contact (so it can't be used to send arbitrary mail).
// It logs the send attempt to outbound_messages for delivery tracking.
//
// Request body:
// {
//   tenantId: string           — UUID of the tenant
//   to: string                 — recipient email
//   subject: string            — email subject
//   text: string               — plain-text body
//   html?: string              — optional HTML body
//   ticketId: string           — the tenant's ticket being replied to (required)
//   inReplyTo?: string         — Message-ID to thread into (RFC 2822)
//   references?: string        — References header for threading
// }

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getTenantById } from '@/lib/tenant';
import { sendEmail } from '@/lib/resend';
import { createOutboundMessage } from '@/lib/db';
import { requireTenantMember } from '@/lib/auth';
import { checkApiWriteLimit } from '@/lib/rate-limit';

function getServiceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

// Lazily created so module load doesn't throw when env vars are absent at build time
let _supabase: ReturnType<typeof getServiceSupabase> | null = null;
function getDb() {
  if (!_supabase) _supabase = getServiceSupabase();
  return _supabase;
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const {
    tenantId,
    to,
    subject,
    text,
    html,
    ticketId,
    inReplyTo,
    references,
  } = body as {
    tenantId?: string;
    to?: string;
    subject?: string;
    text?: string;
    html?: string;
    ticketId?: string;
    inReplyTo?: string;
    references?: string;
  };

  // ── Validate required fields ─────────────────────────────────────────────
  if (!tenantId || !to || !subject || !text || !ticketId) {
    return NextResponse.json(
      { error: 'tenantId, ticketId, to, subject, and text are required' },
      { status: 400 }
    );
  }

  // ── Auth: signed-in member of this tenant ───────────────────────────────
  const member = await requireTenantMember(tenantId);
  if ('error' in member) return member.error;
  if (!checkApiWriteLimit(tenantId)) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  // ── The ticket must be this tenant's, and we only reply to its contact ──
  const { data: ticket, error: ticketError } = await getDb()
    .from('tickets')
    .select('id, tenant_id, contact_email')
    .eq('id', ticketId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (ticketError || !ticket) {
    return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
  }
  if (!ticket.contact_email || ticket.contact_email.toLowerCase() !== to.trim().toLowerCase()) {
    return NextResponse.json(
      { error: "Replies can only be sent to the ticket's contact" },
      { status: 400 }
    );
  }

  // ── Resolve tenant ───────────────────────────────────────────────────────
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  const fromEmail = `support@${tenant.domain}`;

  // ── Build threading headers ──────────────────────────────────────────────
  const headers: Record<string, string> = {};
  if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
  if (references) headers['References'] = references;

  // ── Log the send attempt (pending) ──────────────────────────────────────
  const outboundRecord = await createOutboundMessage({
    tenant_id: tenantId,
    ticket_id: ticketId,
    to_email: to,
    from_email: fromEmail,
    subject,
    body_text: text,
    body_html: html ?? null,
    status: 'pending',
  });

  // ── Send via Resend ──────────────────────────────────────────────────────
  const result = await sendEmail({
    tenantDomain: tenant.domain,
    fromName: tenant.name,
    to,
    subject,
    text,
    html,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    tags: [
      { name: 'tenant_id', value: tenantId },
      { name: 'product', value: tenant.slug },
    ],
  });

  if (!result.success) {
    // Update DB record to 'failed'
    if (outboundRecord) {
      await getDb()
        .from('outbound_messages')
        .update({ status: 'failed', error_message: result.error })
        .eq('id', outboundRecord.id);
    }

    console.error(`[Send] Failed to send email to ${to} for tenant ${tenant.slug}:`, result.error);
    return NextResponse.json(
      { error: 'Email send failed', details: result.error },
      { status: 502 }
    );
  }

  // ── Update DB with Resend message ID ────────────────────────────────────
  if (outboundRecord) {
    await getDb()
      .from('outbound_messages')
      .update({
        resend_message_id: result.id,
        status: 'sent',
        updated_at: new Date().toISOString(),
      })
      .eq('id', outboundRecord.id);
  }

  console.log(`[Send] Email sent — resend_id=${result.id} tenant=${tenant.slug} to=${to}`);

  return NextResponse.json({
    success: true,
    resendMessageId: result.id,
    outboundMessageId: outboundRecord?.id ?? null,
    from: fromEmail,
    to,
    subject,
  });
}
