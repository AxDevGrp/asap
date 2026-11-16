-- 040_ticket_priority_rank.sql — priority_rank generated column + keyset index.
-- Runs inside a transaction and rolls back, so it leaves no data behind.

begin;

do $$
declare
  ta uuid;
  t_urgent uuid;
  t_high uuid;
  t_medium uuid;
  t_low uuid;
  t_none uuid;
  r smallint;
  ordered text;
  rejected boolean := false;
begin
  insert into public.tenants (name, slug, domain)
  values ('ASAP-7 Tenant A', 'asap7-a-040', 'a040.test')
  returning id into ta;

  insert into public.tickets (tenant_id, subject, priority)
  values (ta, 'urgent', 'urgent') returning id into t_urgent;
  insert into public.tickets (tenant_id, subject, priority)
  values (ta, 'high', 'high') returning id into t_high;
  insert into public.tickets (tenant_id, subject, priority)
  values (ta, 'medium', 'medium') returning id into t_medium;
  insert into public.tickets (tenant_id, subject, priority)
  values (ta, 'low', 'low') returning id into t_low;
  insert into public.tickets (tenant_id, subject, priority)
  values (ta, 'none', 'none') returning id into t_none;

  select priority_rank into r from public.tickets where id = t_urgent;
  if r is distinct from 4 then
    raise exception 'urgent rank = %, expected 4', r;
  end if;

  select priority_rank into r from public.tickets where id = t_high;
  if r is distinct from 3 then
    raise exception 'high rank = %, expected 3', r;
  end if;

  select priority_rank into r from public.tickets where id = t_medium;
  if r is distinct from 2 then
    raise exception 'medium rank = %, expected 2', r;
  end if;

  select priority_rank into r from public.tickets where id = t_low;
  if r is distinct from 1 then
    raise exception 'low rank = %, expected 1', r;
  end if;

  select priority_rank into r from public.tickets where id = t_none;
  if r is distinct from 0 then
    raise exception 'none rank = %, expected 0', r;
  end if;

  -- The rank tracks priority updates.
  update public.tickets set priority = 'urgent' where id = t_low;
  select priority_rank into r from public.tickets where id = t_low;
  if r is distinct from 4 then
    raise exception 'low -> urgent rank = %, expected 4', r;
  end if;

  -- Generated column cannot be written directly.
  begin
    update public.tickets set priority_rank = 9 where id = t_none;
  exception when generated_always then
    rejected := true;
  end;
  if not rejected then
    raise exception 'priority_rank accepted a direct write';
  end if;

  -- Priority ordering is urgent..none (ties broken by id desc).
  select string_agg(subject, ',' order by priority_rank desc, id desc)
  into ordered
  from public.tickets
  where tenant_id = ta;

  if ordered is distinct from 'urgent,low,high,medium,none' then
    raise exception 'priority ordering wrong: %', ordered;
  end if;
end
$$;

do $$
declare
  n int;
begin
  select count(*) into n
  from pg_indexes
  where schemaname = 'public'
    and indexname = 'tickets_tenant_priority_rank_idx';
  if n <> 1 then
    raise exception 'priority rank index missing';
  end if;

  select count(*) into n
  from pg_indexes
  where schemaname = 'public'
    and indexname = 'tickets_tenant_updated_at_id_idx';
  if n <> 1 then
    raise exception 'updated_at keyset index missing';
  end if;
end
$$;

rollback;
