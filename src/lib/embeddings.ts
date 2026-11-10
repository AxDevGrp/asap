// Google gemini-embedding-2 via the Gemini API (text-embedding-004 was shut
// down on 2026-01-14). Output is truncated to 768 dims to match the
// knowledge_base.embedding vector(768) column; gemini-embedding-2 normalizes
// reduced-dimension vectors itself.
//
// gemini-embedding-2 has no task_type field: retrieval quality depends on
// prefixing queries and documents differently (formats from Google's docs).
// Documents and queries MUST be embedded with the matching helper below, and
// every stored article must be re-embedded if the model or format changes.

export const EMBEDDING_MODEL = 'gemini-embedding-2';
export const EMBEDDING_DIMENSIONS = 768;
const GEMINI_EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`;

async function embedRaw(text: string): Promise<number[]> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY not set');

  const response = await fetch(GEMINI_EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      output_dimensionality: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const values: number[] = data?.embedding?.values;
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Unexpected embedding response (expected ${EMBEDDING_DIMENSIONS} dims)`);
  }
  return values;
}

/** Embed a knowledge base article for storage. */
export function embedDocument(title: string, content: string): Promise<number[]> {
  return embedRaw(`title: ${title} | text: ${content}`);
}

/** Embed a customer message to search the knowledge base with. */
export function embedQuery(query: string): Promise<number[]> {
  return embedRaw(`task: search result | query: ${query}`);
}
