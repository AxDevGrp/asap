import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { ChatwootWebhookPayload } from '@/types/chatwoot';
import { triageTicket } from '@/lib/gemini';
import { sendReply, addLabel } from '@/lib/chatwoot';
import { createTicket, createMessage, getTicketByConvoId, updateTicketByConvoId } from '@/lib/db';
import { getProductFromInbox, getProductName } from '@/lib/config';

// ── HMAC signature verification ──────────────────────────────────────────────
function verifySignature(body: string, signature: string | null): boolean {
  const secret = process.env.CHATWOOT_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[Webhook] CHATWOOT_WEBHOOK_SECRET not set — skipping verification');
    return true; // Allow through in dev; enforce in prod
  }
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-chatwoot-signature');

  if (!verifySignature(rawBody, signature)) {
    console.warn('[Webhook] Invalid signature — rejected');
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
    let triageResult;
    try {
      triageResult = await triageTicket(messageContent, subject, productName);
    } catch (err) {
      console.error('[Webhook] Triage failed:', err);
      // Continue without triage — still save and acknowledge
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

    // 4. Add urgency label in Chatwoot
    if (triageResult?.urgency) {
      try {
        await addLabel(conversation.id, triageResult.urgency);
        if (triageResult.type) await addLabel(conversation.id, triageResult.type);
      } catch (err) {
        console.error('[Webhook] addLabel failed:', err);
      }
    }

    // 5. Send auto-reply
    const replyText = triageResult?.suggested_reply
      ?? `Hi ${contact?.name ?? 'there'}, thanks for reaching out to ${productName} support! We've received your message and will get back to you shortly.`;

    try {
      await sendReply(conversation.id, replyText);

      // Save auto-reply to messages table
      if (ticket) {
        await updateTicketByConvoId(conversation.id, {
          auto_reply_sent: true,
          auto_reply_text: replyText,
        });
      }
    } catch (err) {
      console.error('[Webhook] sendReply failed:', err);
    }

    return NextResponse.json({
      status: 'success',
      conversation_id: conversation.id,
      product,
      triage: triageResult ?? null,
      auto_reply_sent: true,
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

    // Save message
    await createMessage({
      ticket_id: existingTicket.id,
      chatwoot_message_id: msg.id,
      direction: 'incoming',
      content: msg.content,
      sender_name: msg.sender?.name ?? null,
    });

    console.log(`[Webhook] Follow-up message logged for conversation ${conversation.id}`);
    return NextResponse.json({ status: 'success', event: 'message_logged' });
  }

  return NextResponse.json({ status: 'ignored', reason: `Unhandled event: ${event}` });
}
