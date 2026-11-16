-- 020_ticket_events.sql — ticket_events checks and tenant-scoped RLS.
-- Runs inside a transaction and rolls back, so it leaves no data behind.

begin;

-- ── Check constraints ────────────────────────────────────────────────────────
do $$
declare
  ta uuid;
  tb uuid;
  t1 uuid;
  t2 uuid;
  rejected boolean;
begin
  insert into public.tenants (name, slug, domain)
  values ('ASAP-4 Tenant A', 'asap4-a-020', 'a020.test')
  returning id into ta;

  insert into public.tenants (name, slug, domain)
  values ('ASAP-4 Tenant B', 'asap4-b-020', 'b020.test')
  returning id into tb;

  insert into public.tickets (tenant_id, subject)
  values (ta, 'tenant A ticket') returning id into t1;
  insert into public.tickets (tenant_id, subject)
  values (tb, 'tenant B ticket') returning id into t2;

  insert into public.ticket_events (tenant_id, ticket_id, kind, actor_type, data)
  values (ta, t1, 'created', 'system', '{"source":"webhook"}');
  insert into public.ticket_events (tenant_id, ticket_id, kind, actor_type)
  values (ta, t1, 'status_changed', 'rule');
  insert into public.ticket_events (tenant_id, ticket_id, kind, actor_type)
  values (tb, t2, 'created', 'user');

  rejected := false;
  begin
    insert into public.ticket_events (tenant_id, ticket_id, kind, actor_type)
    values (ta, t1, 'not_a_kind', 'system');
  exception when check_violation then
    rejected := true;
  end;
  if not rejected then
    raise exception 'ticket_events accepted an invalid kind';
  end if;

  rejected := false;
  begin
    insert into public.ticket_events (tenant_id, ticket_id, kind, actor_type)
    values (ta, t1, 'created', 'robot');
  exception when check_violation then
    rejected := true;
  end;
  if not rejected then
    raise exception 'ticket_events accepted an invalid actor_type';
  end if;

  rejected := false;
  begin
    insert into public.ticket_events (tenant_id, ticket_id, kind, actor_type)
    values (ta, t1, 'created', 'system');
    insert into public.ticket_events (tenant_id, ticket_id, kind, actor_type)
    values (ta, gen_random_uuid(), 'created', 'system');
  exception when foreign_key_violation then
    rejected := true;
  end;
  if not rejected then
    raise exception 'ticket_events accepted a ticket_id with no ticket';
  end if;
end
$$;

-- ── anon sees nothing ────────────────────────────────────────────────────────
set local role anon;
do $$
declare
  c int;
begin
  select count(*) into c from public.ticket_events;
  if c <> 0 then
    raise exception 'anon saw % ticket_events rows, expected 0', c;
  end if;
end
$$;
reset role;

-- ── authenticated member of tenant A sees only tenant A events ───────────────
insert into auth.users (id, email)
values ('00000000-0000-0000-0000-0000000000b1', 'rls-020@example.test');

insert into public.tenant_memberships (user_id, tenant_id, role)
select '00000000-0000-0000-0000-0000000000b1'::uuid, id, 'agent'
from public.tenants
where slug = 'asap4-a-020';

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';

do $$
declare
  c int;
begin
  select count(*) into c from public.ticket_events;
  if c <> 2 then
    raise exception 'member saw % ticket_events rows, expected 2', c;
  end if;

  select count(*) into c
  from public.ticket_events e
  join public.tenants t on t.id = e.tenant_id
  where t.slug = 'asap4-a-020';
  if c <> 2 then
    raise exception 'member did not see all of tenant A''s events';
  end if;

  select count(*) into c
  from public.ticket_events e
  join public.tenants t on t.id = e.tenant_id
  where t.slug = 'asap4-b-020';
  if c <> 0 then
    raise exception 'member saw % tenant B events, expected 0', c;
  end if;
end
$$;
reset role;

rollback;
