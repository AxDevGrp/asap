// Google text-embedding-004 via Gemini API
// 768-dimensional embeddings — matches knowledge_base.embedding column

const EMBEDDING_MODEL = 'text-embedding-004';
const GEMINI_EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`;

/**
 * Embed a single text string using Google text-embedding-004.
 * Returns a 768-dimensional float array.
 */
export async function embedText(text: string): Promise<number[]> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY not set');

  const response = await fetch(`${GEMINI_EMBED_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const values: number[] = data?.embedding?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`Unexpected embedding response: ${JSON.stringify(data)}`);
  }
  return values;
}
