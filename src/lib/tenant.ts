// Tenant resolution — DB-driven lookup with in-process caching

import { createClient } from '@supabase/supabase-js';

// Use service role for server-side tenant lookups (bypasses RLS)
function getServiceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  domain: string;
  resend_domain_id: string | null;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Simple in-process cache — keyed by slug/domain/id (TTL: 5 minutes)
const slugCache = new Map<string, { tenant: Tenant; expiresAt: number }>();
const domainCache = new Map<string, { tenant: Tenant; expiresAt: number }>();
const idCache = new Map<string, { tenant: Tenant; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolve a tenant from its slug (e.g. 'goasap').
 */
export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const cached = slugCache.get(slug);
  if (cached && cached.expiresAt > Date.now()) return cached.tenant;

  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('slug', slug)
    .single();

  if (error || !data) {
    console.warn(`[Tenant] getTenantBySlug(${slug}) failed:`, error?.message ?? 'not found');
    return null;
  }

  const tenant = data as Tenant;
  slugCache.set(slug, { tenant, expiresAt: Date.now() + CACHE_TTL_MS });
  return tenant;
}

/**
 * Resolve a tenant by its domain (e.g. 'client.com').
 * This is the primary entry point for inbound webhooks.
 */
export async function getTenantByDomain(domain: string): Promise<Tenant | null> {
  const cached = domainCache.get(domain);
  if (cached && cached.expiresAt > Date.now()) return cached.tenant;

  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('domain', domain)
    .single();

  if (error || !data) {
    console.warn(`[Tenant] getTenantByDomain(${domain}) failed:`, error?.message ?? 'not found');
    return null;
  }

  const tenant = data as Tenant;
  domainCache.set(domain, { tenant, expiresAt: Date.now() + CACHE_TTL_MS });
  return tenant;
}

/**
 * Resolve a tenant by its UUID.
 */
export async function getTenantById(id: string): Promise<Tenant | null> {
  const cached = idCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.tenant;

  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) {
    console.warn(`[Tenant] getTenantById(${id}) failed:`, error?.message ?? 'not found');
    return null;
  }

  const tenant = data as Tenant;
  idCache.set(id, { tenant, expiresAt: Date.now() + CACHE_TTL_MS });
  return tenant;
}

/**
 * List all tenants.
 */
export async function listTenants(): Promise<Tenant[]> {
  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[Tenant] listTenants failed:', error.message);
    return [];
  }
  return (data ?? []) as Tenant[];
}

/**
 * Create a new tenant.
 */
export async function createTenant(input: {
  name: string;
  slug: string;
  domain: string;
  resend_domain_id?: string;
  settings?: Record<string, unknown>;
}): Promise<Tenant | null> {
  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .from('tenants')
    .insert(input)
    .select('*')
    .single();

  if (error) {
    console.error('[Tenant] createTenant failed:', error.message);
    return null;
  }
  return data as Tenant;
}

/**
 * Update a tenant by ID.
 */
export async function updateTenant(
  id: string,
  updates: Partial<Omit<Tenant, 'id' | 'created_at'>>
): Promise<Tenant | null> {
  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .from('tenants')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();

  if (error) {
    console.error('[Tenant] updateTenant failed:', error.message);
    return null;
  }

  // Bust caches for this tenant
  idCache.delete(id);
  if (data) {
    slugCache.delete((data as Tenant).slug);
  }

  return data as Tenant;
}

/**
 * Invalidate all tenant caches (useful after writes).
 */
export function invalidateTenantCache() {
  slugCache.clear();
  domainCache.clear();
  idCache.clear();
}
