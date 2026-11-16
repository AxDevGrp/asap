-- ASAP-3 · Ticket model v2
--
-- Adds per-tenant ticket prefixes and gap-free ticket numbers, the Linear-style
-- status set, priority, owner, and the new ticket columns used by the
-- Triage/work-management model. Safe to re-run (idempotent DDL / data guards).
--
-- Data mapping applied here (only affects rows created before this migration):
--   status: open    -> todo
--           pending -> waiting_on_customer
--           null    -> todo (status becomes NOT NULL with default 'triage')
--   priority: triage_urgency critical -> urgent, high -> high,
--             medium -> medium, low -> low, anything else -> none
--   number:  1..n per tenant, ordered by (created_at, id)
--   title:   copied from subject
--   resolved/closed timestamps: resolved rows inherit updated_at

-- Backfills below must not bump tickets.updated_at (it is the source for
-- resolved_at/closed_at and the list sort order), so pause that trigger.
alter table public.tickets disable trigger tickets_updated_at;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. tenants.ticket_prefix — uppercase 2..6 letter prefix (e.g. GOA)
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.tenants add column if not exists ticket_prefix text;

-- Backfill: first three letters of the slug, 'TKT' when that yields < 2 letters.
update public.tenants
set ticket_prefix = coalesce(
  nullif(upper(left(regexp_replace(slug, '[^a-zA-Z]', '', 'g'), 3)), ''),
  'TKT'
)
where ticket_prefix is null;

update public.tenants set ticket_prefix = 'TKT' where length(ticket_prefix) < 2;

alter table public.tenants alter column ticket_prefix set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenants'::regclass
      and conname = 'tenants_ticket_prefix_check'
  ) then
    alter table public.tenants
      add constraint tenants_ticket_prefix_check
      check (ticket_prefix ~ '^[A-Z]{2,6}$');
  end if;
end
$$;

-- Existing inserts (seed.sql, POST /api/tenants) do not pass a prefix, so fill
-- it from the slug before NOT NULL is enforced.
create or replace function public.set_tenant_ticket_prefix()
returns trigger
language plpgsql
as $$
declare
  derived text;
begin
  if new.ticket_prefix is null then
    derived := upper(left(regexp_replace(new.slug, '[^a-zA-Z]', '', 'g'), 3));
    if length(derived) < 2 then
      derived := 'TKT';
    end if;
    new.ticket_prefix := derived;
  end if;
  return new;
end;
$$;

drop trigger if exists tenants_set_ticket_prefix on public.tenants;
create trigger tenants_set_ticket_prefix
  before insert on public.tenants
  for each row execute function public.set_tenant_ticket_prefix();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. ticket_counters — one atomic sequence per tenant
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.ticket_counters (
  tenant_id   uuid primary key references public.tenants(id) on delete cascade,
  last_number int not null default 0
);

alter table public.ticket_counters enable row level security;

drop policy if exists "service full access ticket_counters" on public.ticket_counters;
create policy "service full access ticket_counters" on public.ticket_counters
  for all to service_role using (true);

