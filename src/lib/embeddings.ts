// Knowledge base embeddings via the AI gateway (src/lib/llm.ts; OpenRouter,
// default google/gemini-embedding-2). Vectors are 768-dim to match the
// knowledge_base.embedding vector(768) column.
//
// gemini-embedding-2 has no task_type field: retrieval quality depends on
// prefixing queries and documents differently (formats from Google's docs).
// Documents and queries MUST be embedded with the matching helper below, and
// every stored article must be re-embedded if the model or format changes.

import { embedTexts, AI_EMBEDDING_MODEL } from './llm';

export const EMBEDDING_MODEL = AI_EMBEDDING_MODEL;
export const EMBEDDING_DIMENSIONS = 768;

async function embedOne(text: string): Promise<number[]> {
  const [vector] = await embedTexts([text], EMBEDDING_DIMENSIONS);
  return vector;
}

/** Embed a knowledge base article for storage. */
export function embedDocument(title: string, content: string): Promise<number[]> {
  return embedOne(`title: ${title} | text: ${content}`);
}

/** Embed a customer message to search the knowledge base with. */
export function embedQuery(query: string): Promise<number[]> {
  return embedOne(`task: search result | query: ${query}`);
}
