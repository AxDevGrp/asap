// Durable job runner. Any scheduler (Vercel Cron, pg_cron + pg_net, external
// cron, scripts/run-jobs.mjs) calls this every minute to drain the queue.
// Auth: `Authorization: Bearer <JOBS_SECRET>` (falls back to CRON_SECRET).

import { NextRequest, NextResponse } from 'next/server';
import { runDueJobs } from '@/lib/jobs';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const TIME_BUDGET_MS = 45_000;
const BATCH_SIZE = 5;

function authorize(request: NextRequest): NextResponse | null {
  const secret = process.env.JOBS_SECRET ?? process.env.CRON_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { error: 'Job runner is not configured' },
        { status: 503 }
      );
    }
    return null; // allow in development
  }

  const header = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  if (header !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

async function handle(request: NextRequest) {
  const denied = authorize(request);
  if (denied) return denied;

  try {
    const counts = await runDueJobs({
      worker: `http:${process.pid}:${Date.now()}`,
      timeBudgetMs: TIME_BUDGET_MS,
      batchSize: BATCH_SIZE,
    });
    return NextResponse.json(counts, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Job runner error';
    console.error('[Jobs] runner error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  return handle(request);
}

export async function GET(request: NextRequest) {
  return handle(request);
}
