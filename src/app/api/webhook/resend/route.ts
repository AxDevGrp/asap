// POST /api/webhook/resend — Resend email delivery & inbound status webhook
//
// This handler manages:
// 1. INBOUND: Receiving new emails for tenants (the core of our engine).
// 2. OUTBOUND: Tracking delivery status (sent, delivered, bounced, etc.).
//
// Reference: https://resend.com/docs/dashboard/webhooks/event-types

import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import { 
  updateOutboundMessageByResendId, 
  findOrCreateConversation, 
  createInboundMessage 
} from '@/lib/db';
import { getTenantByDomain } from '@/lib/tenant';
import { checkWebhookLimit } from '@/lib/rate-limit';

// ── Signature verification ───────────────────────────────────────────────────

function verifyResendSignature(
  payload: string,
  svixId: string | null,
  svixTimestamp: string | null,
  svixSignature: string | null,
  secret: string
): boolean {
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const signedContent = `${svixId}.${svixTimestamp}.${payload}`;
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expectedSig = crypto
    .createHmac('sha256', secretBytes)
    .update(signedContent)
    .digest('base64');

  const signatures = svixSignature.split(' ');
  for (const sig of signatures) {
    const [version, value] = sig.split(',');
    if (version === 'v1' && value === expectedSig) return true;
  }

  return false;
}

// ── Status mapping ───────────────────────────────────────────────────────────

type OutboundStatus = 'pending' | 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed';

function resendEventToStatus(eventType: string): OutboundStatus | null {
  const map: Record<string, OutboundStatus> = {
    'email.sent': 'sent',
    'email.delivered': 'delivered',
    'email.delivery_delayed': 'pending',
    'email.bounced': 'bounced',
    'email.complained': 'complained',
  };
  return map[eventType] ?? null;
}

// ── Webhook handler ──────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkWebhookLimit(ip)) {
    console.warn(`[ResendWebhook] Rate limit exceeded for IP: ${ip}`);
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  const rawBody = await request.text();
  const svixId = request.headers.get('svix-id');
  const svixTimestamp = request.headers.get('svix-timestamp');
  const svixSignature = request.headers.get('svix-signature');

  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  if (webhookSecret) {
    const valid = verifyResendSignature(
      rawBody,
      svixId,
      svixTimestamp,
      svixSignature,
      webhookSecret
    );
    if (!valid) {
      console.warn('[ResendWebhook] Invalid signature — rejecting');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
  } else {
    console.warn('[ResendWebhook] No RESEND_WEBHOOK_SECRET set — skipping signature check (dev mode)');
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { type: eventType, data } = event;

  // 1. Handle INBOUND Emails (The "Core Engine" logic)
  if (eventType === 'inbound') {
    // Resend inbound payload: data.to is an array of recipients
    const toAddresses = data?.to || [];
    const targetDomain = toAddresses[0]?.split('@')[1];

    if (!targetDomain) {
      console.warn('[ResendWebhook] Inbound email missing target domain');
      return NextResponse.json({ error: 'Missing target domain' }, { status: 400 });
    }

    const tenant = await getTenantByDomain(targetDomain);
    if (!tenant) {
      console.warn(`[ResendWebhook] No tenant found for domain: ${targetDomain}`);
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    // Create or find the conversation for this customer
    const conversation = await findOrCreateConversation({
      tenant_id: tenant.id,
      customer_email: data.from,
      customer_name: data.from_name || null,
      subject: data.subject || '(No Subject)',
    });

    if (!conversation) {
      console.error('[ResendWebhook] Failed to create/find conversation');
      return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 });
    }

    // Log the actual message
    await createInboundMessage({
      conversation_id: conversation.id,
      tenant_id: tenant.id,
      from_email: data.from,
      subject: data.subject || '(No Subject)',
      body_text: data.text || '',
      body_html: data.html || null,
    });

    console.log(`[ResendWebhook] INBOUND processed: ${tenant.name} | ${data.from} -> ${targetDomain}`);
    return NextResponse.json({ received: true });
  }

  // 2. Handle OUTBOUND Status Updates (Legacy tracking)
  const resendMessageId = data?.email_id;
  if (!resendMessageId) {
    return NextResponse.json({ received: true });
  }

  const newStatus = resendEventToStatus(eventType);
  if (!newStatus) {
    console.log(`[ResendWebhook] Unhandled event type: ${eventType}`);
    return NextResponse.json({ received: true });
  }

  await updateOutboundMessageByResendId(resendMessageId, {
    status: newStatus,
    error_message:
      newStatus === 'bounced' || newStatus === 'complained'
        ? `${eventType} at ${new Date().toISOString()}`
        : null,
  });

  console.log(`[ResendWebhook] OUTBOUND status update: ${resendMessageId} → ${newStatus}`);
  return NextResponse.json({ received: true });
}
