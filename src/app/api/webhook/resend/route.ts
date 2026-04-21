// POST /api/webhook/resend — Resend email delivery status webhook
//
// Resend sends delivery events here. Configure in Resend dashboard under
// Webhooks → Add endpoint → URL: https://yourapp.com/api/webhook/resend
//
// Events handled:
//   email.sent          — Resend accepted the message
//   email.delivered     — Confirmed delivery to recipient MTA
//   email.delivery_delayed — Soft bounce / temporary failure
//   email.bounced       — Hard bounce
//   email.complained    — Spam complaint (recipient marked as spam)
//
// Reference: https://resend.com/docs/dashboard/webhooks/event-types

import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import { updateOutboundMessageByResendId } from '@/lib/db';
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

  // Resend uses Svix for webhooks
  // Signature format: v1,<base64-hmac-sha256>
  const signedContent = `${svixId}.${svixTimestamp}.${payload}`;

  // Secret comes in "whsec_<base64>" format
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expectedSig = crypto
    .createHmac('sha256', secretBytes)
    .update(signedContent)
    .digest('base64');

  // Svix signature header may contain multiple signatures: "v1,sig1 v1,sig2"
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
    'email.delivery_delayed': 'pending',   // still in-flight
    'email.bounced': 'bounced',
    'email.complained': 'complained',
  };
  return map[eventType] ?? null;
}

// ── Webhook handler ──────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // Rate limiting — guard against webhook floods
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkWebhookLimit(ip)) {
    console.warn(`[ResendWebhook] Rate limit exceeded for IP: ${ip}`);
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  const rawBody = await request.text();

  const svixId = request.headers.get('svix-id');
  const svixTimestamp = request.headers.get('svix-timestamp');
  const svixSignature = request.headers.get('svix-signature');

  // Signature verification (skip in dev if secret not set)
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

  let event: { type: string; data: { email_id?: string; object?: string } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { type: eventType, data } = event;
  const resendMessageId = data?.email_id;

  console.log(`[ResendWebhook] Event: ${eventType} — message_id: ${resendMessageId ?? 'unknown'}`);

  if (!resendMessageId) {
    // Non-email events (e.g. domain events) — acknowledge and ignore
    return NextResponse.json({ received: true });
  }

  const newStatus = resendEventToStatus(eventType);
  if (!newStatus) {
    console.log(`[ResendWebhook] Unhandled event type: ${eventType}`);
    return NextResponse.json({ received: true });
  }

  // Update delivery status in our DB
  await updateOutboundMessageByResendId(resendMessageId, {
    status: newStatus,
    error_message:
      newStatus === 'bounced' || newStatus === 'complained'
        ? `${eventType} at ${new Date().toISOString()}`
        : null,
  });

  console.log(`[ResendWebhook] Updated ${resendMessageId} → ${newStatus}`);

  return NextResponse.json({ received: true });
}
