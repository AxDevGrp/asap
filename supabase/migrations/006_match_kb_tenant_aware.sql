-- ASAP — Phase 5C: Update match_knowledge_base() to support tenant_id filtering
-- Run this in Supabase SQL Editor after 005_tenant_inbox_mapping.sql

-- Drop existing function and recreate with optional tenant_id_filter parameter
create or replace function match_knowledge_base(
  query_embedding   vector(1536),
  product_filter    text,
  match_count       int     default 3,
  min_similarity    float   default 0.5,
  tenant_id_filter  uuid    default null
)
returns table (
  id          uuid,
  title       text,
  content     text,
  similarity  float
)
language plpgsql
as $$
begin
  return query
  select
    kb.id,
    kb.title,
    kb.content,
    1 - (kb.embedding <=> query_embedding) as similarity
  from knowledge_base kb
  where
    -- If tenant_id_filter provided, scope to tenant; otherwise use product field
    (
      (tenant_id_filter is not null and kb.tenant_id = tenant_id_filter)
      or
      (tenant_id_filter is null and kb.product = product_filter)
    )
    and kb.embedding is not null
    and 1 - (kb.embedding <=> query_embedding) >= min_similarity
  order by kb.embedding <=> query_embedding
  limit match_count;
end;
$$;
