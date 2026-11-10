import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { getTenantByDomain } from '@/lib/tenant';
import {
  findOrCreateConversation,
  createInboundMessage,
  getOpenTicketByConversationId,
  createTicket,
  updateTicket,
  createMessage,
  hasInboundMessage,
} from '@/lib/db';
import { enqueueJob, kickJobRunner, getJobByDedupeKey } from '@/lib/jobs';
import { JOB_TYPE_INBOUND_EMAIL_PROCESS } from '@/lib/job-handlers';
import { getReceivedEmail } from '@/lib/resend';
import { checkWebhookLimit } from '@/lib/rate-limit';

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

    // 2. Rate limit by client IP
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      request.headers.get('x-real-ip') ??
      'unknown';
    if (!checkWebhookLimit(ip)) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    // 3. Parse payload
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

    // Only handle inbound received email; ignore everything else with 200.
    if (event.type !== 'email.received') {
      return NextResponse.json(
        { status: 'ignored', reason: `unhandled event: ${event.type ?? 'none'}` },
        { status: 200 }
      );
    }

    const data = event.data ?? {};

    // Extract metadata (the webhook carries no body)
    const fromRaw = typeof data.from === 'string' ? data.from : '';
    const toRaw = normalizeTo(data.to);
    const subject =
      typeof data.subject === 'string' ? data.subject : '(no subject)';
    const emailId = typeof data.email_id === 'string' ? data.email_id : '';
    const messageId = typeof data.message_id === 'string' ? data.message_id : '';

    const contactEmail = extractEmail(fromRaw);
    const toEmail = extractEmail(toRaw);
    const domain = extractDomain(toEmail);

    if (!contactEmail) {
      return NextResponse.json(
        { status: 'ignored', reason: 'no sender address' },
        { status: 200 }
      );
    }

    // 4. Dedupe by the job's dedupe key. A job existing means this email was
    //    already ingested and queued — ignore the retry. We key on the job, not
    //    the inbound message, so a failed enqueue (500) still lets Resend retry.
    const dedupeKey = messageId || emailId ? `inbound_email:${messageId || emailId}` : '';

    if (dedupeKey) {
      const existingJob = await getJobByDedupeKey(dedupeKey);
      if (existingJob) {
        return NextResponse.json(
          { status: 'ignored', reason: 'duplicate message', job_id: existingJob.id },
          { status: 200 }
        );
      }
    }

    // Already ingested by an earlier attempt that failed before enqueueing?
    // Skip re-inserting the inbound message / ticket message to avoid dup rows.
    const alreadyIngested = messageId ? await hasInboundMessage(messageId) : false;

    // 5. Resolve tenant by recipient domain
    const tenant = domain ? await getTenantByDomain(domain) : null;
    if (!tenant) {
      console.warn(
        `[Resend Webhook] No tenant for recipient domain "${domain ?? 'unknown'}" (from ${contactEmail}) — dropping`
      );
      return NextResponse.json(
        { status: 'ignored', reason: `no tenant for domain ${domain ?? 'unknown'}` },
        { status: 200 }
      );
    }

    // 6. Fetch the email body (500 so Resend retries if it fails)
    const received = emailId ? await getReceivedEmail(emailId) : null;
    if (!received) {
      return NextResponse.json(
        { error: 'Failed to fetch received email body' },
        { status: 500 }
      );
    }
    const text = received.text;

    // 7. Thread into one conversation per contact/tenant, log inbound message
    const conversation = await findOrCreateConversation({
      tenant_id: tenant.id,
      customer_email: contactEmail,
      customer_name: null,
      subject,
    });

    if (!conversation) {
      return NextResponse.json(
        { error: 'Failed to create conversation' },
        { status: 500 }
      );
    }

    if (!alreadyIngested) {
      await createInboundMessage({
        conversation_id: conversation.id,
        tenant_id: tenant.id,
        from_email: contactEmail,
        subject,
        body_text: text,
        body_html: received.html,
        message_id: messageId || null,
      });
    }

    // 8. Reuse the conversation's open ticket as a follow-up, else create one
    const existingTicket = await getOpenTicketByConversationId(conversation.id);
    const isFollowUp = Boolean(existingTicket);

    let ticketId: string;
    if (existingTicket) {
      ticketId = existingTicket.id;
      if (existingTicket.status === 'resolved') {
        await updateTicket(ticketId, { status: 'open' });
      }
      if (!alreadyIngested) {
        await createMessage({
          ticket_id: ticketId,
          direction: 'incoming',
          content: text,
          sender_name: existingTicket.contact_name ?? null,
          tenant_id: tenant.id,
        });
      }
    } else {
      const ticket = await createTicket({
        tenant_id: tenant.id,
        conversation_id: conversation.id,
        contact_name: null,
        contact_email: contactEmail,
        subject,
        body: text,
        status: 'open',
        auto_resolved: false,
        auto_reply_sent: false,
      });
      if (!ticket) {
        return NextResponse.json(
          { error: 'Failed to create ticket' },
          { status: 500 }
        );
      }
      ticketId = ticket.id;
      if (!alreadyIngested) {
        await createMessage({
          ticket_id: ticketId,
          direction: 'incoming',
          content: text,
          sender_name: null,
          tenant_id: tenant.id,
        });
      }
    }

    // 9. Enqueue the AI pipeline as a durable background job and respond
    //    immediately. The runner drains the queue (and a scheduler is the
    //    backstop), so the webhook never waits on AI work or times out.
    let jobId: string;
    try {
      const job = await enqueueJob({
        type: JOB_TYPE_INBOUND_EMAIL_PROCESS,
        tenantId: tenant.id,
        payload: {
          tenantId: tenant.id,
          ticketId,
          conversationId: conversation.id,
          contactEmail,
          contactName: null,
          subject,
          body: text,
          isFollowUp,
        },
        dedupeKey: dedupeKey || null,
      });
      jobId = job.id;
    } catch (enqueueErr) {
      const message =
        enqueueErr instanceof Error ? enqueueErr.message : 'Failed to enqueue job';
      console.error('[Resend Webhook] enqueue failed:', message);
      return NextResponse.json({ error: message }, { status: 500 });
    }

    await kickJobRunner();

    return NextResponse.json(
      {
        status: 'queued',
        ticket_id: ticketId,
        conversation_id: conversation.id,
        is_follow_up: isFollowUp,
        job_id: jobId,
      },
      { status: 202 }
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Internal server error';
    console.error('[Resend Webhook] unexpected error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
