#!/usr/bin/env node
// Local/dev job poller. Calls the job runner every JOBS_POLL_INTERVAL_MS so the
// queue drains during development without a real scheduler.
//
// Usage:
//   node --env-file=.env.local scripts/run-jobs.mjs
//
// Requires: APP_URL, JOBS_SECRET (or CRON_SECRET).
// Optional: JOBS_POLL_INTERVAL_MS (default 5000).

const APP_URL = process.env.APP_URL;
const SECRET = process.env.JOBS_SECRET ?? process.env.CRON_SECRET;
const INTERVAL_MS = Number(process.env.JOBS_POLL_INTERVAL_MS ?? 5000);

if (!APP_URL) {
  console.error('Missing APP_URL. Run with: node --env-file=.env.local scripts/run-jobs.mjs');
  process.exit(1);
}
if (!SECRET) {
  console.error('Missing JOBS_SECRET (or CRON_SECRET).');
  process.exit(1);
}

const endpoint = `${APP_URL.replace(/\/$/, '')}/api/jobs/run`;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[jobs] ${res.status}:`, body);
    } else {
      const { claimed = 0, succeeded = 0, failed = 0, dead = 0 } = body;
      if (claimed > 0) {
        console.log(
          `[jobs] claimed ${claimed}, succeeded ${succeeded}, failed ${failed}, dead ${dead}`
        );
      }
    }
  } catch (err) {
    console.error('[jobs] request failed:', err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}

tick();
console.log(`[jobs] polling ${endpoint} every ${INTERVAL_MS}ms`);
setInterval(tick, INTERVAL_MS);