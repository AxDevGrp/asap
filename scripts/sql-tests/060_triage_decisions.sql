-- 060_triage_decisions.sql — ASAP-9 decision mode/thresholds + AI suggestion columns.
-- Runs inside a transaction and rolls back, so it leaves no data behind.

begin;

do $$
declare
  t uuid;
  tid uuid;
  mode text;
  thresholds jsonb;
  rejected boolean;
begin
  insert into public.tenants (name, slug, domain)
  values ('ASAP-9 Tenant', 'asap9-060', 't060.test')
  returning id into t;

  -- A new tenant's policy row gets the shadow default + default thresholds.
  select decision_mode, decision_thresholds
    into mode, thresholds
  from public.tenant_policies
  where tenant_id = t;

  if mode is distinct from 'shadow' then
    raise exception 'default decision_mode was %, expected shadow', mode;
  end if;

  if thresholds is null
     or thresholds->>'spam_auto_decline' is distinct from '0.95'
     or thresholds->>'label_suggest' is distinct from '0.7'
     or thresholds->>'needs_human' is distinct from '0.5' then
    raise exception 'unexpected default decision_thresholds: %', thresholds;
  end if;

  -- An unknown decision_mode is rejected.
  rejected := false;
  begin
    update public.tenant_policies set decision_mode = 'magic' where tenant_id = t;
  exception when check_violation then
    rejected := true;
  end;
  if not rejected then
    raise exception 'tenant_policies accepted decision_mode = magic';
  end if;

  insert into public.tickets (tenant_id, subject)
  values (t, 'probabilities') returning id into tid;

  -- A probability above 1 is rejected.
  rejected := false;
  begin
    update public.tickets set ai_spam_probability = 1.5 where id = tid;
  exception when check_violation then
    rejected := true;
  end;
  if not rejected then
    raise exception 'tickets accepted ai_spam_probability = 1.5';
  end if;

  -- A valid probability is accepted.
  update public.tickets set ai_spam_probability = 0.912 where id = tid;

  -- An unknown ai_suggested_priority is rejected.
  rejected := false;
  begin
    update public.tickets set ai_suggested_priority = 'blocker' where id = tid;
  exception when check_violation then
    rejected := true;
  end;
  if not rejected then
    raise exception 'tickets accepted ai_suggested_priority = blocker';
  end if;
end
$$;

rollback;
