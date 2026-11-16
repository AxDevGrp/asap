-- 010_ticket_model_v2.sql — ticket numbering, prefixes, status/priority and RLS.
-- Runs inside a transaction and rolls back, so it leaves no data behind.

begin;

-- ── Numbering, prefix, status and priority ───────────────────────────────────
do $$
declare
  ta uuid;
  tb uuid;
  t1 uuid;
  t2 uuid;
  t3 uuid;
  n1 int;
  n2 int;
  n3 int;
  p text;
  prefix text;
  rejected boolean := false;
begin
  insert into public.tenants (name, slug, domain)
  values ('ASAP-3 Tenant A', 'asap3-a-010', 'a010.test')
  returning id, ticket_prefix into ta, prefix;

  if prefix is null or prefix !~ '^[A-Z]{2,6}$' then
    raise exception 'tenant A prefix invalid: %', prefix;
  end if;

  insert into public.tenants (name, slug, domain)
  values ('ASAP-3 Tenant B', 'asap3-b-010', 'b010.test')
  returning id into tb;

  insert into public.tickets (tenant_id, subject) values (ta, 'first') returning id into t1;
  insert into public.tickets (tenant_id, subject) values (ta, 'second') returning id into t2;
  insert into public.tickets (tenant_id, subject) values (tb, 'other tenant') returning id into t3;

  select number into n1 from public.tickets where id = t1;
  select number into n2 from public.tickets where id = t2;
  select number into n3 from public.tickets where id = t3;

  if (n1, n2, n3) is distinct from (1, 2, 1) then
    raise exception 'numbering wrong: tenant A (%, %), tenant B (%)', n1, n2, n3;
  end if;

  select priority into p from public.tickets where id = t1;
  if p is distinct from 'none' then
    raise exception 'default priority should be none, got %', p;
  end if;

  -- The legacy status value is no longer accepted by the new check constraint.
  begin
    insert into public.tickets (tenant_id, subject, status)
    values (ta, 'legacy status', 'open');
  exception when check_violation then
    rejected := true;
  end;

  if not rejected then
    raise exception 'status ''open'' was accepted but should violate the check';
  end if;

  -- Seeded tenant keeps its derived prefix.
  select ticket_prefix into prefix from public.tenants where slug = 'goasap';
  if prefix is distinct from 'GOA' then
    raise exception 'goasap prefix should be GOA, got %', prefix;
  end if;

  -- A tenant inserted without a prefix gets one from the slug.
  insert into public.tenants (name, slug, domain)
  values ('Brand New', 'brandnewco', 'brandnew010.test')
  returning ticket_prefix into prefix;

  if prefix is null or prefix !~ '^[A-Z]{2,6}$' then
    raise exception 'derived prefix invalid: %', prefix;
  end if;
end
$$;

-- ── RLS on ticket_counters ───────────────────────────────────────────────────
insert into auth.users (id, email)
values ('00000000-0000-0000-0000-0000000000a1', 'rls-010@example.test');

insert into public.tenant_memberships (user_id, tenant_id, role)
select '00000000-0000-0000-0000-0000000000a1'::uuid, id, 'agent'
from public.tenants
where slug = 'asap3-a-010';

set local role anon;
do $$
declare
  c int;
begin
  select count(*) into c from public.ticket_counters;
  if c <> 0 then
    raise exception 'anon saw % ticket_counters rows, expected 0', c;
  end if;
end
$$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

do $$
declare
  c int;
begin
  select count(*) into c from public.ticket_counters;
  if c <> 1 then
    raise exception 'member saw % ticket_counters rows, expected 1', c;
  end if;

  select count(*) into c
  from public.ticket_counters tc
  join public.tenants t on t.id = tc.tenant_id
  where t.slug = 'asap3-a-010';
  if c <> 1 then
    raise exception 'member did not see tenant A''s counter';
  end if;
end
$$;
reset role;

rollback;
