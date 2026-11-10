// Single AI gateway client (OpenRouter by default, any OpenAI-compatible API).
// Server-only. Switching provider or model is an env change, not a code change:
//
//   OPENROUTER_API_KEY   required
//   AI_BASE_URL          default https://openrouter.ai/api/v1
//   AI_CHAT_MODEL        default google/gemma-4-26b-a4b-it   (triage + drafts)
//   AI_EMBEDDING_MODEL   default google/gemini-embedding-2   (knowledge base)

export const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
export const AI_CHAT_MODEL = process.env.AI_CHAT_MODEL || 'google/gemma-4-26b-a4b-it';
export const AI_EMBEDDING_MODEL = process.env.AI_EMBEDDING_MODEL || 'google/gemini-embedding-2';

export function getAiApiKey(): string | null {
  return process.env.OPENROUTER_API_KEY || null;
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    // Optional OpenRouter attribution headers (harmless for other providers).
    'HTTP-Referer': process.env.APP_URL || 'https://goasap.ai',
    'X-Title': 'ASAP',
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Run a chat completion and return the assistant text (thinking blocks stripped).
 * Throws on missing key, HTTP errors, or an empty response.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  opts: { json?: boolean; maxTokens?: number; temperature?: number; model?: string } = {}
): Promise<string> {
  const apiKey = getAiApiKey();
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  const response = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({
      model: opts.model ?? AI_CHAT_MODEL,
      messages,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`AI API error ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }

  const data = await response.json();
  if (data?.error) {
    throw new Error(`AI API error: ${JSON.stringify(data.error).slice(0, 500)}`);
  }
  const content: string = data?.choices?.[0]?.message?.content ?? '';
  const cleaned = content
    .replace(/<thought>[\s\S]*?<\/thought>\s*/g, '')
    .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
    .trim();
  if (!cleaned) throw new Error('AI API returned an empty response');
  return cleaned;
}

/** Parse JSON from a model reply, tolerating a ```json fence around it. */
export function parseJsonReply(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse((fenced ? fenced[1] : text).trim());
}

/**
 * Embed texts. Requests `dimensions`; if the provider returns a longer
 * Matryoshka vector (gemini-embedding-*), truncate and re-normalize to length.
 */
export async function embedTexts(texts: string[], dimensions: number): Promise<number[][]> {
  const apiKey = getAiApiKey();
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  const response = await fetch(`${AI_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ model: AI_EMBEDDING_MODEL, input: texts, dimensions }),
  });

  if (!response.ok) {
    throw new Error(`Embedding API error ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }

  const data = await response.json();
  const rows: Array<{ embedding?: number[]; index?: number }> = data?.data ?? [];
  if (rows.length !== texts.length) {
    throw new Error(`Unexpected embedding response: ${JSON.stringify(data).slice(0, 300)}`);
  }

  return rows
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((row) => {
      const v = row.embedding;
      if (!Array.isArray(v) || v.length < dimensions) {
        throw new Error(`Embedding has ${v?.length ?? 0} dims, expected ${dimensions}`);
      }
      if (v.length === dimensions) return v;
      const cut = v.slice(0, dimensions);
      const norm = Math.sqrt(cut.reduce((s, x) => s + x * x, 0)) || 1;
      return cut.map((x) => x / norm);
    });
}
