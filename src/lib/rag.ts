// RAG layer — retrieve relevant KB articles and generate a grounded draft reply

import { supabase } from './supabase';
import { embedText } from './embeddings';
import { TriageResult } from '@/types/chatwoot';

export interface KBArticle {
  id: string;
  title: string;
  content: string;
  similarity: number;
}

/**
 * Find the most relevant KB articles for an incoming message.
 * Embeds the query and runs cosine similarity search via pgvector.
 */
export async function searchKB(
  query: string,
  product: string,
  topK = 3,
  minSimilarity = 0.5
): Promise<KBArticle[]> {
  let embedding: number[];
  try {
    embedding = await embedText(query);
  } catch (err) {
    console.error('[RAG] embedText failed:', err);
    return [];
  }

  const { data, error } = await supabase.rpc('match_knowledge_base', {
    query_embedding: embedding,
    product_filter: product,
    match_count: topK,
    min_similarity: minSimilarity,
  });

  if (error) {
    console.error('[RAG] match_knowledge_base error:', error);
    return [];
  }

  return (data ?? []) as KBArticle[];
}

/**
 * Generate a RAG-grounded draft reply using Gemma 4 via Gemini API.
 * Falls back gracefully to a generic acknowledgement if the KB is empty
 * or if the LLM call fails.
 */
export async function generateRagReply(
  message: string,
  articles: KBArticle[],
  triage: Partial<TriageResult> & { suggested_reply?: string },
  productName: string,
  contactName?: string | null
): Promise<string> {
  // If no KB articles found, fall back to triage suggested_reply
  if (articles.length === 0) {
    return (
      triage.suggested_reply ??
      `Hi ${contactName ?? 'there'}, thanks for reaching out to ${productName} support! We've received your message and will be in touch shortly.`
    );
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.warn('[RAG] GOOGLE_API_KEY not set — returning triage suggested_reply');
    return triage.suggested_reply ?? `Hi ${contactName ?? 'there'}, thanks for reaching out to ${productName} support!`;
  }

  const context = articles
    .map((a, i) => `[${i + 1}] ${a.title}\n${a.content}`)
    .join('\n\n');

  const systemPrompt = `You are a helpful support agent for ${productName}. 
Answer the customer's question using ONLY the knowledge base articles provided.
If the articles fully answer the question, provide a clear, friendly, direct answer.
If the articles partially answer it, answer what you can and note that the team will follow up on the rest.
Keep the reply concise (2-4 sentences). Use the customer's name if provided. Do NOT make up information.`;

  const userPrompt = `Customer name: ${contactName ?? 'unknown'}
Customer message: ${message}

Knowledge Base Articles:
${context}

Write a support reply:`;

  const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
  const response = await fetch(`${GEMINI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gemma-4-26b-a4b-it',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`[RAG] Gemini reply error ${response.status}: ${err}`);
    return triage.suggested_reply ?? `Hi ${contactName ?? 'there'}, thanks for contacting ${productName} support!`;
  }

  const data = await response.json();
  let content: string = data.choices?.[0]?.message?.content ?? '';

  // Strip thinking blocks if present
  content = content.replace(/<thought>[\s\S]*?<\/thought>\s*/g, '').trim();

  return content || (triage.suggested_reply ?? `Hi ${contactName ?? 'there'}, thanks for reaching out!`);
}
