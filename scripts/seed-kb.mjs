#!/usr/bin/env node
// Seed the goASAP tenant's knowledge base directly in Supabase.
// /api/kb now requires a signed-in tenant member, so this script writes with the
// service role key instead of going through the API.
//
// Usage:
//   node --env-file=.env.local scripts/seed-kb.mjs
// Requires in env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_API_KEY.
// Optional: SEED_TENANT_SLUG (default 'goasap').
//
// Embedding model must match src/lib/embeddings.ts (768-dim, knowledge_base.embedding).

import { createClient } from '@supabase/supabase-js';

const EMBEDDING_MODEL = 'gemini-embedding-2';
const EMBEDDING_DIMENSIONS = 768;
const { NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: serviceKey, GOOGLE_API_KEY: googleKey } = process.env;
const TENANT_SLUG = process.env.SEED_TENANT_SLUG || 'goasap';

for (const [name, value] of Object.entries({ NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: serviceKey, GOOGLE_API_KEY: googleKey })) {
  if (!value) {
    console.error(`Missing ${name}. Run with: node --env-file=.env.local scripts/seed-kb.mjs`);
    process.exit(1);
  }
}

const db = createClient(url, serviceKey);

// STRK, Cashpile and The Daily Post were removed (not going live yet).
const articles = [
  {
    title: 'How does ASAP handle incoming support email?',
    content: `When a customer emails your support address, ASAP receives it, classifies it by type and urgency, searches your knowledge base for relevant articles, and writes a draft reply grounded in those articles. The draft appears on the ticket in your dashboard, where your team can edit it and send it. Replies from the same customer are threaded into one conversation.`,
  },
  {
    title: 'Does ASAP send replies automatically?',
    content: `Not by default. Every AI reply is saved as a draft for a human to review. You can turn on auto-send for your workspace; even then, a reply is only sent automatically when the AI is highly confident, the ticket type and urgency are on the allowed list, and a closely matching knowledge base article was found. Follow-up messages are always drafts.`,
  },
  {
    title: 'How do I connect my support email domain?',
    content: `During onboarding, enter the domain you use for support (for example yourcompany.com). ASAP registers it and shows the DNS records to add at your domain provider. Once the records are added, click Verify. After verification, email sent to your support address on that domain flows into ASAP, and replies are sent from it.`,
  },
  {
    title: 'How do I improve the quality of AI replies?',
    content: `The AI answers from your knowledge base, so the best way to improve replies is to add clear, specific articles covering your most common questions, policies and pricing. Keep one topic per article and update articles when something changes. You can manage articles from the Knowledge Base page in the dashboard.`,
  },
];

// Same document format as embedDocument() in src/lib/embeddings.ts.
async function embedDocument(title, content) {
  const text = `title: ${title} | text: ${content}`;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': googleKey },
      body: JSON.stringify({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
        output_dimensionality: EMBEDDING_DIMENSIONS,
      }),
    }
  );
  if (!res.ok) throw new Error(`Embedding API error ${res.status}: ${await res.text()}`);
  const values = (await res.json())?.embedding?.values;
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS) throw new Error('Unexpected embedding response');
  return values;
}

async function seed() {
  const { data: tenant, error } = await db.from('tenants').select('id, slug').eq('slug', TENANT_SLUG).single();
  if (error || !tenant) {
    throw new Error(`Tenant '${TENANT_SLUG}' not found. Apply supabase/seed.sql first.`);
  }

  console.log(`Seeding ${articles.length} KB articles for tenant '${tenant.slug}' ...\n`);
  let success = 0;
  let skipped = 0;
  let fail = 0;

  for (const article of articles) {
    try {
      // Idempotent: skip if an article with this title already exists for the tenant.
      const { data: existing } = await db
        .from('knowledge_base')
        .select('id')
        .eq('tenant_id', tenant.id)
        .eq('title', article.title)
        .maybeSingle();
      if (existing) {
        console.log(`  - [skip] ${article.title}`);
        skipped++;
        continue;
      }

      const embedding = await embedDocument(article.title, article.content);
      const { error: insertError } = await db.from('knowledge_base').insert({
        ...article,
        product: tenant.slug,
        tenant_id: tenant.id,
        embedding,
      });
      if (insertError) throw new Error(insertError.message);
      console.log(`  ✓ ${article.title}`);
      success++;
    } catch (err) {
      console.error(`  ✗ ${article.title}: ${err.message}`);
      fail++;
    }
    // Small delay to avoid rate-limiting the embedding API
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\nDone. ${success} inserted, ${skipped} skipped, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

seed().catch((err) => {
  console.error('Seed failed:', err.message ?? err);
  process.exit(1);
});
