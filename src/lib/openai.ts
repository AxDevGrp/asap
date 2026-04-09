import OpenAI from 'openai';
import { z } from 'zod';
import { TriageResult } from '@/types/chatwoot';

const openaiApiKey = process.env.OPENAI_API_KEY!;

export const openai = new OpenAI({
  apiKey: openaiApiKey,
});

const TriageSchema = z.object({
  product: z.string().describe('The product or service mentioned in the ticket'),
  type: z.string().describe('The type of issue (bug, feature request, question, etc.)'),
  urgency: z.enum(['low', 'medium', 'high', 'critical']).describe('Urgency level based on user sentiment and issue severity'),
  confidence: z.number().min(0).max(1).describe('Confidence score between 0 and 1'),
  summary: z.string().describe('A brief summary of the issue'),
});

export async function triageTicket(message: string, subject: string): Promise<TriageResult> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You are a support ticket triage specialist. Analyze the incoming message and subject line to categorize the ticket. 
        Return your analysis in JSON format with these fields:
        - product: Identify the product/service mentioned
        - type: Classify the issue type (bug, feature request, question, billing, etc.)
        - urgency: Assess urgency as low, medium, high, or critical based on user tone and issue severity
        - confidence: Your confidence score (0.0-1.0) in this categorization
        - summary: A concise 1-2 sentence summary of the issue`,
      },
      {
        role: 'user',
        content: `Subject: ${subject}\n\nMessage: ${message}`,
      },
    ],
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0]?.message?.content;
  
  if (!content) {
    throw new Error('No content returned from OpenAI');
  }

  const parsed = JSON.parse(content);
  const validated = TriageSchema.parse(parsed);
  
  return validated;
}
