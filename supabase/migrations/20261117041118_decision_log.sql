-- ASAP-8 · decision_log — one row per decisions client call.
--
-- Records typed JEV/LLM decisions without customer content beyond the question
-- definitions: `questions` holds only the question schema, never the state text.
-- tenant_id is nullable because ad-hoc / live calls have no tenant. Safe to
-- re-run (idempotent DDL).

create table if not exists public.decision_log (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references public.tenants(id) on delete cascade,
  ticket_id   uuid references public.tickets(id) on delete set null,
  purpose     text not null,
  engine      text not null check (engine in ('jev', 'llm')),
  model       text,
  questions   jsonb not null,
  answers     jsonb,
  latency_ms  int,
  cost_usd    numeric(12,8),
  error       text,
  created_at  timestamptz not null default now()
);

create index if not exists decision_log_tenant_created_idx
  on public.decision_log(tenant_id, created_at desc);

create index if not exists decision_log_ticket_idx
  on public.decision_log(ticket_id);

create index if not exists decision_log_purpose_created_idx
  on public.decision_log(purpose, created_at);

alter table public.decision_log enable row level security;

drop policy if exists "service full access decision_log" on public.decision_log;
create policy "service full access decision_log" on public.decision_log
  for all to service_role using (true);

-- Members see their tenant's rows; null-tenant rows stay invisible to members.
drop policy if exists "tenant_members_read_decision_log" on public.decision_log;
create policy "tenant_members_read_decision_log" on public.decision_log
  for select to authenticated
  using (
    tenant_id in (
      select tenant_id from public.tenant_memberships
      where user_id = auth.uid() and role in ('owner', 'admin', 'agent')
    )
  );
