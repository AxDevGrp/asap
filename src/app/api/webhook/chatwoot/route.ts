import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import { ChatwootWebhookPayload, TriageResult } from '@/types/chatwoot';
import { triageTicket } from '@/lib/gemini';
import { sendPrivateNote, sendReply, addLabel, updateStatus } from '@/lib/chatwoot';
import {
  createTicket,
  createMessage,
  getTicketByConvoId,
  updateTicketByConvoId,
  getMessagesByTicketId,
  createResolveAudit,
} from '@/lib/db';
import { getProductFromInbox, getProductName } from '@/lib/config';
import { searchKB, generateRagReply, generateFollowUpReply, KBArticle } from '@/lib/rag';
import { shouldAutoResolve, DEFAULT_POLICIES } from '@/lib/auto-resolve';

// ── Webhook signature verification ─────────────────────────────────────────────

function verifySignature(payload: string, signature: string | null): boolean {
  const secret = process.env.CHATWOOT_WEBHOOK_SECRET;
  // If no secret configured, skip verification (dev mode)
  if (!secret) return true;
  if (!signature) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signature)
  );
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  // Verify webhook signature
  const signature = request.headers.get('x-chatwoot-signature');
  if (!verifySignature(rawBody, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: ChatwootWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { event, inbox_id, conversation, messages, contact } = payload;

  // ── conversation_created: new support ticket ───────────────────────────────
  if (event === 'conversation_created') {
    const firstMessage = messages?.[0];
    if (!firstMessage?.content) {
      return NextResponse.json({ status: 'ignored', reason: 'No message content' });
    }

    const product = getProductFromInbox(inbox_id);
    const productName = getProductName(product);
    const messageContent = firstMessage.content;
    const subject = contact?.name ? `Message from ${contact.name}` : 'New Support Message';

    console.log(`[Webhook] New conversation ${conversation.id} — ${productName} (inbox ${inbox_id})`);

    // 1. Triage with Gemma 4 26B
    let triageResult: (TriageResult & { suggested_reply: string }) | undefined;
    try {
      triageResult = await triageTicket(messageContent, subject, productName);
    } catch (err) {
      console.error('[Webhook] Triage failed:', err);
    }

    // 2. Save ticket to Supabase
    const ticket = await createTicket({
      chatwoot_inbox_id: inbox_id,
      chatwoot_convo_id: conversation.id,
      product,
      contact_name: contact?.name ?? null,
      contact_email: contact?.email ?? null,
      triage_type: triageResult?.type,
      triage_urgency: triageResult?.urgency,
      triage_summary: triageResult?.summary,
      triage_confidence: triageResult?.confidence,
      status: 'open',
    });

    // 3. Save incoming message
    if (ticket) {
      await createMessage({
        ticket_id: ticket.id,
        chatwoot_message_id: firstMessage.id,
        direction: 'incoming',
        content: messageContent,
        sender_name: contact?.name ?? null,
      });
    }

    // 4. Add urgency + type labels in Chatwoot
    if (triageResult?.urgency) {
      try {
        await addLabel(conversation.id, triageResult.urgency);
        if (triageResult.type) await addLabel(conversation.id, triageResult.type);
      } catch (err) {
        console.error('[Webhook] addLabel failed:', err);
      }
    }

    // 5. RAG: search KB for relevant articles, then generate grounded reply
    let replyText: string;
    let kbArticles: KBArticle[] = [];
    try {
      kbArticles = await searchKB(messageContent, product);
      replyText = await generateRagReply(
        messageContent,
        kbArticles,
        triageResult ?? {},
        productName,
        contact?.name
      );
      if (kbArticles.length > 0) {
        console.log(`[Webhook] RAG: found ${kbArticles.length} KB articles (top similarity: ${kbArticles[0].similarity.toFixed(2)})`);
      } else {
        console.log('[Webhook] RAG: no KB articles found, using triage suggested_reply');
      }
    } catch (err) {
      console.error('[Webhook] RAG reply generation failed:', err);
      replyText =
        triageResult?.suggested_reply ??
        `Hi ${contact?.name ?? 'there'}, thanks for reaching out to ${productName} support! We've received your message and will get back to you shortly.`;
    }

    // 6. Auto-resolve decision: high-confidence replies auto-send, low-confidence stay as draft
    const kbHitCount = kbArticles.length;
    const topKbSimilarity = kbHitCount > 0 ? kbArticles[0].similarity : null;
    const { autoSend, reason: resolveReason } = shouldAutoResolve(
      product,
      { confidence: triageResult?.confidence, type: triageResult?.type, urgency: triageResult?.urgency },
      kbHitCount,
      topKbSimilarity
    );

    try {
      if (autoSend) {
        // ── AUTO-SEND: reply goes directly to the customer ─────────────────────
        await sendReply(conversation.id, replyText);
        await addLabel(conversation.id, 'auto-resolved');

        // Auto-resolve the conversation in Chatwoot if policy allows
        const policy = DEFAULT_POLICIES[product];
        if (policy?.autoResolveConversation) {
          await updateStatus(conversation.id, 'resolved');
        }

        if (ticket) {
          await updateTicketByConvoId(conversation.id, {
            auto_reply_sent: true,
            auto_reply_text: replyText,
            auto_resolved: true,
            resolve_reason: resolveReason,
            status: 'resolved',
          });
        }

        // Log auto-resolve as private note for audit trail
        const auditNote = [
          `🤖 AUTO-RESOLVED (sent directly to customer)`,
          `---`,
          `Reason: ${resolveReason}`,
          `Confidence: ${triageResult?.confidence?.toFixed(2) ?? 'N/A'} | Type: ${triageResult?.type ?? 'N/A'} | Urgency: ${triageResult?.urgency ?? 'N/A'}`,
          `KB articles matched: ${kbHitCount} | Top similarity: ${topKbSimilarity?.toFixed(2) ?? 'N/A'}`,
        ].join('\n');
        await sendPrivateNote(conversation.id, auditNote);

        // Audit log
        await createResolveAudit({
          ticket_id: ticket?.id ?? null,
          chatwoot_convo_id: conversation.id,
          product,
          auto_send: true,
          reason: resolveReason,
          triage_confidence: triageResult?.confidence ?? null,
          triage_type: triageResult?.type ?? null,
          triage_urgency: triageResult?.urgency ?? null,
          kb_hits: kbHitCount,
          top_kb_similarity: topKbSimilarity,
        });

        console.log(`[Webhook] AUTO-RESOLVED conversation ${conversation.id}: ${resolveReason}`);
      } else {
        // ── DRAFT MODE: reply posted as private note for human review ──────────
        const draftNote = [
          `🤖 AI Draft Reply (review before sending):`,
          `---`,
          replyText,
          `---`,
          `Why draft: ${resolveReason}`,
          `Confidence: ${triageResult?.confidence?.toFixed(2) ?? 'N/A'} | Type: ${triageResult?.type ?? 'N/A'} | Urgency: ${triageResult?.urgency ?? 'N/A'}`,
          `KB articles matched: ${kbHitCount} | Top similarity: ${topKbSimilarity?.toFixed(2) ?? 'N/A'}`,
        ].join('\n');

        await sendPrivateNote(conversation.id, draftNote);
        await addLabel(conversation.id, 'ai-draft');

        if (ticket) {
          await updateTicketByConvoId(conversation.id, {
            auto_reply_sent: false,
            auto_reply_text: replyText,
            auto_resolved: false,
            resolve_reason: resolveReason,
          });
        }

        // Audit log (draft-only decision)
        await createResolveAudit({
          ticket_id: ticket?.id ?? null,
          chatwoot_convo_id: conversation.id,
          product,
          auto_send: false,
          reason: resolveReason,
          triage_confidence: triageResult?.confidence ?? null,
          triage_type: triageResult?.type ?? null,
          triage_urgency: triageResult?.urgency ?? null,
          kb_hits: kbHitCount,
          top_kb_similarity: topKbSimilarity,
        });

        console.log(`[Webhook] Draft reply posted for conversation ${conversation.id}: ${resolveReason}`);
      }
    } catch (err) {
      console.error('[Webhook] Reply/note send failed:', err);
    }

    return NextResponse.json({
      status: 'success',
      conversation_id: conversation.id,
      product,
      triage: triageResult ?? null,
      auto_sent: autoSend,
      resolve_reason: resolveReason,
    });
  }

  // ── message_created: follow-up message in existing conversation ───────────
  if (event === 'message_created') {
    const msg = messages?.[0];
    if (!msg || msg.message_type !== 'incoming') {
      return NextResponse.json({ status: 'ignored', reason: 'Not an incoming message' });
    }

    // Look up existing ticket
    const existingTicket = await getTicketByConvoId(conversation.id);
    if (!existingTicket) {
      return NextResponse.json({ status: 'ignored', reason: 'No ticket found for conversation' });
    }

    const product = existingTicket.product;
    const productName = getProductName(product);

    // Reopen ticket if it was resolved
    if (existingTicket.status === 'resolved') {
      await updateTicketByConvoId(conversation.id, { status: 'open' });
      try { await updateStatus(conversation.id, 'open'); } catch { /* ignore */ }
    }

    // Save follow-up message
    await createMessage({
      ticket_id: existingTicket.id,
      chatwoot_message_id: msg.id,
      direction: 'incoming',
      content: msg.content,
      sender_name: msg.sender?.name ?? null,
    });

    console.log(`[Webhook] Follow-up message logged for conversation ${conversation.id}`);

    // Generate a new RAG draft reply with full conversation context
    try {
      // Gather all messages for context
      const allMessages = await getMessagesByTicketId(existingTicket.id);
      const conversationContext = allMessages
        .map((m: { direction: string; content: string; sender_name: string | null }) =>
          `[${m.direction === 'incoming' ? 'Customer' : 'Support'}]: ${m.content}`
        )
        .join('\n');

      const kbArticles = await searchKB(msg.content, product);
      const followUpReply = await generateFollowUpReply(
        msg.content,
        conversationContext,
        kbArticles,
        productName,
        existingTicket.contact_name,
      );

      // Follow-ups always draft — never auto-send on follow-up (customer might be frustrated)
      const topKbSimilarity = kbArticles.length > 0 ? kbArticles[0].similarity : null;
      const draftNote = [
        `🤖 AI Draft Reply (follow-up — review before sending):`,
        `---`,
        followUpReply,
        `---`,
        `Context: ${allMessages.length} messages in conversation | KB hits: ${kbArticles.length} | Top similarity: ${topKbSimilarity?.toFixed(2) ?? 'N/A'}`,
      ].join('\n');

      await sendPrivateNote(conversation.id, draftNote);
      await addLabel(conversation.id, 'ai-draft');

      // Update ticket with new draft
      await updateTicketByConvoId(conversation.id, {
        auto_reply_text: followUpReply,
      });

      console.log(`[Webhook] Follow-up draft posted for conversation ${conversation.id}`);
    } catch (err) {
      console.error('[Webhook] Follow-up RAG draft failed:', err);
    }

    return NextResponse.json({ status: 'success', event: 'message_logged', draft_posted: true });
  }

  // ── conversation_status_changed: track resolution ──────────────────────────
  if (event === 'conversation_status_changed') {
    const newStatus = conversation.status;
    if (newStatus === 'resolved') {
      const existingTicket = await getTicketByConvoId(conversation.id);
      if (existingTicket && existingTicket.status !== 'resolved') {
        await updateTicketByConvoId(conversation.id, { status: 'resolved' });
        console.log(`[Webhook] Conversation ${conversation.id} resolved by human agent`);
      }
    }
    return NextResponse.json({ status: 'success', event: 'status_tracked' });
  }

  return NextResponse.json({ status: 'ignored', reason: `Unhandled event: ${event}` });
}
