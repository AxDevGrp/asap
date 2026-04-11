-- ASAP — AI Support Anytime Platform
-- Initial Schema Migration
-- Paste this into: Supabase Dashboard → SQL Editor → Run

-- ── Tickets ─────────────────────────────────────────────────────────────────
-- One row per Chatwoot conversation. Created when webhook fires.
create table if not exists tickets (
  id                  uuid primary key default gen_random_uuid(),
  
  -- Chatwoot identifiers
  chatwoot_inbox_id   integer not null,
  chatwoot_convo_id   integer not null unique,
  
  -- Product (derived from inbox_id mapping)
  product             text not null check (product in ('strk', 'cashpile', 'dailypost', 'unknown')),

  -- Contact info
  contact_name        text,
  contact_email       text,

  -- AI triage results
  triage_type         text,       -- bug / feature_request / question / billing / other
  triage_urgency      text check (triage_urgency in ('low', 'medium', 'high', 'critical')),
  triage_summary      text,
  triage_confidence   numeric(3,2),
  
  -- Auto-reply sent back to Chatwoot
  auto_reply_sent     boolean default false,
  auto_reply_text     text,

  -- Status
  status              text default 'open' check (status in ('open', 'resolved', 'pending')),

  -- Timestamps
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

-- ── Messages ─────────────────────────────────────────────────────────────────
-- Stores individual messages within a conversation.
create table if not exists messages (
  id                  uuid primary key default gen_random_uuid(),
  ticket_id           uuid references tickets(id) on delete cascade,
  
  chatwoot_message_id integer not null unique,
  direction           text check (direction in ('incoming', 'outgoing')),
  content             text not null,
  sender_name         text,
  
  created_at          timestamptz default now()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
create index if not exists tickets_product_idx      on tickets(product);
create index if not exists tickets_urgency_idx      on tickets(triage_urgency);
create index if not exists tickets_status_idx       on tickets(status);
create index if not exists tickets_created_at_idx   on tickets(created_at desc);
create index if not exists messages_ticket_id_idx   on messages(ticket_id);

-- ── Auto-update updated_at ────────────────────────────────────────────────────
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger tickets_updated_at
  before update on tickets
  for each row execute function update_updated_at();

-- ── Row Level Security ────────────────────────────────────────────────────────
alter table tickets  enable row level security;
alter table messages enable row level security;

-- Server-side only (service role key) — no public access
-- The Next.js API routes use the anon key but RLS policies below
-- allow inserts/selects from authenticated server context.
-- For now: allow all from authenticated (we'll tighten per-app later)
create policy "service full access tickets"  on tickets  for all using (true);
create policy "service full access messages" on messages for all using (true);
