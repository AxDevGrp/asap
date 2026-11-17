// Channel-agnostic AI pipeline: triage -> KB search -> draft reply -> auto-resolve decision.
// Inbound email (Resend webhook) calls this; nothing here knows about any inbox provider.

import type { SupabaseClient } from '@supabase/supabase-js';
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
  type TicketStatus,
} from '@/lib/db';
import { supabase } from '@/lib/supabase';
import { canTransition } from '@/lib/tickets/status';
import {
  InvalidTransitionError,
  transitionTicket,
  type Actor,
} from '@/lib/tickets/service';
import type { Tenant } from '@/lib/tenant';
import { searchKB, generateRagReply, generateFollowUpReply, KBArticle } from '@/lib/rag';
import { shouldAutoResolve } from '@/lib/auto-resolve';
import { getTenantPolicy } from '@/lib/policies';
import { listLabels } from '@/lib/tickets/labels';
import {
  decideTriage,
  priorityToUrgency,
  type TriageDecision,
  type TriageLabel,
} from '@/lib/triage/decide';
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

const SYSTEM_ACTOR: Actor = { type: 'system' };

async function currentTicketStatus(
  client: SupabaseClient<any>,
  ticketId: string
): Promise<TicketStatus | null> {
  const { data, error } = await client
    .from('tickets')
    .select('status')
    .eq('id', ticketId)
    .maybeSingle();
  if (error) throw error;
  return ((data as { status?: TicketStatus } | null)?.status ?? null);
}

async function safeTransition(
  client: SupabaseClient<any>,
  ticketId: string,
  from: TicketStatus,
  to: TicketStatus
): Promise<void> {
  if (!canTransition(from, to)) return;
  try {
    await transitionTicket(ticketId, to, SYSTEM_ACTOR, { client });
  } catch (err) {
    // Retries may race another writer; an illegal transition is not fatal.
    if (err instanceof InvalidTransitionError) return;
    throw err;
  }
}

/**
 * Move a ticket after a successful auto-send. Retry-safe: a ticket already in
 * the target state is left alone instead of throwing.
 *
 * resolveOnAutoSend → resolved.
 * otherwise → triage becomes todo then waiting_on_customer; todo/in_progress
 * becomes waiting_on_customer; anything else (already waiting, closed) is left.
 */
export async function applyAutoSendStatus(
  ticketId: string,
  resolveOnAutoSend: boolean,
  client: SupabaseClient<any> = supabase
): Promise<void> {
  const status = await currentTicketStatus(client, ticketId);
  if (!status) return;

  if (resolveOnAutoSend) {
    await safeTransition(client, ticketId, status, 'resolved');
    return;
  }

  if (status === 'triage') {
    await safeTransition(client, ticketId, status, 'todo');
    const after = await currentTicketStatus(client, ticketId);
    if (after === 'todo' || after === 'in_progress') {
      await safeTransition(client, ticketId, after, 'waiting_on_customer');
    }
    return;
  }

  if (status === 'todo' || status === 'in_progress') {
    await safeTransition(client, ticketId, status, 'waiting_on_customer');
  }
}

/**
 * Post-triage hook. This is a no-op seam: later milestones (triage rules, AI
 * agent delegation) plug their work in here.
 */
export async function afterTriage(_ticketId: string): Promise<void> {
  // intentionally empty
}

/**
 * Store decision suggestions on the ticket. They are recorded only — never
 * applied (no label added, no decline, no status change).
 */
