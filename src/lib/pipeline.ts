// Channel-agnostic AI pipeline: triage -> KB search -> draft reply -> auto-resolve decision.
// Inbound email (Resend webhook) calls this; nothing here knows about any inbox provider.

import { triageTicket } from '@/lib/gemini';
import {
  updateTicket,
  getMessagesByTicketId,
  createResolveAudit,
  createOutboundMessage,
  reserveOutboundMessage,
  getOutboundMessageByIdempotencyKey,
  updateOutboundMessage,
  createMessage,
  urgencyToPriority,
} from '@/lib/db';
import type { Tenant } from '@/lib/tenant';
import { searchKB, generateRagReply, generateFollowUpReply, KBArticle } from '@/lib/rag';
import { shouldAutoResolve } from '@/lib/auto-resolve';
import { getTenantPolicy } from '@/lib/policies';
import { sendEmail } from '@/lib/resend';
import { TriageResult } from '@/types/triage';

export interface ProcessInboundEmailInput {
  tenant: Tenant;
  ticketId: string;
  conversationId: string;
  contactEmail: string;
  contactName?: string | null;
  subject: string;
  body: string;
  isFollowUp?: boolean;
  /** Dedupe key for auto-sends; a retried job reuses its key so it can't send twice. */
  idempotencyKey?: string;
}

export interface ProcessInboundEmailResult {
  draft: string | null;
  autoSent: boolean;
  reason: string;
  triage: Partial<TriageResult> | null;
  kbHits: number;
  topKbSimilarity: number | null;
}

