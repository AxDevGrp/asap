-- Local-only fixture for scripts/decision-report.mjs (ASAP-10).
-- Requires `supabase db reset` first so migrations and supabase/seed.sql (goasap)
-- are applied. Load with:
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -v ON_ERROR_STOP=1 -f scripts/fixtures/decision-report-fixture.sql
--
-- Creates 60 fixture tickets for goasap with latest triage decision rows for
-- both engines (plus a few stale JEV retries) and human outcomes: 44 accepted,
-- 12 declined as spam, 4 as not_actionable. Re-running replaces the fixture.

begin;

do $$
declare
  v_tenant uuid;
  v_ticket uuid;
  v_labels text[] := array['account', 'billing', 'bug', 'feature request', 'question', 'refund', 'shipping'];
  v_types text[] := array['bug', 'feature_request', 'question', 'billing', 'account', 'other'];
  v_priorities text[] := array['low', 'medium', 'high', 'urgent'];
  v_type_criteria jsonb := jsonb_build_object(
    'bug', 'something is broken or not working as expected',
    'feature_request', 'asks for new functionality or an improvement',
    'question', 'asks how something works or needs information',
    'billing', 'payments, invoices, refunds or subscription charges',
    'account', 'login, access, settings or account changes',
    'other', 'none of the above'
  );
  v_questions jsonb;
  v_label_questions jsonb;
  v_jev_label_answers jsonb;
  v_llm_label_answers jsonb;
  v_jev_type_probs jsonb;
  v_llm_type_probs jsonb;
  v_jev_priority_probs jsonb;
  v_llm_priority_probs jsonb;
  v_type text;
  n int;
  i int;
  v_spam boolean;
  v_not_actionable boolean;
  v_accepted boolean;
  v_status text;
  v_decline text;
  v_priority text;
  v_priority_idx int;
  v_jev_priority_idx int;
  v_llm_priority_idx int;
  v_jev_type text;
  v_llm_type text;
  v_jev_spam numeric;
  v_llm_spam numeric;
  v_jev_needs_human numeric;
  v_llm_needs_human numeric;
  v_truth_labels text[];
  v_jev_label_prob numeric;
  v_llm_label_prob numeric;
