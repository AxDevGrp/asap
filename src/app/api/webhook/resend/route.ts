import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { createSupabaseAdminClient } from '@/lib/supabase-server';
import { getTenantByDomain } from '@/lib/tenant';

// ── Svix webhook signature verification ─────────────────────────────────────────
// Resend sends Svix-signed webhooks. We verify manually with Node crypto so
// we don't need to add the svix package (keeps dependencies unchanged).

function verifySvixSignature(
  payload: string,
  secret: string,
  id: string,
  timestamp: string,
  signatureHeader: string
): boolean {
  const signedContent = `${id}.${timestamp}.${payload}`;
  const expectedSig = createHmac('sha256', secret)
    .update(signedContent)
    .digest('base64');

  const signatures = signatureHeader
    .split(' ')
    .filter((s) => s.startsWith('v1='))
    .map((s) => s.slice(3));

  if (signatures.length === 0) return false;

  const expectedBuf = Buffer.from(expectedSig, 'base64');
  for (const sig of signatures) {
    try {
      const sigBuf = Buffer.from(sig, 'base64');
      if (
        sigBuf.length === expectedBuf.length &&
        timingSafeEqual(sigBuf, expectedBuf)
      ) {
        return true;
      }
    } catch {
      // ignore invalid base64
    }
  }
  return false;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1].trim() : from.trim();
}

function extractDomain(email: string): string | null {
  const parts = email.split('@');
  return parts.length === 2 ? parts[1].toLowerCase() : null;
}

function normalizeTo(dataTo: unknown): string {
  if (typeof dataTo === 'string') return dataTo;
  if (Array.isArray(dataTo) && dataTo.length > 0) {
    return typeof dataTo[0] === 'string' ? dataTo[0] : '';
  }
  return '';
}

// ── POST /api/webhook/resend ───────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const secret = process.env.RESEND_WEBHOOK_SECRET;

    // 1. Verify Svix webhook signature (skipped in dev if secret is unset)
    if (secret) {
      const id = request.headers.get('svix-id') ?? '';
      const timestamp = request.headers.get('svix-timestamp') ?? '';
      const signature = request.headers.get('svix-signature') ?? '';

      if (!id || !timestamp || !signature) {
        return NextResponse.json(
          { error: 'Missing webhook headers' },
          { status: 401 }
        );
      }

      if (!verifySvixSignature(rawBody, secret, id, timestamp, signature)) {
        return NextResponse.json(
          { error: 'Invalid webhook signature' },
          { status: 401 }
        );
      }
    }

    // 2. Parse payload
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON payload' },
        { status: 400 }
      );
    }

    const event = payload as {
      type?: string;
      data?: Record<string, unknown>;
    };

    const data = event.data ?? {};

    // Extract email fields (defensively)
    const fromRaw = typeof data.from === 'string' ? data.from : '';
    const toRaw = normalizeTo(data.to);
    const subject =
      typeof data.subject === 'string' ? data.subject : '(no subject)';
    const text = typeof data.text === 'string' ? data.text : '';

    const contactEmail = extractEmail(fromRaw);
    const toEmail = extractEmail(toRaw);
    const domain = extractDomain(toEmail);

    // 3. Resolve tenant by recipient domain
    let tenantId: string | null = null;
    if (domain) {
      const tenant = await getTenantByDomain(domain);
      if (tenant) {
        tenantId = tenant.id;
      }
    }

    // 4. Create ticket
    const admin = createSupabaseAdminClient();

    const { data: ticket, error } = await admin
      .from('tickets')
      .insert({
        tenant_id: tenantId,
        contact_name: null,
        contact_email: contactEmail,
        subject,
        body: text,
        triage_type: null,
        triage_urgency: null,
        triage_summary: null,
        status: 'open',
        auto_resolved: false,
        auto_reply_sent: false,
      })
      .select()
      .single();

    if (error || !ticket) {
      console.error('[Resend Webhook] create ticket error:', error);
      return NextResponse.json(
        { error: error?.message ?? 'Failed to create ticket' },
        { status: 500 }
      );
    }

    return NextResponse.json({ ticket }, { status: 200 });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Internal server error';
    console.error('[Resend Webhook] unexpected error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