export async function processInboundEmail(
  input: ProcessInboundEmailInput
): Promise<ProcessInboundEmailResult> {
  const { tenant, ticketId, contactEmail, contactName, subject, body, isFollowUp, idempotencyKey } =
    input;
  const slug = tenant.slug || 'unknown';
  const tenantName = tenant.name;

  // Load the tenant's policy once; it drives both the decision and the audit version.
  const policy = await getTenantPolicy(tenant.id);

  // 1. Triage (new tickets only — follow-ups reuse existing triage)
  let triage: Partial<TriageResult> | null = null;
  if (!isFollowUp) {
    try {
      triage = await triageTicket(body, subject, tenantName, {
        name: tenant.name,
        domain: tenant.domain,
        tone: (tenant.settings?.ai_tone ?? tenant.settings?.tone) as string | undefined,
        brandContext: tenant.settings?.brandContext as string | undefined,
      });
      await updateTicket(ticketId, {
        triage_type: triage.type,
        triage_urgency: triage.urgency,
        triage_summary: triage.summary,
        triage_confidence: triage.confidence,
        priority: urgencyToPriority(triage.urgency),
      });
    } catch (err) {
      console.error('[Pipeline] Triage failed:', err);
    }
  }

  // 2. KB search (tenant-scoped) + draft reply
  let replyText = '';
  let kbArticles: KBArticle[] = [];
  try {
    // 0.6 cutoff: with gemini-embedding-2, real matches score ~0.7+, unrelated text ~0.5.
    kbArticles = await searchKB(body, slug, 3, 0.6, tenant.id);
    if (isFollowUp) {
      const allMessages = await getMessagesByTicketId(ticketId);
      const history = allMessages
        .map(
          (m: { direction: string; content: string; sender_name: string | null }) =>
            `[${m.direction === 'incoming' ? 'Customer' : 'Support'}]: ${m.content}`
        )
        .join('\n');
      replyText = await generateFollowUpReply(body, history, kbArticles, tenantName, contactName);
    } else {
      replyText = await generateRagReply(body, kbArticles, triage ?? {}, tenantName, contactName);
    }
  } catch (err) {
    console.error('[Pipeline] KB/draft generation failed:', err);
    replyText =
      triage?.suggested_reply ??
      `Hi ${contactName ?? 'there'}, thanks for reaching out to ${tenantName} support! We've received your message and will get back to you shortly.`;
  }

  const kbHits = kbArticles.length;
  const topKbSimilarity = kbHits > 0 ? kbArticles[0].similarity : null;

  // 3. Auto-resolve decision. Follow-ups NEVER auto-send. autoSendEnabled is
  // enforced inside shouldAutoResolve (the policy is the single switch).
  const { autoSend: policyAutoSend, reason } = shouldAutoResolve(
    policy,
    { confidence: triage?.confidence, type: triage?.type, urgency: triage?.urgency },
    kbHits,
    topKbSimilarity
  );
  const autoSend = !isFollowUp && policyAutoSend;

  if (!autoSend) {
    // Store the draft on the ticket. The dashboard pre-fills from auto_reply_text.
    await updateTicket(ticketId, {
      auto_reply_sent: false,
      auto_reply_text: replyText,
      auto_resolved: false,
      resolve_reason: isFollowUp ? 'follow-up drafts are never auto-sent' : reason,
    });
  } else {
    // Idempotency: a retried job (same key) must not send a second email.
    if (idempotencyKey) {
      const existing = await getOutboundMessageByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.status === 'failed') {
          // A previous attempt reserved but failed to send. Do NOT claim it was
          // sent — keep the reply as a draft for a human to review.
          await updateTicket(ticketId, {
            auto_reply_sent: false,
            auto_reply_text: replyText,
            auto_resolved: false,
            resolve_reason: 'auto-send previously failed; kept as draft',
          });
          await createResolveAudit({
            ticket_id: ticketId,
            product: slug,
            tenant_id: tenant.id,
            auto_send: false,
            reason: 'auto-send previously failed; kept as draft',
            triage_confidence: triage?.confidence ?? null,
            triage_type: triage?.type ?? null,
            triage_urgency: triage?.urgency ?? null,
            kb_hits: kbHits,
            top_kb_similarity: topKbSimilarity,
            policy_version: policy.version,
          });
          return {
            draft: replyText || null,
            autoSent: false,
            reason: 'auto-send previously failed; kept as draft',
            triage,
            kbHits,
            topKbSimilarity,
          };
        }
        await updateTicket(ticketId, {
          auto_reply_sent: true,
          auto_reply_text: replyText,
          auto_resolved: policy.resolveOnAutoSend,
          resolve_reason: `${reason} (already sent)`,
          status: policy.resolveOnAutoSend ? 'resolved' : 'todo',
        });
        return {
          draft: replyText || null,
          autoSent: true,
          reason,
          triage,
          kbHits,
          topKbSimilarity,
        };
      }
    }

    // Reserve the send BEFORE calling Resend so a crash/retry can't duplicate it.
    // A thrown error propagates so the job retries; nothing was sent yet.
    const { row: outbound, conflict } = await reserveOutboundMessage({
      tenant_id: tenant.id,
      ticket_id: ticketId,
      to_email: contactEmail,
      from_email: `support@${tenant.domain}`,
      subject: `Re: ${subject}`,
      body_text: replyText,
      status: 'pending',
      idempotency_key: idempotencyKey ?? null,
    });

    if (idempotencyKey && conflict) {
      // Another attempt already reserved this key (unique violation) — treat as sent.
      console.warn('[Pipeline] idempotency key already reserved, skipping send:', idempotencyKey);
      await updateTicket(ticketId, {
        auto_reply_sent: true,
        auto_reply_text: replyText,
        auto_resolved: policy.resolveOnAutoSend,
        resolve_reason: `${reason} (already sent)`,
        status: policy.resolveOnAutoSend ? 'resolved' : 'todo',
      });
    } else {
      const sent = await sendEmail({
        tenantDomain: tenant.domain,
        fromName: tenantName,
        to: contactEmail,
        subject: `Re: ${subject}`,
        text: replyText,
      });

      if (sent.success) {
        if (outbound) {
          await updateOutboundMessage(outbound.id, {
            status: 'sent',
            resend_message_id: sent.id,
          });
        } else {
          await createOutboundMessage({
            tenant_id: tenant.id,
            ticket_id: ticketId,
            resend_message_id: sent.id,
            to_email: contactEmail,
            from_email: `support@${tenant.domain}`,
            subject: `Re: ${subject}`,
            body_text: replyText,
            status: 'sent',
          });
        }
        await createMessage({
          ticket_id: ticketId,
          direction: 'outgoing',
          content: replyText,
          sender_name: tenantName,
          tenant_id: tenant.id,
        });
        await updateTicket(ticketId, {
          auto_reply_sent: true,
          auto_reply_text: replyText,
          auto_resolved: policy.resolveOnAutoSend,
          resolve_reason: reason,
          status: policy.resolveOnAutoSend ? 'resolved' : 'todo',
        });
      } else {
        console.error('[Pipeline] Auto-send failed, keeping as draft:', sent.error);
        if (outbound) {
          await updateOutboundMessage(outbound.id, {
            status: 'failed',
            error_message: sent.error ?? 'send failed',
          });
        }
        await updateTicket(ticketId, {
          auto_reply_sent: false,
          auto_reply_text: replyText,
          auto_resolved: false,
          resolve_reason: `auto-send failed: ${sent.error}`,
        });
      }
    }
  }

  // 4. Audit log for the decision.
  await createResolveAudit({
    ticket_id: ticketId,
    product: slug,
    tenant_id: tenant.id,
    auto_send: autoSend,
    reason,
    triage_confidence: triage?.confidence ?? null,
    triage_type: triage?.type ?? null,
    triage_urgency: triage?.urgency ?? null,
    kb_hits: kbHits,
    top_kb_similarity: topKbSimilarity,
    policy_version: policy.version,
  });

  return {
    draft: replyText || null,
    autoSent: autoSend,
    reason,
    triage,
    kbHits,
    topKbSimilarity,
  };
}
