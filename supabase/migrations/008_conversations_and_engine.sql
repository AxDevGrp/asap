-- ASAP — Path 2: Custom Multi-Tenant Engine
-- Migration: tenants, conversations, outbound_messages tables
-- Paste into: Supabase Dashboard → SQL Editor → Run

-- ── 1. Tenants table ─────────────────────────────────────────────────────────
create table if not exists tenants (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  slug                  text not null unique,
  domain                text not null,
  chatwoot_account_id   integer,
  chatwoot_inbox_id     integer unique,
  resend_domain_id      text,
  settings              jsonb default '{}',
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

-- Seed k3nz0's existing 3 tenants (idempotent)
insert into tenants (name, slug, domain, chatwoot_account_id, chatwoot_inbox_id) values
  ('STRK',          'strk',      'getstrk.ai',      1, 1),
  ('Cashpile',      'cashpile',  'cashpile.ai',     1, 2),
  ('The Daily Post','dailypost', 'thedailypost.ai', 1, 3)
on conflict (slug) do nothing;

-- Seed goasap.ai itself as a tenant for testing
insert into tenants (name, slug, domain) values
  ('ASAP Platform', 'goasap', 'goasap.ai')
on conflict (slug) do nothing;

create index if not exists tenants_slug_idx   on tenants(slug);
create index if not exists tenants_domain_idx on tenants(domain);
create index if not exists tenants_inbox_idx  on tenants(chatwoot_inbox_id);

alter table tenants enable row level security;

-- ── 2. tenant_memberships table ───────────────────────────────────────────────
create table if not exists tenant_memberships (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  role        text not null default 'agent'
                check (role in ('owner', 'admin', 'agent')),
  created_at  timestamptz default now(),
  unique (user_id, tenant_id)
);

create index if not exists tenant_memberships_user_idx   on tenant_memberships(user_id);
create index if not exists tenant_memberships_tenant_idx on tenant_memberships(tenant_id);

alter table tenant_memberships enable row level security;

-- ── 3. Add tenant_id to existing tables ──────────────────────────────────────
alter table tickets       add column if not exists tenant_id uuid references tenants(id);
alter table messages      add column if not exists tenant_id uuid references tenants(id);
alter table knowledge_base add column if not exists tenant_id uuid references tenants(id);

-- ── 4. Conversations table (the heart of Path 2) ──────────────────────────────
create table if not exists conversations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  customer_email  text not null,
  customer_name   text,
  subject         text not null default '(No Subject)',
  status          text not null default 'open'
                    check (status in ('open', 'pending', 'closed', 'spam')),
  priority        text not null default 'medium'
                    check (priority in ('low', 'medium', 'high', 'urgent')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists conversations_tenant_idx         on conversations(tenant_id);
create index if not exists conversations_customer_email_idx on conversations(customer_email);
create index if not exists conversations_status_idx         on conversations(tenant_id, status);

alter table conversations enable row level security;

-- Service role full access
create policy "service_role_full_access_conversations" on conversations
  as permissive for all to service_role using (true);

-- ── 5. Outbound messages table ────────────────────────────────────────────────
create table if not exists outbound_messages (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  ticket_id           uuid references tickets(id) on delete set null,
  conversation_id     uuid references conversations(id) on delete set null,
  chatwoot_convo_id   integer,
  resend_message_id   text unique,
  to_email            text not null,
  from_email          text not null,
  subject             text not null,
  body_text           text not null,
  body_html           text,
  status              text not null default 'pending'
                        check (status in ('pending','sent','delivered','bounced','complained','failed')),
  error_message       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists outbound_messages_resend_id_idx      on outbound_messages(resend_message_id) where resend_message_id is not null;
create index if not exists outbound_messages_tenant_created_idx on outbound_messages(tenant_id, created_at desc);
create index if not exists outbound_messages_ticket_idx         on outbound_messages(ticket_id) where ticket_id is not null;
create index if not exists outbound_messages_conversation_idx   on outbound_messages(conversation_id) where conversation_id is not null;
create index if not exists outbound_messages_status_idx         on outbound_messages(status);

alter table outbound_messages enable row level security;

create policy "service_role_full_access_outbound" on outbound_messages
  as permissive for all to service_role using (true);

-- ── 6. Add conversation_id to messages table ──────────────────────────────────
alter table messages add column if not exists conversation_id uuid references conversations(id) on delete set null;
alter table messages add column if not exists direction text check (direction in ('inbound', 'outbound'));
alter table messages add column if not exists from_address text;
alter table messages add column if not exists subject text;
alter table messages add column if not exists body_text text;
alter table messages add column if not exists body_html text;

-- ── Done ──────────────────────────────────────────────────────────────────────
-- Tables created: tenants, tenant_memberships, conversations, outbound_messages
-- Tables updated: tickets, messages, knowledge_base (added tenant_id)
-- Tenants seeded: strk, cashpile, dailypost, goasap
