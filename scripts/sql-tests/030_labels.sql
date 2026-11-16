-- 030_labels.sql — default labels, constraints and tenant-scoped RLS.
-- Runs inside a transaction and rolls back, so it leaves no data behind.

begin;

-- ── Defaults, constraints, cross-tenant guard ────────────────────────────────
do $$
declare
  ta uuid;
  tb uuid;
  t1 uuid;
  t2 uuid;
  la uuid;
  lb uuid;
  c int;
  rejected boolean;
begin
  insert into public.tenants (name, slug, domain)
  values ('ASAP-5 Tenant A', 'asap5-a-030', 'a030.test')
  returning id into ta;

  insert into public.tenants (name, slug, domain)
  values ('ASAP-5 Tenant B', 'asap5-b-030', 'b030.test')
  returning id into tb;

  -- New tenants get the seven default labels.
  select count(*) into c from public.labels where tenant_id = ta;
  if c <> 7 then
    raise exception 'new tenant A got % labels, expected 7', c;
  end if;

  select count(*) into c from public.labels where tenant_id = tb;
  if c <> 7 then
    raise exception 'new tenant B got % labels, expected 7', c;
  end if;

  select id into la from public.labels
  where tenant_id = ta and lower(name) = 'bug';
  select id into lb from public.labels
  where tenant_id = tb and lower(name) = 'bug';

  if la is null or lb is null then
    raise exception 'default bug label missing';
  end if;

  -- Case-insensitive duplicate name is rejected.
  rejected := false;
  begin
    insert into public.labels (tenant_id, name) values (ta, 'BUG');
  exception when unique_violation then
    rejected := true;
  end;
  if not rejected then
    raise exception 'labels accepted a case-insensitive duplicate name';
  end if;

  -- Invalid color is rejected.
  rejected := false;
  begin
    insert into public.labels (tenant_id, name, color) values (ta, 'bad color', 'red');
  exception when check_violation then
    rejected := true;
  end;
  if not rejected then
    raise exception 'labels accepted an invalid color';
  end if;

  insert into public.tickets (tenant_id, subject)
  values (ta, 'tenant A ticket') returning id into t1;
  insert into public.tickets (tenant_id, subject)
  values (tb, 'tenant B ticket') returning id into t2;

  insert into public.ticket_labels (ticket_id, label_id, added_by_type)
  values (t1, la, 'user');
  insert into public.ticket_labels (ticket_id, label_id, added_by_type)
  values (t2, lb, 'agent');

  -- A label from another tenant cannot be attached to a ticket.
  rejected := false;
  begin
    insert into public.ticket_labels (ticket_id, label_id, added_by_type)
    values (t2, la, 'user');
  exception when raise_exception then
    rejected := true;
  end;
  if not rejected then
    raise exception 'ticket_labels accepted a label from another tenant';
  end if;
end
$$;

-- ── anon sees nothing ────────────────────────────────────────────────────────
set local role anon;
do $$
declare
  c int;
begin
  select count(*) into c from public.labels;
  if c <> 0 then
    raise exception 'anon saw % labels, expected 0', c;
  end if;

  select count(*) into c from public.ticket_labels;
  if c <> 0 then
    raise exception 'anon saw % ticket_labels rows, expected 0', c;
  end if;
end
$$;
reset role;

-- ── member of tenant B sees only tenant B ────────────────────────────────────
insert into auth.users (id, email)
values ('00000000-0000-0000-0000-0000000000c1', 'rls-030@example.test');

insert into public.tenant_memberships (user_id, tenant_id, role)
select '00000000-0000-0000-0000-0000000000c1'::uuid, id, 'agent'
from public.tenants
where slug = 'asap5-b-030';

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';

do $$
declare
  c int;
begin
  -- Only tenant B's seven labels, never tenant A's.
  select count(*) into c from public.labels;
  if c <> 7 then
    raise exception 'member saw % labels, expected 7', c;
  end if;

  select count(*) into c from public.ticket_labels;
  if c <> 1 then
    raise exception 'member saw % ticket_labels rows, expected 1', c;
  end if;
end
$$;
reset role;

rollback;
