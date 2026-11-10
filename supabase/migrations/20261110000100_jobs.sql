-- ASAP — Durable background job queue
--
-- Postgres-backed job queue so slow work (the AI inbound-email pipeline) runs
-- outside the inbound webhook request. Vendor-neutral: any scheduler that can
-- call POST /api/jobs/run (Vercel Cron, Supabase pg_cron + pg_net, external
-- cron, or scripts/run-jobs.mjs locally) drains the queue.
--
-- Service-role only: RLS enabled, no policies for anon/authenticated.

-- ── jobs ─────────────────────────────────────────────────────────────────────
create table if not exists jobs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid references tenants(id) on delete cascade,
  type         text not null,
  payload      jsonb not null default '{}',
  status       text not null default 'queued'
                 check (status in ('queued', 'running', 'succeeded', 'failed', 'dead')),
  attempts     int not null default 0,
  max_attempts int not null default 5,
  run_at       timestamptz not null default now(),
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  dedupe_key   text unique,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists jobs_status_run_at_idx on jobs(status, run_at);

drop trigger if exists jobs_updated_at on jobs;
create trigger jobs_updated_at
  before update on jobs
  for each row execute function update_updated_at();

alter table jobs enable row level security;
-- No policies: only service_role (which bypasses RLS) may touch the queue.

-- ── claim_jobs ───────────────────────────────────────────────────────────────
-- Atomically claim up to p_limit due jobs for a worker. Also reclaims jobs
-- whose worker went away (status 'running' but locked_at is older than
-- p_stale_after). Stale jobs that have already used all their attempts are
-- marked 'dead' instead of being reclaimed forever. FOR UPDATE SKIP LOCKED
-- makes concurrent workers safe.
create or replace function public.claim_jobs(
  p_worker      text,
  p_limit       int default 5,
  p_stale_after interval default '10 minutes'
)
returns setof jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Bury stale running jobs that have no attempts left (process was killed).
  update jobs
  set
    status     = 'dead',
    locked_at  = null,
    locked_by  = null,
    last_error = 'stale lock: max attempts exhausted'
  where status = 'running'
    and locked_at < now() - p_stale_after
    and attempts >= max_attempts;

  return query
  with claimed as (
    select j.id
    from jobs j
    where (
        (j.status in ('queued', 'failed') and j.run_at <= now())
        or
        (j.status = 'running' and j.locked_at < now() - p_stale_after
          and j.attempts < j.max_attempts)
      )
    order by j.run_at asc
    limit p_limit
    for update skip locked
  )
  update jobs j
  set
    status    = 'running',
    locked_at = now(),
    locked_by = p_worker,
    attempts  = j.attempts + 1
  from claimed
  where j.id = claimed.id
  returning j.*;
end;
$$;

revoke all on function public.claim_jobs(text, int, interval) from public, anon, authenticated;

-- ── outbound_messages.idempotency_key ────────────────────────────────────────
-- Lets senders deduplicate outbound email (nullable, unique when set).
alter table outbound_messages add column if not exists idempotency_key text;

create unique index if not exists outbound_messages_idempotency_key_idx
  on outbound_messages(idempotency_key)
  where idempotency_key is not null;