drop policy if exists "tenant_members_read_ticket_counters" on public.ticket_counters;
create policy "tenant_members_read_ticket_counters" on public.ticket_counters
  for select to authenticated
  using (
    tenant_id in (
      select tenant_id from public.tenant_memberships
      where user_id = auth.uid() and role in ('owner', 'admin', 'agent')
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. tickets.number — per-tenant, gap-free, assigned atomically on insert
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.tickets add column if not exists number int;

create unique index if not exists tickets_tenant_number_idx
  on public.tickets(tenant_id, number);

-- Backfill existing tickets 1..n per tenant (created_at, id). Only rows that
-- still have no number, so a re-run cannot renumber assigned tickets.
with numbered as (
  select id, row_number() over (
    partition by tenant_id order by created_at, id
  ) as rn
  from public.tickets
  where tenant_id is not null
)
update public.tickets t
set number = numbered.rn
from numbered
where t.id = numbered.id
  and t.number is null;

-- Seed each tenant's counter to the highest number already in use.
insert into public.ticket_counters(tenant_id, last_number)
select tenant_id, max(number)
from public.tickets
where tenant_id is not null and number is not null
group by tenant_id
on conflict (tenant_id) do update
  set last_number = greatest(public.ticket_counters.last_number, excluded.last_number);

create or replace function public.set_ticket_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- tenant_id is nullable in the legacy schema; leave those rows unnumbered.
  if new.tenant_id is null then
    return new;
  end if;

  insert into public.ticket_counters(tenant_id, last_number)
  values (new.tenant_id, 1)
  on conflict (tenant_id) do update
    set last_number = public.ticket_counters.last_number + 1
  returning last_number into new.number;

  return new;
end;
$$;

drop trigger if exists tickets_set_number on public.tickets;
create trigger tickets_set_number
  before insert on public.tickets
  for each row execute function public.set_ticket_number();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. status — new fixed set, old data mapped
-- ═══════════════════════════════════════════════════════════════════════════════
-- Drop the baseline check (auto-named tickets_status_check) and any other check
-- on status, except our new one so re-running the migration is safe.
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.tickets'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
      and conname not in ('tickets_status_v2_check', 'tickets_priority_check')
  loop
    execute format('alter table public.tickets drop constraint %I', c.conname);
  end loop;
end
$$;

alter table public.tickets drop constraint if exists tickets_status_v2_check;

update public.tickets set status = 'todo' where status = 'open';
update public.tickets set status = 'waiting_on_customer' where status = 'pending';
update public.tickets set status = 'todo' where status is null;

alter table public.tickets alter column status set default 'triage';
alter table public.tickets alter column status set not null;

alter table public.tickets
  add constraint tickets_status_v2_check
  check (status in (
    'triage', 'todo', 'in_progress', 'waiting_on_customer',
    'waiting_on_approval', 'resolved', 'canceled', 'duplicate'
  ));

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. priority — Linear-style, backfilled from triage_urgency
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.tickets add column if not exists priority text;

update public.tickets
set priority = case triage_urgency
  when 'critical' then 'urgent'
  when 'high'     then 'high'
  when 'medium'   then 'medium'
  when 'low'      then 'low'
  else 'none'
end
where priority is null;

alter table public.tickets alter column priority set default 'none';
alter table public.tickets alter column priority set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tickets'::regclass
      and conname = 'tickets_priority_check'
  ) then
    alter table public.tickets
      add constraint tickets_priority_check
      check (priority in ('none', 'low', 'medium', 'high', 'urgent'));
  end if;
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. assigned_to -> owner_id (FK to auth.users, ON DELETE SET NULL)
-- ═══════════════════════════════════════════════════════════════════════════════
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tickets'
      and column_name = 'assigned_to'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tickets'
      and column_name = 'owner_id'
  ) then
    alter table public.tickets rename column assigned_to to owner_id;
  end if;
end
$$;

-- Null out owners that no longer exist in auth.users before adding the FK.
update public.tickets t
set owner_id = null
where t.owner_id is not null
  and not exists (select 1 from auth.users u where u.id = t.owner_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tickets'::regclass
      and conname = 'tickets_owner_id_fkey'
  ) then
    alter table public.tickets
      add constraint tickets_owner_id_fkey
      foreign key (owner_id) references auth.users(id) on delete set null;
  end if;
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. New ticket columns
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.tickets add column if not exists title text;
alter table public.tickets add column if not exists agent_delegated boolean not null default false;
alter table public.tickets add column if not exists duplicate_of uuid;
alter table public.tickets add column if not exists snoozed_until timestamptz;
alter table public.tickets add column if not exists snooze_until_reply boolean not null default false;
alter table public.tickets add column if not exists decline_kind text;
alter table public.tickets add column if not exists accepted_at timestamptz;
alter table public.tickets add column if not exists first_response_at timestamptz;
alter table public.tickets add column if not exists resolved_at timestamptz;
alter table public.tickets add column if not exists closed_at timestamptz;

update public.tickets set title = subject where title is null and subject is not null;

-- Already-resolved rows: use updated_at as the best-known resolution time.
update public.tickets
set resolved_at = updated_at, closed_at = updated_at
where status = 'resolved' and resolved_at is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tickets'::regclass
      and conname = 'tickets_duplicate_of_fkey'
  ) then
    alter table public.tickets
      add constraint tickets_duplicate_of_fkey
      foreign key (duplicate_of) references public.tickets(id) on delete set null;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tickets'::regclass
      and conname = 'tickets_decline_kind_check'
  ) then
    alter table public.tickets
      add constraint tickets_decline_kind_check
      check (decline_kind in ('spam', 'not_actionable'));
  end if;
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. Indexes
-- ═══════════════════════════════════════════════════════════════════════════════
create index if not exists tickets_tenant_status_priority_idx
  on public.tickets(tenant_id, status, priority);
create index if not exists tickets_tenant_owner_idx
  on public.tickets(tenant_id, owner_id);
create index if not exists tickets_snoozed_until_idx
  on public.tickets(snoozed_until) where snoozed_until is not null;

alter table public.tickets enable trigger tickets_updated_at;
