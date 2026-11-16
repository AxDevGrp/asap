-- ASAP-4 · Ticket events timeline
--
-- Immutable per-ticket timeline rows. Every status/priority/owner/delegation
-- change (and future kinds such as comments, merges, SLA and contact notices)
-- is recorded here. Safe to re-run (idempotent DDL).

create table if not exists public.ticket_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  ticket_id   uuid not null references public.tickets(id) on delete cascade,
  kind        text not null check (kind in (
    'created', 'status_changed', 'priority_changed', 'owner_changed',
    'label_added', 'label_removed', 'merged', 'snoozed', 'unsnoozed',
    'declined', 'accepted', 'reopened', 'agent_delegated',
    'agent_undelegated', 'comment_added', 'sla_at_risk', 'sla_breached',
    'contact_notified'
  )),
  actor_type  text not null check (actor_type in ('user', 'agent', 'system', 'rule')),
  actor_id    uuid,
  from_value  text,
  to_value    text,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists ticket_events_ticket_created_idx
  on public.ticket_events(ticket_id, created_at);

alter table public.ticket_events enable row level security;

drop policy if exists "service full access ticket_events" on public.ticket_events;
create policy "service full access ticket_events" on public.ticket_events
  for all to service_role using (true);

drop policy if exists "tenant_members_read_ticket_events" on public.ticket_events;
create policy "tenant_members_read_ticket_events" on public.ticket_events
  for select to authenticated
  using (
    tenant_id in (
      select tenant_id from public.tenant_memberships
      where user_id = auth.uid() and role in ('owner', 'admin', 'agent')
    )
  );
