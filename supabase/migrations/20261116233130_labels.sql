-- ASAP-5 · Labels
--
-- Per-tenant labels and their ticket associations. Every tenant gets a set of
-- default labels on creation; existing tenants are backfilled. Safe to re-run
-- (idempotent DDL).

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. labels — per-tenant label definitions
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.labels (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 50),
  color       text not null default '#6b7280'
                check (color ~ '^#[0-9a-fA-F]{6}$'),
  description text,
  created_at  timestamptz not null default now()
);

create unique index if not exists labels_tenant_lower_name_idx
  on public.labels (tenant_id, lower(name));

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. ticket_labels — many-to-many ticket ↔ label
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.ticket_labels (
  ticket_id     uuid not null references public.tickets(id) on delete cascade,
  label_id      uuid not null references public.labels(id) on delete cascade,
  added_by_type text not null check (added_by_type in ('user', 'agent', 'system', 'rule')),
  added_by_id   uuid,
  created_at    timestamptz not null default now(),
  primary key (ticket_id, label_id)
);

create index if not exists ticket_labels_label_idx
  on public.ticket_labels (label_id);

-- A ticket and its label must belong to the same tenant. RLS cannot express
-- this across two tables, so enforce it with a trigger.
create or replace function public.check_ticket_label_tenant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ticket_tenant uuid;
  label_tenant  uuid;
begin
  select tenant_id into ticket_tenant from public.tickets where id = new.ticket_id;
  select tenant_id into label_tenant from public.labels where id = new.label_id;

  if ticket_tenant is distinct from label_tenant then
    raise exception 'ticket % and label % belong to different tenants',
      new.ticket_id, new.label_id;
  end if;

  return new;
end;
$$;

drop trigger if exists ticket_labels_same_tenant on public.ticket_labels;
create trigger ticket_labels_same_tenant
  before insert or update on public.ticket_labels
  for each row execute function public.check_ticket_label_tenant();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Default labels seeded per tenant
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.seed_default_labels(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.labels (tenant_id, name, color)
  values
    (p_tenant_id, 'billing',         '#3b82f6'),
    (p_tenant_id, 'bug',             '#ef4444'),
    (p_tenant_id, 'question',        '#8b5cf6'),
    (p_tenant_id, 'feature request', '#10b981'),
    (p_tenant_id, 'account',         '#f59e0b'),
    (p_tenant_id, 'shipping',        '#06b6d4'),
    (p_tenant_id, 'refund',          '#f97316')
  on conflict (tenant_id, (lower(name))) do nothing;
end;
$$;

create or replace function public.seed_default_labels_on_tenant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.seed_default_labels(new.id);
  return new;
end;
$$;

drop trigger if exists tenants_seed_default_labels on public.tenants;
create trigger tenants_seed_default_labels
  after insert on public.tenants
  for each row execute function public.seed_default_labels_on_tenant();

-- Backfill existing tenants.
select public.seed_default_labels(id) from public.tenants;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. RLS
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.labels        enable row level security;
alter table public.ticket_labels enable row level security;

drop policy if exists "service full access labels" on public.labels;
create policy "service full access labels" on public.labels
  for all to service_role using (true);

drop policy if exists "tenant_members_read_labels" on public.labels;
create policy "tenant_members_read_labels" on public.labels
  for select to authenticated
  using (
    tenant_id in (
      select tenant_id from public.tenant_memberships
      where user_id = auth.uid() and role in ('owner', 'admin', 'agent')
    )
  );

drop policy if exists "service full access ticket_labels" on public.ticket_labels;
create policy "service full access ticket_labels" on public.ticket_labels
  for all to service_role using (true);

drop policy if exists "tenant_members_read_ticket_labels" on public.ticket_labels;
create policy "tenant_members_read_ticket_labels" on public.ticket_labels
  for select to authenticated
  using (
    ticket_id in (
      select id from public.tickets
      where tenant_id in (
        select tenant_id from public.tenant_memberships
        where user_id = auth.uid() and role in ('owner', 'admin', 'agent')
      )
    )
  );
