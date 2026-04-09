import { NextRequest, NextResponse } from 'next/server';
import { ChatwootWebhookPayload } from '@/types/chatwoot';
import { triageTicket } from '@/lib/openai';

export async function POST(request: NextRequest) {
  try {
    const payload: ChatwootWebhookPayload = await request.json();

    if (payload.event !== 'conversation_created') {
      return NextResponse.json({ 
        status: 'ignored', 
        reason: `Event type '${payload.event}' not handled` 
      }, { status: 200 });
    }

    const { inbox_id, conversation, messages, contact } = payload;

    if (!messages || messages.length === 0) {
      return NextResponse.json({ 
        status: 'ignored', 
        reason: 'No messages in conversation' 
      }, { status: 200 });
    }

    const firstMessage = messages[0];
    const messageContent = firstMessage.content || '';
    const subject = contact?.name ? `Message from ${contact.name}` : 'New Support Message';

    const triageResult = await triageTicket(messageContent, subject);

    console.log('[Chatwoot Webhook] Triage result:', {
      inbox_id,
      conversation_id: conversation.id,
      triage: triageResult,
    });

    return NextResponse.json({
      status: 'success',
      inbox_id,
      conversation_id: conversation.id,
      triage: triageResult,
    }, { status: 200 });

  } catch (error) {
    console.error('[Chatwoot Webhook] Error:', error);
    
    return NextResponse.json({
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    }, { status: 200 });
  }
}
