// Durable background job queue (Postgres-backed, vendor-neutral).
// Server-only: uses the service-role client so it bypasses RLS on `jobs`.
//
// Lifecycle: enqueueJob -> claimJobs (atomic, SKIP LOCKED) -> handler ->
// completeJob / failJob (exponential backoff, or dead after max_attempts).

import { createSupabaseAdminClient } from './supabase-server';
import { jobHandlers, type Job } from './job-handlers';

export type { Job } from './job-handlers';

export interface EnqueueJobInput {
  type: string;
  payload: Record<string, unknown>;
  tenantId?: string | null;
  dedupeKey?: string | null;
  runAt?: Date | string;
  maxAttempts?: number;
}

export interface EnqueueJobResult {
  id: string;
  duplicate: boolean;
}

export interface RunDueJobsResult {
  claimed: number;
  succeeded: number;
  failed: number;
  dead: number;
}

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 3_600_000; // 1 hour

function db() {
  return createSupabaseAdminClient();
}

function asJob(row: Record<string, unknown>): Job {
  return row as unknown as Job;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}

/**
 * Insert a job. A duplicate `dedupeKey` returns the existing job id with
 * `duplicate: true` (never throws on conflict). Other errors throw.
 */
export async function enqueueJob(input: EnqueueJobInput): Promise<EnqueueJobResult> {
  const client = db();
  const { data, error } = await client
    .from('jobs')
    .insert({
      type: input.type,
      payload: input.payload,
      tenant_id: input.tenantId ?? null,
      dedupe_key: input.dedupeKey ?? null,
      run_at: input.runAt
        ? new Date(input.runAt).toISOString()
        : new Date().toISOString(),
      max_attempts: input.maxAttempts ?? 5,
    })
    .select('id')
    .single();

  if (!error && data) {
    return { id: data.id as string, duplicate: false };
  }

  // Unique violation on dedupe_key -> return the existing job.
  if (error && input.dedupeKey && error.code === '23505') {
    const { data: existing, error: findErr } = await client
      .from('jobs')
      .select('id')
      .eq('dedupe_key', input.dedupeKey)
      .maybeSingle();
    if (existing) return { id: existing.id as string, duplicate: true };
    throw new Error(
      `enqueueJob dedupe conflict but existing job not found: ${findErr?.message ?? 'unknown'}`
    );
  }

  throw new Error(`enqueueJob failed: ${error?.message ?? 'unknown error'}`);
}

/**
 * Look up a job by its dedupe_key. Returns null when none exists.
 */
export async function getJobByDedupeKey(
  dedupeKey: string
): Promise<{ id: string; status: string } | null> {
  const { data, error } = await db()
    .from('jobs')
    .select('id, status')
    .eq('dedupe_key', dedupeKey)
    .maybeSingle();
  if (error) {
    throw new Error(`getJobByDedupeKey failed: ${error.message}`);
  }
  return (data as { id: string; status: string } | null) ?? null;
}

/**
 * Atomically claim up to `limit` due jobs for `worker`.
 */export async function claimJobs(worker: string, limit = 5): Promise<Job[]> {
  const client = db();
  const { data, error } = await client.rpc('claim_jobs', {
    p_worker: worker,
    p_limit: limit,
  });
  if (error) throw new Error(`claimJobs failed: ${error.message}`);
  return (data ?? []).map(asJob);
}

/**
 * Mark a job as succeeded and release its lock.
 */
export async function completeJob(id: string): Promise<void> {
  const { error } = await db()
    .from('jobs')
    .update({
      status: 'succeeded',
      locked_at: null,
      locked_by: null,
      last_error: null,
    })
    .eq('id', id);
  if (error) throw new Error(`completeJob(${id}) failed: ${error.message}`);
}

/**
 * Record a failure. Retries with exponential backoff (30s * 2^(attempts-1),
 * capped at 1h) until max_attempts is reached, then goes dead.
 */
export async function failJob(job: Job, error: unknown): Promise<'failed' | 'dead'> {
  const message = errorMessage(error);
  const dead = job.attempts >= job.max_attempts;

  const update: Record<string, unknown> = {
    status: dead ? 'dead' : 'failed',
    locked_at: null,
    locked_by: null,
    last_error: message.slice(0, 2000),
  };

  if (!dead) {
    const backoff = Math.min(
      BASE_BACKOFF_MS * 2 ** Math.max(0, job.attempts - 1),
      MAX_BACKOFF_MS
    );
    update.run_at = new Date(Date.now() + backoff).toISOString();
  }

  const { error: updateErr } = await db().from('jobs').update(update).eq('id', job.id);
  if (updateErr) throw new Error(`failJob(${job.id}) failed: ${updateErr.message}`);
  return dead ? 'dead' : 'failed';
}

/**
 * Claim and dispatch due jobs until the time budget or batch limit is spent.
 */
export async function runDueJobs(opts: {
  worker: string;
  timeBudgetMs?: number;
  batchSize?: number;
}): Promise<RunDueJobsResult> {
  const budget = opts.timeBudgetMs ?? 45_000;
  const batchSize = Math.max(1, opts.batchSize ?? 5);
  const deadline = Date.now() + budget;

  const result: RunDueJobsResult = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    dead: 0,
  };

  while (Date.now() < deadline) {
    const jobs = await claimJobs(opts.worker, batchSize);
    if (jobs.length === 0) break;

    for (const job of jobs) {
      result.claimed++;

      const handler = jobHandlers[job.type];
      if (!handler) {
        const outcome = await failJob(
          { ...job, max_attempts: job.attempts },
          new Error(`Unknown job type: ${job.type}`)
        );
        if (outcome === 'dead') result.dead++;
        else result.failed++;
        continue;
      }

      try {
        await handler(job);
        await completeJob(job.id);
        result.succeeded++;
      } catch (err) {
        console.error(`[Jobs] ${job.type} (${job.id}) failed:`, errorMessage(err));
        try {
          const outcome = await failJob(job, err);
          if (outcome === 'dead') result.dead++;
          else result.failed++;
        } catch (failErr) {
          console.error(`[Jobs] failed to record failure for ${job.id}:`, failErr);
          result.failed++;
        }
      }
    }

    if (Date.now() >= deadline) break;
  }

  return result;
}

/**
 * Best-effort nudge to the runner. Fire-and-forget with a short timeout so an
 * inbound webhook never waits on the pipeline. A scheduler is the backstop.
 */
export async function kickJobRunner(): Promise<void> {
  // Awaited by callers: on serverless hosts (Vercel) an un-awaited fetch can be
  // frozen once the response is sent, so the kick would never leave. We only
  // wait until the request is dispatched (or 1.5s), not for the run to finish;
  // the runner keeps going after we abort. The scheduler is the safety net.
  const appUrl = process.env.APP_URL;
  const secret = process.env.JOBS_SECRET ?? process.env.CRON_SECRET;
  if (!appUrl || !secret) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);

  try {
    await fetch(`${appUrl.replace(/\/$/, '')}/api/jobs/run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
  } catch {
    // best-effort: scheduler will pick the job up
  } finally {
    clearTimeout(timer);
  }
}
