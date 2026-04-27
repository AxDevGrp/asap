// Tenant resolution — DB-driven lookup with in-process caching
// This replaces the hardcoded INBOX_PRODUCT_MAP in config.ts

import { createClient } from '@supabase/supabase-js';

// Use service role for server-side tenant lookups (bypasses RLS)
function getServiceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createClient(url, key);
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  domain: string;
  chatwoot_account_id: number;
  chatwoot_inbox_id: number | null;
  resend_domain_id: string | null;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Simple in-process cache — keyed by inbox_id (TTL: 5 minutes)
const inboxCache = new Map<number, { tenant: Tenant; expiresAt: number }>();
const slugCache = new Map<string, { tenant: Tenant; expiresAt: number }>();
const domainCache = new Map<string, { tenant: Tenant; expiresAt: number }>();
const idCache = new Map<string, { tenant: Tenant; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolve a tenant from a Chatwoot inbox_id.
 * Falls back to the hardcoded slug-based mapping if DB lookup fails.
 */
export async function getTenantByInboxId(inboxId: number): Promise<Tenant | null> {
  // Check cache
  const cached = inboxCache.get(inboxId);
  if (cached && cached.expiresAt > Date.now()) return cached.tenant;

  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('chatwoot_inbox_id', inboxId)
    .single();

  if (error || !data) {
    console.warn(`[Tenant] getTenantByInboxId(${inboxId}) failed:`, error?.message ?? 'not found');
    return null;
  }

  const tenant = data as Tenant;
  inboxCache.set(inboxId, { tenant, expiresAt: Date.now() + CACHE_TTL_MS });
  return tenant;
}

/**
 * Resolve a tenant from its slug (e.g. 'strk', 'cashpile', 'dailypost').
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
  chatwoot_account_id?: number;
  chatwoot_inbox_id?: number;
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
    const t = data as Tenant;
    slugCache.delete(t.slug);
    if (t.chatwoot_inbox_id) inboxCache.delete(t.chatwoot_inbox_id);
  }

  return data as Tenant;
}

/**
 * Invalidate all tenant caches (useful after writes).
 */
export function invalidateTenantCache() {
  inboxCache.clear();
  slugCache.clear();
  idCache.clear();
}
