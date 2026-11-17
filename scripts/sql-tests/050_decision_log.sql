-- 050_decision_log.sql — decision_log constraints and tenant-scoped RLS.
-- Runs inside a transaction and rolls back, so it leaves no data behind.

begin;

do $$
declare
  ta uuid;
  tb uuid;
  t1 uuid;
  t2 uuid;
  rejected boolean;
begin
  insert into public.tenants (name, slug, domain)
  values ('ASAP-8 Tenant A', 'asap8-a-050', 'a050.test')
  returning id into ta;

  insert into public.tenants (name, slug, domain)
  values ('ASAP-8 Tenant B', 'asap8-b-050', 'b050.test')
  returning id into tb;

  insert into public.tickets (tenant_id, subject)
  values (ta, 'tenant A ticket') returning id into t1;
  insert into public.tickets (tenant_id, subject)
  values (tb, 'tenant B ticket') returning id into t2;

  insert into public.decision_log (tenant_id, ticket_id, purpose, engine, model, questions, answers, latency_ms, cost_usd)
  values
    (ta, t1, 'triage', 'jev', 'typesafe/jev-1.14', '{"type":{"type":"choice"}}', '{"type":"bug"}', 42, 0.00001642),
    (ta, null, 'triage', 'llm', 'google/gemma-4-26b-a4b-it', '{"type":{"type":"choice"}}', null, 80, 0),
    (tb, t2, 'triage', 'jev', 'typesafe/jev-1.14', '{"type":{"type":"choice"}}', '{"type":"billing"}', 51, 0.00002),
    (null, null, 'adhoc', 'llm', null, '{"is_spam":{"type":"noul"}}', '{"is_spam":0.1}', 65, 0);

  -- engine check rejects an unknown value.
  rejected := false;
  begin
    insert into public.decision_log (purpose, engine, questions)
    values ('triage', 'magic', '{}');
  exception when check_violation then
    rejected := true;
  end;
  if not rejected then
    raise exception 'decision_log accepted an invalid engine';
  end if;

  -- questions is required.
  rejected := false;
  begin
    insert into public.decision_log (purpose, engine)
    values ('triage', 'jev');
  exception when not_null_violation then
    rejected := true;
  end;
  if not rejected then
    raise exception 'decision_log accepted a null questions column';
  end if;
end
$$;

-- ── anon sees nothing ────────────────────────────────────────────────────────
set local role anon;
do $$
declare
  c int;
begin
  select count(*) into c from public.decision_log;
  if c <> 0 then
    raise exception 'anon saw % decision_log rows, expected 0', c;
  end if;
end
$$;
reset role;

-- ── authenticated member of tenant A sees only A rows ────────────────────────
insert into auth.users (id, email)
values ('00000000-0000-0000-0000-0000000000c1', 'rls-050@example.test');

insert into public.tenant_memberships (user_id, tenant_id, role)
select '00000000-0000-0000-0000-0000000000c1'::uuid, id, 'agent'
from public.tenants
where slug = 'asap8-a-050';

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';

do $$
declare
  c int;
begin
  select count(*) into c from public.decision_log;
  if c <> 2 then
    raise exception 'member saw % decision_log rows, expected 2', c;
  end if;

  select count(*) into c
  from public.decision_log d
  join public.tenants t on t.id = d.tenant_id
  where t.slug = 'asap8-b-050';
  if c <> 0 then
    raise exception 'member saw % tenant B decision_log rows, expected 0', c;
  end if;

  select count(*) into c from public.decision_log where tenant_id is null;
  if c <> 0 then
    raise exception 'member saw % null-tenant decision_log rows, expected 0', c;
  end if;
end
$$;
reset role;

rollback;
