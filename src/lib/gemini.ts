import { z } from 'zod';
import { TriageResult } from '@/types/triage';

import { chatCompletion, parseJsonReply } from '@/lib/llm';

// Ticket triage. Runs on AI_CHAT_MODEL via the gateway in src/lib/llm.ts
// (OpenRouter, default google/gemma-4-26b-a4b-it).

const TriageSchema = z.object({
  product: z.string(),
  type: z.string(),
  urgency: z.enum(['low', 'medium', 'high', 'critical']),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  suggested_reply: z.string().describe('A friendly, helpful first response to send to the user'),
});

export interface TenantContext {
  name: string;
  domain?: string;
  tone?: string; // e.g. 'professional', 'friendly', 'technical'
  brandContext?: string; // extra context to inject into prompts
}

export async function triageTicket(
  message: string,
  subject: string,
  productName: string,
  tenantCtx?: TenantContext
): Promise<TriageResult & { suggested_reply: string }> {
  const tenantName = tenantCtx?.name ?? productName;
  const toneHint = tenantCtx?.tone ? ` Tone: ${tenantCtx.tone}.` : '';
  const brandHint = tenantCtx?.brandContext ? ` Context: ${tenantCtx.brandContext}.` : '';

  const systemPrompt = `You are a support ticket triage specialist for ${tenantName}.${toneHint}${brandHint} Analyze the message and classify it. Also write a short, friendly auto-reply to acknowledge receipt and set expectations. Return JSON only — no markdown, no prose, just the JSON object.`;

  const userPrompt = `Subject: ${subject}

Message: ${message}

Return JSON with exactly these fields:
- product: the product/service mentioned or "${tenantName}"
- type: one of "bug", "feature_request", "question", "billing", "account", "other"
- urgency: one of "low", "medium", "high", "critical"
- confidence: number 0.0 to 1.0
- summary: 1-2 sentence summary of the issue
- suggested_reply: friendly 2-3 sentence acknowledgement reply to send to the user`;

  const content = await chatCompletion(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    { json: true }
  );

  const parsed = parseJsonReply(content);
  return TriageSchema.parse(parsed) as TriageResult & { suggested_reply: string };
}
