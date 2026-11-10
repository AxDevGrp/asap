-- ASAP Phase 2 — RAG Knowledge Base
-- Run in Supabase Dashboard → SQL Editor → Run
-- Requires: pgvector extension (pre-installed on all Supabase projects)

-- ── Enable pgvector ───────────────────────────────────────────────────────────
create extension if not exists vector;

-- ── Knowledge Base Articles ───────────────────────────────────────────────────
-- One row per article/FAQ chunk per product.
-- Embeddings are 768-dim (Google text-embedding-004).
create table if not exists knowledge_base (
  id          uuid primary key default gen_random_uuid(),
  product     text not null,   -- 'strk' | 'cashpile' | 'dailypost' | 'unknown'
  title       text not null,
  content     text not null,
  embedding   vector(768),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
create index if not exists kb_product_idx on knowledge_base(product);

-- IVFFlat for fast approximate nearest-neighbour search.
-- lists = 10 is appropriate for < 10,000 rows; increase for larger datasets.
create index if not exists kb_embedding_idx on knowledge_base
  using ivfflat (embedding vector_cosine_ops) with (lists = 10);

-- ── Auto-update updated_at ────────────────────────────────────────────────────
create trigger kb_updated_at
  before update on knowledge_base
  for each row execute function update_updated_at();

-- ── Row Level Security ────────────────────────────────────────────────────────
alter table knowledge_base enable row level security;
create policy "service full access kb" on knowledge_base for all using (true);

-- ── Vector Similarity Search Function ────────────────────────────────────────
-- Used by rag.ts to retrieve topK relevant articles for a query.
create or replace function match_knowledge_base(
  query_embedding  vector(768),
  product_filter   text,
  match_count      int default 3,
  min_similarity   float default 0.5
)
returns table (
  id          uuid,
  title       text,
  content     text,
  similarity  float
)
language plpgsql as $$
begin
  return query
  select
    kb.id,
    kb.title,
    kb.content,
    1 - (kb.embedding <=> query_embedding) as similarity
  from knowledge_base kb
  where kb.product = product_filter
    and kb.embedding is not null
    and 1 - (kb.embedding <=> query_embedding) >= min_similarity
  order by kb.embedding <=> query_embedding
  limit match_count;
end;
$$;
