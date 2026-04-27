'use client';

import { createBrowserClient } from '@supabase/ssr';

/**
 * Singleton Supabase browser client.
 * Use this in Client Components and client-side hooks.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
