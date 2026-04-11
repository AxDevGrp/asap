import { z } from 'zod';
import { TriageResult } from '@/types/chatwoot';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const GEMINI_MODEL = 'gemma-4-26b-a4b-it';

const TriageSchema = z.object({
  product: z.string(),
  type: z.string(),
  urgency: z.enum(['low', 'medium', 'high', 'critical']),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  suggested_reply: z.string().describe('A friendly, helpful first response to send to the user'),
});

export async function triageTicket(
  message: string,
  subject: string,
  productName: string
): Promise<TriageResult & { suggested_reply: string }> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY not set');

  const systemPrompt = `You are a support ticket triage specialist for ${productName}. Analyze the message and classify it. Also write a short, friendly auto-reply to acknowledge receipt and set expectations. Return JSON only — no markdown, no prose, just the JSON object.`;

  const userPrompt = `Subject: ${subject}

Message: ${message}

Return JSON with exactly these fields:
- product: the product/service mentioned or \"${productName}\"
- type: one of \"bug\", \"feature_request\", \"question\", \"billing\", \"account\", \"other\"
- urgency: one of \"low\", \"medium\", \"high\", \"critical\"
- confidence: number 0.0 to 1.0
- summary: 1-2 sentence summary of the issue
- suggested_reply: friendly 2-3 sentence acknowledgement reply to send to the user`;

  const response = await fetch(`${GEMINI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  let content = data.choices?.[0]?.message?.content ?? '';
  
  // Strip thinking blocks if present
  content = content.replace(/<thought>[\s\S]*?<\/thought>\s*/g, '').trim();

  const parsed = JSON.parse(content);
  return TriageSchema.parse(parsed) as TriageResult & { suggested_reply: string };
}
