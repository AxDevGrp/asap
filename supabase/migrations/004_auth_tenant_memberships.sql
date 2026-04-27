-- ASAP — Phase 5B: Authentication + Authorization
-- Migration: tenant_memberships table + tenants table (if not from 5A)
-- Paste into: Supabase Dashboard → SQL Editor → Run

-- ── Tenants table (idempotent — 5A may have already created this) ──────────────
create table if not exists tenants (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  slug                  text not null unique,                        -- strk, cashpile, dailypost
  domain                text not null,                               -- cashpile.ai
  chatwoot_account_id   integer,
  resend_domain_id      text,
  settings              jsonb default '{}',
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

-- Seed the 3 existing tenants (idempotent via ON CONFLICT DO NOTHING)
insert into tenants (name, slug, domain, chatwoot_account_id) values
  ('STRK',          'strk',      'getstrk.ai',      1),
  ('Cashpile',      'cashpile',  'cashpile.ai',     2),
  ('The Daily Post','dailypost', 'thedailypost.ai', 3)
on conflict (slug) do nothing;

-- ── tenant_memberships: user ↔ tenant association ──────────────────────────────
create table if not exists tenant_memberships (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,            -- Supabase auth.users.id
  tenant_id   uuid not null references tenants(id) on delete cascade,
  role        text not null default 'agent'
                check (role in ('owner', 'admin', 'agent')),
  created_at  timestamptz default now(),
  unique (user_id, tenant_id)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
create index if not exists tenant_memberships_user_idx   on tenant_memberships(user_id);
create index if not exists tenant_memberships_tenant_idx on tenant_memberships(tenant_id);
create index if not exists tenants_slug_idx              on tenants(slug);

-- ── Row Level Security ────────────────────────────────────────────────────────
alter table tenants             enable row level security;
alter table tenant_memberships  enable row level security;

-- Tenants: readable by authenticated users who are members
create policy "tenant members can read their tenant"
  on tenants for select
  using (
    id in (
      select tenant_id from tenant_memberships
      where user_id = auth.uid()
    )
  );

-- Tenant memberships: users can see their own memberships
create policy "users can read own memberships"
  on tenant_memberships for select
  using (user_id = auth.uid());

-- Service role can do anything (used by our API routes with service_role key)
-- Note: service_role bypasses RLS automatically in Supabase
