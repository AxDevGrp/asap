// GET /api/health — public health check endpoint
//
// Returns system status and environment info.
// Designed to be lightweight — no DB calls on the hot path.
// DB ping is optional (slow path, only when ?deep=1 is passed).

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const deep = request.nextUrl.searchParams.get('deep') === '1';

  const result: Record<string, unknown> = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? '1.0.0',
    environment: process.env.NODE_ENV ?? 'unknown',
  };

  // Deep check: verify DB connectivity
  if (deep) {
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      if (!url || !key) {
        result.database = 'not_configured';
      } else {
        const db = createClient(url, key);
        const start = Date.now();
        const { error } = await db.from('tenants').select('id').limit(1);
        const latencyMs = Date.now() - start;

        result.database = error
          ? { status: 'error', message: error.message }
          : { status: 'ok', latency_ms: latencyMs };
      }
    } catch (err) {
      result.database = {
        status: 'error',
        message: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  const statusCode =
    deep && (result.database as any)?.status === 'error' ? 503 : 200;

  return NextResponse.json(result, { status: statusCode });
}
