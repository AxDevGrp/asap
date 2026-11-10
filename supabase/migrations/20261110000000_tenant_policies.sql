-- Per-tenant auto-resolve policies
--
-- Moves the auto-resolve decision config out of hardcoded slug logic
-- (src/lib/auto-resolve.ts) and into a row per tenant. One row per tenant,
-- auto-created by a trigger on tenants and backfilled from tenants.settings
-- for existing tenants.
--
-- Idempotent: safe to re-run.

-- ═══════════════════════════════════════════════════════════════════════════════
-- tenant_policies
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists tenant_policies (
  tenant_id              uuid primary key references tenants(id) on delete cascade,
  auto_send_enabled      boolean      not null default false,
  confidence_threshold   numeric(3,2) not null default 0.85 check (confidence_threshold between 0 and 1),
  allowed_types          text[]       not null default '{question,billing,feature_request}',
  allowed_urgencies      text[]       not null default '{low,medium}',
  min_kb_similarity      numeric(3,2) not null default 0.70 check (min_kb_similarity between 0 and 1),
  min_kb_hits            integer      not null default 1 check (min_kb_hits >= 0),
  resolve_on_auto_send   boolean      not null default true,
  version                integer      not null default 1,
  updated_by             uuid,
  created_at             timestamptz  not null default now(),
  updated_at             timestamptz  not null default now()
);

-- Bump version on every update (and stamp updated_at).
create or replace function public.bump_tenant_policies_version()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  new.version = old.version + 1;
  return new;
end;
$$;

drop trigger if exists tenant_policies_updated_at on tenant_policies;
create trigger tenant_policies_updated_at
  before update on tenant_policies
  for each row execute function public.bump_tenant_policies_version();

-- ═══════════════════════════════════════════════════════════════════════════════
-- Auto-create a policy row for every new tenant
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.create_default_tenant_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into tenant_policies (tenant_id)
  values (new.id)
  on conflict (tenant_id) do nothing;
  return new;
end;
$$;

drop trigger if exists tenants_create_default_policy on tenants;
create trigger tenants_create_default_policy
  after insert on tenants
  for each row execute function public.create_default_tenant_policy();

-- ═══════════════════════════════════════════════════════════════════════════════
-- Backfill a row for every existing tenant, carrying over legacy settings
-- ═══════════════════════════════════════════════════════════════════════════════
insert into tenant_policies (tenant_id, auto_send_enabled, confidence_threshold)
select
  t.id,
  coalesce(
    case when (t.settings->>'autoSendEnabled') in ('true', 'false')
         then (t.settings->>'autoSendEnabled')::boolean
    end,
    false
  ),
  coalesce(
    case
      when (t.settings->>'auto_resolve_threshold') ~ '^[0-9]+(\.[0-9]+)?$'
           and (t.settings->>'auto_resolve_threshold')::numeric between 0 and 100
        then least(greatest((t.settings->>'auto_resolve_threshold')::numeric / 100, 0), 1)
    end,
    0.85
  )
from tenants t
on conflict (tenant_id) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- resolve_audit: record which policy version produced each decision
-- ═══════════════════════════════════════════════════════════════════════════════
alter table resolve_audit
  add column if not exists policy_version integer;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Row Level Security
-- ═══════════════════════════════════════════════════════════════════════════════
alter table tenant_policies enable row level security;

drop policy if exists "tenant_policies_select_members" on tenant_policies;
create policy "tenant_policies_select_members" on tenant_policies
  for select to authenticated
  using (
    tenant_id in (
      select tenant_id from tenant_memberships
      where user_id = auth.uid() and role in ('owner', 'admin', 'agent')
    )
  );

drop policy if exists "tenant_policies_insert_admins" on tenant_policies;
create policy "tenant_policies_insert_admins" on tenant_policies
  for insert to authenticated
  with check (
    tenant_id in (
      select tenant_id from tenant_memberships
      where user_id = auth.uid() and role in ('owner', 'admin')
    )
  );

drop policy if exists "tenant_policies_update_admins" on tenant_policies;
create policy "tenant_policies_update_admins" on tenant_policies
  for update to authenticated
  using (
    tenant_id in (
      select tenant_id from tenant_memberships
      where user_id = auth.uid() and role in ('owner', 'admin')
    )
  )
  with check (
    tenant_id in (
      select tenant_id from tenant_memberships
      where user_id = auth.uid() and role in ('owner', 'admin')
    )
  );

-- Service role (API routes) needs full access, matching other server tables.
drop policy if exists "service full access tenant_policies" on tenant_policies;
create policy "service full access tenant_policies" on tenant_policies
  for all to service_role using (true) with check (true);
