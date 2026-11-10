-- ASAP — Per-minute job runner trigger from inside Supabase (pg_cron + pg_net)
--
-- Calls POST {app_url}/api/jobs/run every minute so queued jobs (AI pipeline)
-- run even when the webhook's immediate kick is lost. Works on any host,
-- including Vercel Hobby (whose own cron is limited to once a day).
--
-- The URL and secret are NOT in this file. Store them once in Supabase Vault
-- (SQL editor, or psql) — the job does nothing until both exist:
--
--   select vault.create_secret('https://your-app.vercel.app', 'asap_app_url');
--   select vault.create_secret('<same value as JOBS_SECRET>', 'asap_jobs_secret');
--
-- To change a value later: select vault.update_secret(id, 'new value')
--   (id from: select id, name from vault.secrets).
-- To stop it: select cron.unschedule('asap-run-jobs');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'asap-run-jobs',
  '* * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'asap_app_url') || '/api/jobs/run',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'asap_jobs_secret'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    )
    where exists (select 1 from vault.decrypted_secrets where name = 'asap_app_url')
      and exists (select 1 from vault.decrypted_secrets where name = 'asap_jobs_secret');
  $job$
);