function suggestionColumns(decision: TriageDecision): {
  ai_suggested_priority: TriageDecision['priority'];
  ai_suggested_type: string;
  ai_suggested_label_ids: string[];
  ai_spam_probability: number;
  ai_needs_human_probability: number;
} {
  return {
    ai_suggested_priority: decision.priority,
    ai_suggested_type: decision.type,
    ai_suggested_label_ids: decision.suggestedLabelIds,
    ai_spam_probability: decision.spamProbability,
    ai_needs_human_probability: decision.needsHumanProbability,
  };
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
  // In jev mode the decision supplies type/priority/urgency/confidence. This is
  // the effective triage used by the auto-resolve decision and audits.
  let decisionTriage: Partial<TriageResult> | null = null;

  if (!isFollowUp) {
    try {
      triage = await triageTicket(body, subject, tenantName, {
        name: tenant.name,
        domain: tenant.domain,
        tone: (tenant.settings?.ai_tone ?? tenant.settings?.tone) as string | undefined,
        brandContext: tenant.settings?.brandContext as string | undefined,
      });
    } catch (err) {
      console.error('[Pipeline] Triage failed:', err);
    }

    const gemmaFields = triage
      ? {
          triage_type: triage.type,
          triage_urgency: triage.urgency,
          triage_summary: triage.summary,
          triage_confidence: triage.confidence,
          priority: urgencyToPriority(triage.urgency),
        }
      : {};

    if (policy.decisionMode === 'llm') {
      if (triage) await updateTicket(ticketId, gemmaFields);
    } else {
      let tenantLabels: TriageLabel[] = [];
      try {
        tenantLabels = await listLabels(tenant.id);
      } catch (err) {
        console.error('[Pipeline] Failed to load tenant labels:', err);
      }

      const ticketInput = { subject, body, contactEmail };
      const decideOpts = {
        tenantId: tenant.id,
        ticketId,
        labelThreshold: policy.decisionThresholds.label_suggest,
      };

      if (policy.decisionMode === 'shadow') {
        // Gemma remains the source of the triage fields; both decisions run in
        // parallel so decision_log gets one JEV row and one LLM row.
        const [jev, llm] = await Promise.allSettled([
          decideTriage(ticketInput, tenantLabels, undefined, { ...decideOpts, engine: 'jev' }),
          decideTriage(ticketInput, tenantLabels, undefined, { ...decideOpts, engine: 'llm' }),
        ]);
        if (jev.status === 'rejected') {
          console.error('[Pipeline] Shadow jev decision failed:', jev.reason);
        }
        if (llm.status === 'rejected') {
          console.error('[Pipeline] Shadow llm decision failed:', llm.reason);
        }

        const suggestion =
          jev.status === 'fulfilled'
            ? jev.value
            : llm.status === 'fulfilled'
              ? llm.value
              : null;

        if (triage || suggestion) {
          await updateTicket(ticketId, {
            ...gemmaFields,
            ...(suggestion ? suggestionColumns(suggestion) : {}),
          });
        }
      } else {
        let decision: TriageDecision | null = null;
        try {
          decision = await decideTriage(ticketInput, tenantLabels, undefined, {
            ...decideOpts,
            engine: 'jev',
          });
        } catch (err) {
          console.error('[Pipeline] JEV triage decision failed, falling back to Gemma:', err);
        }

        if (decision) {
          const urgency = priorityToUrgency(decision.priority);
          const confidence = decision.confidence ?? triage?.confidence;
          decisionTriage = {
            ...(triage ?? {}),
            type: decision.type,
            urgency,
            confidence,
          };
          await updateTicket(ticketId, {
            triage_type: decision.type,
            triage_urgency: urgency,
            priority: decision.priority,
            triage_summary: triage?.summary,
            triage_confidence: confidence,
            ...suggestionColumns(decision),
          });
        } else if (triage) {
          await updateTicket(ticketId, gemmaFields);
        }
      }
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

  // JEV mode's decision drives the auto-resolve check; other modes use Gemma.
  const effectiveTriage = decisionTriage ?? triage;

  // 3. Auto-resolve decision. Follow-ups NEVER auto-send. autoSendEnabled is
  // enforced inside shouldAutoResolve (the policy is the single switch).
  const { autoSend: policyAutoSend, reason } = shouldAutoResolve(
    policy,
    {
      confidence: effectiveTriage?.confidence,
      type: effectiveTriage?.type,
      urgency: effectiveTriage?.urgency,
    },
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
            triage_confidence: effectiveTriage?.confidence ?? null,
            triage_type: effectiveTriage?.type ?? null,
            triage_urgency: effectiveTriage?.urgency ?? null,
            kb_hits: kbHits,
            top_kb_similarity: topKbSimilarity,
            policy_version: policy.version,
          });
          await afterTriage(ticketId);
          return {
            draft: replyText || null,
            autoSent: false,
            reason: 'auto-send previously failed; kept as draft',
            triage: effectiveTriage,
            kbHits,
            topKbSimilarity,
          };
        }
        await updateTicket(ticketId, {
          auto_reply_sent: true,
          auto_reply_text: replyText,
          auto_resolved: policy.resolveOnAutoSend,
          resolve_reason: `${reason} (already sent)`,
        });
        await applyAutoSendStatus(ticketId, policy.resolveOnAutoSend);
        await afterTriage(ticketId);
        return {
          draft: replyText || null,
          autoSent: true,
          reason,
          triage: effectiveTriage,
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
      });
      await applyAutoSendStatus(ticketId, policy.resolveOnAutoSend);
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
        });
        await applyAutoSendStatus(ticketId, policy.resolveOnAutoSend);
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
    triage_confidence: effectiveTriage?.confidence ?? null,
    triage_type: effectiveTriage?.type ?? null,
    triage_urgency: effectiveTriage?.urgency ?? null,
    kb_hits: kbHits,
    top_kb_similarity: topKbSimilarity,
    policy_version: policy.version,
  });

  await afterTriage(ticketId);

  return {
    draft: replyText || null,
    autoSent: autoSend,
    reason,
    triage: effectiveTriage,
    kbHits,
    topKbSimilarity,
  };
}
