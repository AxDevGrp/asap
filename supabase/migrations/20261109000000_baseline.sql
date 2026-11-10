-- ASAP — AI Support Anytime Platform
-- Baseline schema (squashed from legacy migrations 001..012)
--
-- This is the single, verified final schema for a fresh Supabase project.
-- It is derived from the legacy files in supabase/migrations_legacy/ AND from
-- what the application code actually reads/writes (src/lib/*, src/app/api/*,
-- src/app/dashboard/*). No Chatwoot columns remain; inbound mail flows through
-- Resend and links to conversations via tickets.conversation_id.
--
-- Tables: tenants, tenant_memberships, conversations, tickets, messages,
--         inbound_messages, outbound_messages, resolve_audit, knowledge_base

-- ── Extensions ───────────────────────────────────────────────────────────────
create extension if not exists vector;      -- pgvector for RAG embeddings
create extension if not exists pgcrypto;    -- gen_random_uuid()

-- ── Shared helpers ───────────────────────────────────────────────────────────
create or replace function public.update_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- tenants
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists tenants (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  slug             text not null unique,
  domain           text not null,
  resend_domain_id text,
  settings         jsonb default '{}',
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create index if not exists tenants_slug_idx   on tenants(slug);
create index if not exists tenants_domain_idx on tenants(domain);

-- ═══════════════════════════════════════════════════════════════════════════════
-- tenant_memberships — user ↔ tenant association (user_id = auth.users.id)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists tenant_memberships (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  tenant_id  uuid not null references tenants(id) on delete cascade,
  role       text not null default 'agent'
               check (role in ('owner', 'admin', 'agent')),
  created_at timestamptz default now(),
  unique (user_id, tenant_id)
);

create index if not exists tenant_memberships_user_idx   on tenant_memberships(user_id);
create index if not exists tenant_memberships_tenant_idx on tenant_memberships(tenant_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- conversations — customer thread per tenant
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists conversations (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  customer_email text not null,
  customer_name  text,
  subject        text not null default '(No Subject)',
  status         text not null default 'open'
                   check (status in ('open', 'pending', 'closed', 'spam')),
  priority       text not null default 'medium'
                   check (priority in ('low', 'medium', 'high', 'urgent')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists conversations_tenant_idx         on conversations(tenant_id);
create index if not exists conversations_customer_email_idx on conversations(customer_email);
create index if not exists conversations_status_idx         on conversations(tenant_id, status);

-- ═══════════════════════════════════════════════════════════════════════════════
-- tickets
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists tickets (
  id                uuid primary key default gen_random_uuid(),

  -- Tenant + conversation link (Chatwoot identifiers removed)
  tenant_id         uuid references tenants(id) on delete set null,
  conversation_id   uuid references conversations(id) on delete set null,

  -- Product label (tenant slug); free text so any tenant works
  product           text,

  -- Contact info
  contact_name      text,
  contact_email     text,

  -- Email body (for email-based tickets)
  subject           text,
  body              text,

  -- AI triage results
  triage_type       text,        -- bug / feature_request / question / billing / other
  triage_urgency    text check (triage_urgency in ('low', 'medium', 'high', 'critical')),
  triage_summary    text,
  triage_confidence numeric(3,2),

  -- Auto-reply / auto-resolve
  auto_reply_sent   boolean default false,
  auto_reply_text   text,
  auto_resolved     boolean default false,
  resolve_reason    text,

  -- Agent assignment (used by PATCH /api/tickets/[id])
  assigned_to       uuid,

  -- Status
  status            text default 'open' check (status in ('open', 'resolved', 'pending')),

  -- Timestamps
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index if not exists tickets_product_idx            on tickets(product);
create index if not exists tickets_urgency_idx            on tickets(triage_urgency);
create index if not exists tickets_status_idx             on tickets(status);
create index if not exists tickets_created_at_idx         on tickets(created_at desc);
create index if not exists tickets_auto_resolved_idx      on tickets(auto_resolved) where auto_resolved = true;
create index if not exists tickets_tenant_id_idx          on tickets(tenant_id);
create index if not exists tickets_tenant_created_idx     on tickets(tenant_id, created_at desc);
create index if not exists tickets_tenant_status_idx      on tickets(tenant_id, status);
create index if not exists tickets_conversation_id_idx    on tickets(conversation_id);

create trigger tickets_updated_at
  before update on tickets
  for each row execute function update_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- messages — per-ticket message log
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists messages (
  id              uuid primary key default gen_random_uuid(),
  ticket_id       uuid references tickets(id) on delete cascade,
  tenant_id       uuid references tenants(id) on delete set null,
  conversation_id uuid references conversations(id) on delete set null,

  direction       text check (direction in ('incoming', 'outgoing')),
  content         text not null,
  sender_name     text,

  -- Email metadata (unused by current flows but part of final shape)
  from_address    text,
  subject         text,
  body_text       text,
  body_html       text,

  created_at      timestamptz default now()
);

create index if not exists messages_ticket_id_idx on messages(ticket_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- inbound_messages — inbound email log with Resend message_id dedup
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists inbound_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  tenant_id       uuid not null references tenants(id) on delete cascade,
  from_email      text not null,
  subject         text not null default '(No Subject)',
  body_text       text not null default '',
  body_html       text,
  message_id      text,
  created_at      timestamptz not null default now()
);

create index if not exists inbound_messages_conversation_idx on inbound_messages(conversation_id);
create index if not exists inbound_messages_tenant_idx       on inbound_messages(tenant_id);

-- Deduplicate inbound webhooks by Resend message_id (partial unique)
create unique index if not exists inbound_messages_message_id_key
  on inbound_messages(message_id)
  where message_id is not null;

-- ═══════════════════════════════════════════════════════════════════════════════
-- outbound_messages — Resend delivery tracking
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists outbound_messages (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  ticket_id         uuid references tickets(id) on delete set null,
  conversation_id   uuid references conversations(id) on delete set null,
  resend_message_id text unique,
  to_email          text not null,
  from_email        text not null,
  subject           text not null,
  body_text         text not null,
  body_html         text,
  status            text not null default 'pending'
                      check (status in ('pending','sent','delivered','bounced','complained','failed')),
  error_message     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists outbound_messages_resend_id_idx      on outbound_messages(resend_message_id) where resend_message_id is not null;
create index if not exists outbound_messages_tenant_created_idx on outbound_messages(tenant_id, created_at desc);
create index if not exists outbound_messages_ticket_idx         on outbound_messages(ticket_id) where ticket_id is not null;
create index if not exists outbound_messages_conversation_idx   on outbound_messages(conversation_id) where conversation_id is not null;
create index if not exists outbound_messages_status_idx         on outbound_messages(status);

create or replace function public.update_outbound_messages_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger outbound_messages_updated_at
  before update on outbound_messages
  for each row execute function update_outbound_messages_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- resolve_audit — auto-resolve decision log
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists resolve_audit (
  id                uuid primary key default gen_random_uuid(),
  ticket_id         uuid references tickets(id) on delete cascade,
  tenant_id         uuid references tenants(id) on delete set null,
  product           text not null,

  auto_send         boolean not null,
  reason            text not null,

  triage_confidence numeric(3,2),
  triage_type       text,
  triage_urgency    text,
  kb_hits           integer,
  top_kb_similarity numeric(3,2),

  created_at        timestamptz default now()
);

create index if not exists resolve_audit_product_idx    on resolve_audit(product);
create index if not exists resolve_audit_auto_send_idx  on resolve_audit(auto_send);
create index if not exists resolve_audit_created_at_idx on resolve_audit(created_at desc);
create index if not exists resolve_audit_tenant_idx     on resolve_audit(tenant_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- knowledge_base — RAG articles (768-dim Google gemini-embedding-2)
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists knowledge_base (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid references tenants(id) on delete set null,
  product    text not null,   -- tenant slug, e.g. 'goasap'
  title      text not null,
  content    text not null,
  embedding  vector(768),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists kb_product_idx on knowledge_base(product);
create index if not exists kb_tenant_idx  on knowledge_base(tenant_id);

-- IVFFlat for approximate nearest-neighbour search (lists=10 suits < 10k rows)
create index if not exists kb_embedding_idx on knowledge_base
  using ivfflat (embedding vector_cosine_ops) with (lists = 10);

create trigger kb_updated_at
  before update on knowledge_base
  for each row execute function update_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- match_knowledge_base — tenant-aware vector similarity search (latest version)
-- Tenant-scoped when tenant_id_filter is given, else falls back to product.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.match_knowledge_base(
  query_embedding   vector(768),
  product_filter    text,
  match_count       int   default 3,
  min_similarity    float default 0.5,
  tenant_id_filter  uuid  default null
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

-- ═══════════════════════════════════════════════════════════════════════════════
-- Row Level Security
-- ═══════════════════════════════════════════════════════════════════════════════
alter table tenants            enable row level security;
alter table tenant_memberships enable row level security;
alter table conversations      enable row level security;
alter table tickets            enable row level security;
alter table messages           enable row level security;
alter table inbound_messages   enable row level security;
alter table outbound_messages  enable row level security;
alter table resolve_audit      enable row level security;
alter table knowledge_base     enable row level security;

-- tenants: members can read their tenant
create policy "tenant members can read their tenant"
  on tenants for select
  using (
    id in (select tenant_id from tenant_memberships where user_id = auth.uid())
  );

-- tenant_memberships: users can read their own memberships
create policy "users can read own memberships"
  on tenant_memberships for select
  using (user_id = auth.uid());

-- Server-side tables: service_role full access (bypasses RLS for API routes).
-- Scoped to service_role only — the anon key (shipped to browsers) must never
-- read or write these tables.
create policy "service full access tickets"  on tickets  for all to service_role using (true);
create policy "service full access messages" on messages for all to service_role using (true);
create policy "service full access kb"       on knowledge_base for all to service_role using (true);
create policy "service full access resolve_audit" on resolve_audit for all to service_role using (true);

create policy "service_role_full_access_conversations" on conversations
  as permissive for all to service_role using (true);

create policy "service_role_full_access_inbound" on inbound_messages
  as permissive for all to service_role using (true);

create policy "service_role_full_access" on outbound_messages
  as permissive for all to service_role using (true);

-- Authenticated tenant members: read-only access to their own tenant's rows.
-- Membership is the source of truth; every real role satisfies the
-- tenant_memberships role check (owner/admin/agent).
create policy "tenant_members_read_tickets" on tickets
  as permissive for select to authenticated
  using (
    tenant_id in (
      select tenant_id from tenant_memberships
      where user_id = auth.uid() and role in ('owner', 'admin', 'agent')
    )
  );

create policy "tenant_members_read_messages" on messages
  as permissive for select to authenticated
  using (
    tenant_id in (
      select tenant_id from tenant_memberships
      where user_id = auth.uid() and role in ('owner', 'admin', 'agent')
    )
  );

create policy "tenant_members_read_kb" on knowledge_base
  as permissive for select to authenticated
  using (
    tenant_id in (
      select tenant_id from tenant_memberships
      where user_id = auth.uid() and role in ('owner', 'admin', 'agent')
    )
  );

create policy "tenant_members_read_resolve_audit" on resolve_audit
  as permissive for select to authenticated
  using (
    tenant_id in (
      select tenant_id from tenant_memberships
      where user_id = auth.uid() and role in ('owner', 'admin', 'agent')
    )
  );

create policy "tenant_members_read_conversations" on conversations
  as permissive for select to authenticated
  using (
    tenant_id in (
      select tenant_id from tenant_memberships
      where user_id = auth.uid() and role in ('owner', 'admin', 'agent')
    )
  );

create policy "tenant_members_read_inbound" on inbound_messages
  as permissive for select to authenticated
  using (
    tenant_id in (
      select tenant_id from tenant_memberships
      where user_id = auth.uid() and role in ('owner', 'admin', 'agent')
    )
  );

create policy "tenant_members_read" on outbound_messages
  as permissive for select to authenticated
  using (
    tenant_id in (
      select tenant_id from tenant_memberships
      where user_id = auth.uid() and role in ('owner', 'admin', 'agent')
    )
  );