begin
  select id into v_tenant from public.tenants where slug = 'goasap';
  if v_tenant is null then
    raise exception 'goasap tenant missing; run supabase db reset first';
  end if;

  delete from public.decision_log
  where ticket_id in (
    select id from public.tickets
    where tenant_id = v_tenant and subject like 'ASAP-10 fixture%'
  );
  delete from public.ticket_events
  where ticket_id in (
    select id from public.tickets
    where tenant_id = v_tenant and subject like 'ASAP-10 fixture%'
  );
  delete from public.tickets
  where tenant_id = v_tenant and subject like 'ASAP-10 fixture%';

  for n in 1..60 loop
    v_spam := (n % 5 = 0);
    v_not_actionable := (n % 13 = 0);
    v_accepted := not v_spam and not v_not_actionable;
    v_status := case
      when v_accepted then (case when n % 6 = 0 then 'in_progress' else 'todo' end)
      else 'canceled'
    end;
    v_decline := case
      when v_spam then 'spam'
      when v_not_actionable then 'not_actionable'
      else null
    end;

    if v_accepted and n % 19 <> 0 then
      v_priority_idx := n % 4;
      v_priority := v_priorities[v_priority_idx + 1];
    else
      v_priority_idx := null;
      v_priority := 'none';
    end if;

    if v_priority_idx is null then
      v_jev_priority_idx := 1;
      v_llm_priority_idx := 2;
    else
      v_jev_priority_idx := v_priority_idx;
      if n in (2, 14, 46) then
        v_jev_priority_idx := (v_priority_idx + 1) % 4;
      end if;
      v_llm_priority_idx := v_priority_idx;
      if n in (2, 6, 14, 18, 22, 34, 42, 46, 58) then
        v_llm_priority_idx := (v_priority_idx + 1) % 4;
      end if;
    end if;

    v_jev_type := v_types[(n % 6) + 1];
    v_llm_type := v_jev_type;
    if n % 7 = 0 then
      v_llm_type := 'other';
    end if;

    v_jev_type_probs := '{}'::jsonb;
    v_llm_type_probs := '{}'::jsonb;
    foreach v_type in array v_types loop
      v_jev_type_probs := v_jev_type_probs || jsonb_build_object(
        v_type, case when v_type = v_jev_type then 0.86 else 0.028 end
      );
      v_llm_type_probs := v_llm_type_probs || jsonb_build_object(
        v_type, case when v_type = v_llm_type then 0.86 else 0.028 end
      );
    end loop;

    v_jev_priority_probs := jsonb_build_array(
      case when v_jev_priority_idx = 0 then 0.8 else 0.067 end,
      case when v_jev_priority_idx = 1 then 0.8 else 0.067 end,
      case when v_jev_priority_idx = 2 then 0.8 else 0.067 end,
      case when v_jev_priority_idx = 3 then 0.8 else 0.066 end
    );
    v_llm_priority_probs := jsonb_build_array(
      case when v_llm_priority_idx = 0 then 0.8 else 0.067 end,
      case when v_llm_priority_idx = 1 then 0.8 else 0.067 end,
      case when v_llm_priority_idx = 2 then 0.8 else 0.067 end,
      case when v_llm_priority_idx = 3 then 0.8 else 0.066 end
    );

    if v_spam then
      v_jev_spam := case when n in (20, 45) then 0.82 else 0.96 end;
      v_llm_spam := case when n in (10, 25, 55) then 0.8 else 0.97 end;
    else
      v_jev_spam := case
        when n in (7, 33) then 0.55
        when n = 52 then 0.91
        else 0.05 + (n % 5) * 0.01
      end;
      v_llm_spam := case
        when n in (7, 33) then 0.6
        else 0.1 + (n % 7) * 0.01
      end;
    end if;

    v_jev_needs_human := 0.15 + (n % 8) * 0.09;
    v_llm_needs_human := 0.1 + (n % 6) * 0.07;

    if v_accepted then
      if n % 11 = 0 then
        v_truth_labels := array[]::text[];
      elsif n % 3 = 0 then
        v_truth_labels := array['billing'];
      elsif n % 3 = 1 then
        v_truth_labels := array['bug', 'question'];
      else
        v_truth_labels := array['question'];
      end if;
    else
      v_truth_labels := array[]::text[];
    end if;

    v_label_questions := '{}'::jsonb;
    v_jev_label_answers := '{}'::jsonb;
    v_llm_label_answers := '{}'::jsonb;
    for i in 1..array_length(v_labels, 1) loop
      v_label_questions := v_label_questions || jsonb_build_object(
        'label_' || (i - 1),
        jsonb_build_object(
          'type', 'noul',
          'instructions', format('Does the label "%s" apply?', v_labels[i])
        )
      );

      if v_labels[i] = any(v_truth_labels) then
        v_jev_label_prob := 0.78 + ((n + i) % 5) * 0.04;
        v_llm_label_prob := 0.7 + ((n + i) % 4) * 0.05;
      else
        v_jev_label_prob := case
          when (n * 7 + i) % 9 = 0 then 0.62
          else 0.03 + ((n + i) % 9) * 0.03
        end;
        v_llm_label_prob := case
          when (n + i) % 8 = 0 then 0.56
          else 0.05 + ((n + i) % 7) * 0.05
        end;
      end if;

      v_jev_label_answers := v_jev_label_answers || jsonb_build_object(
        'label_' || (i - 1),
        jsonb_build_object('type', 'noul', 'probability', v_jev_label_prob)
      );
      v_llm_label_answers := v_llm_label_answers || jsonb_build_object(
        'label_' || (i - 1),
        jsonb_build_object('type', 'noul', 'probability', v_llm_label_prob)
      );
    end loop;

    v_questions := jsonb_build_object(
      'type', jsonb_build_object(
        'type', 'choice',
        'criteria', v_type_criteria,
        'instructions', 'Pick the single best category for the request.'
      ),
      'priority', jsonb_build_object(
        'type', 'score',
        'criteria', jsonb_build_array('low', 'medium', 'high', 'urgent'),
        'instructions', 'How urgent is this request?'
      ),
      'is_spam', jsonb_build_object(
        'type', 'noul',
        'instructions', 'Is this unsolicited marketing, phishing, automated junk, or otherwise not a real support request?'
      ),
      'needs_human', jsonb_build_object(
        'type', 'noul',
        'instructions', 'Does fulfilling this request require a money movement, legal/safety issue, or account change?'
      )
    ) || v_label_questions;

    insert into public.tickets (
      tenant_id, subject, title, body, status, priority, decline_kind, accepted_at
    )
    values (
      v_tenant,
      format('ASAP-10 fixture %s', n),
      format('ASAP-10 fixture ticket %s', n),
      'Fixture ticket for the decision report. No customer content.',
      v_status,
      v_priority,
      v_decline,
      case when v_accepted then now() - interval '1 day' else null end
    )
    returning id into v_ticket;

    if cardinality(v_truth_labels) > 0 then
      insert into public.ticket_labels (ticket_id, label_id, added_by_type)
      select v_ticket, l.id, 'user'
      from public.labels l
      where l.tenant_id = v_tenant and l.name = any(v_truth_labels);
    end if;

    if v_accepted then
      insert into public.ticket_events (
        tenant_id, ticket_id, kind, actor_type, from_value, to_value, created_at
      )
      values (
        v_tenant, v_ticket, 'accepted', 'user', 'triage', v_status, now() - interval '1 day'
      );
      if v_priority <> 'none' then
        insert into public.ticket_events (
          tenant_id, ticket_id, kind, actor_type, from_value, to_value, created_at
        )
        values (
          v_tenant, v_ticket, 'priority_changed', 'user', 'none', v_priority, now() - interval '1 day'
        );
      end if;
    else
      insert into public.ticket_events (
        tenant_id, ticket_id, kind, actor_type, from_value, to_value, data, created_at
      )
      values (
        v_tenant, v_ticket, 'declined', 'user', 'triage', 'canceled',
        jsonb_build_object('decline_kind', v_decline), now() - interval '1 day'
      );
    end if;

    insert into public.decision_log (
      tenant_id, ticket_id, purpose, engine, model, questions, answers,
      latency_ms, cost_usd, created_at
    )
    values (
      v_tenant, v_ticket, 'triage', 'jev', 'typesafe/jev-1.14', v_questions,
      jsonb_build_object(
        'type', jsonb_build_object(
          'type', 'choice', 'choice', v_jev_type, 'probabilities', v_jev_type_probs
        ),
        'priority', jsonb_build_object(
          'type', 'score',
          'score', v_jev_priority_idx,
          'level', v_jev_priority_idx,
          'label', v_priorities[v_jev_priority_idx + 1],
          'probabilities', v_jev_priority_probs
        ),
        'is_spam', jsonb_build_object('type', 'noul', 'probability', v_jev_spam),
        'needs_human', jsonb_build_object('type', 'noul', 'probability', v_jev_needs_human)
      ) || v_jev_label_answers,
      40 + (n % 20),
      0.00002 + n * 0.0000001,
      now() - interval '2 hours' + (n || ' seconds')::interval
    );

    insert into public.decision_log (
      tenant_id, ticket_id, purpose, engine, model, questions, answers,
      latency_ms, cost_usd, created_at
    )
    values (
      v_tenant, v_ticket, 'triage', 'llm', 'google/gemma-4-26b-a4b-it', v_questions,
      jsonb_build_object(
        'type', jsonb_build_object(
          'type', 'choice', 'choice', v_llm_type, 'probabilities', v_llm_type_probs
        ),
        'priority', jsonb_build_object(
          'type', 'score',
          'score', v_llm_priority_idx,
          'level', v_llm_priority_idx,
          'label', v_priorities[v_llm_priority_idx + 1],
          'probabilities', v_llm_priority_probs
        ),
        'is_spam', jsonb_build_object('type', 'noul', 'probability', v_llm_spam),
        'needs_human', jsonb_build_object('type', 'noul', 'probability', v_llm_needs_human)
      ) || v_llm_label_answers,
      150 + (n % 60),
      0,
      now() - interval '90 minutes' + (n || ' seconds')::interval
    );

    if n in (10, 20, 30) then
      insert into public.decision_log (
        tenant_id, ticket_id, purpose, engine, model, questions, answers,
        latency_ms, cost_usd, created_at
      )
      values (
        v_tenant, v_ticket, 'triage', 'jev', 'typesafe/jev-1.14', v_questions,
        jsonb_build_object(
          'type', jsonb_build_object(
            'type', 'choice', 'choice', 'other', 'probabilities', v_jev_type_probs
          ),
          'priority', jsonb_build_object(
            'type', 'score', 'score', 0, 'level', 0, 'label', 'low',
            'probabilities', v_jev_priority_probs
          ),
          'is_spam', jsonb_build_object('type', 'noul', 'probability', 0.01),
          'needs_human', jsonb_build_object('type', 'noul', 'probability', 0.01)
        ) || v_jev_label_answers,
        999,
        0.01,
        now() - interval '4 hours'
      );
    end if;
  end loop;
end
$$;

commit;
