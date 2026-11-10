import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Lazily validated — env vars are only required at runtime, not at build time.
// This prevents Next.js static analysis from throwing during `next build`
// when env vars are not present in the build environment.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: SupabaseClient<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getClient(): SupabaseClient<any> {
  if (_client) return _client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // Server-only client. Uses the service role key: row-level security only
  // grants table access to service_role, so the anon key would see nothing.
  // Never import this module from a client component.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'Missing Supabase env vars: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set'
    );
  }

  _client = createClient(url, key);
  return _client;
}

// Export a getter instead of a top-level singleton so module load doesn't throw.
export function getSupabase() {
  return getClient();
}

// Backwards-compat alias — `supabase.from(...)` etc.
// Uses a Proxy so existing callers (supabase.from / supabase.rpc) keep working
// without any import changes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const supabase: SupabaseClient<any> = new Proxy({} as SupabaseClient<any>, {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(_target: any, prop: string | symbol) {
    return (getClient() as any)[prop];
  },
});
