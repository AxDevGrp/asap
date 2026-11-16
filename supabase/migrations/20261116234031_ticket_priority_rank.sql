-- ASAP-7 · Ticket priority rank
--
-- PostgREST cannot order by a CASE expression, so expose priority as a stored
-- generated smallint that lists can sort on directly. Also add the keyset
-- pagination index for (tenant_id, updated_at, id). Safe to re-run.

alter table public.tickets
  add column if not exists priority_rank smallint
  generated always as (
    case priority
      when 'urgent' then 4
      when 'high'   then 3
      when 'medium' then 2
      when 'low'    then 1
      else 0
    end
  ) stored;

create index if not exists tickets_tenant_priority_rank_idx
  on public.tickets(tenant_id, priority_rank, id);

create index if not exists tickets_tenant_updated_at_id_idx
  on public.tickets(tenant_id, updated_at, id);
