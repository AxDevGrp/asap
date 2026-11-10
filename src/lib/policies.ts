// Per-tenant auto-resolve policy — DB-backed, cached in-process.
// Server-only: uses the service-role client.

import { createSupabaseAdminClient } from '@/lib/supabase-server';

export interface TenantPolicy {
  autoSendEnabled: boolean;
  confidenceThreshold: number;
  allowedTypes: string[];
  allowedUrgencies: string[];
  minKbSimilarity: number;
  minKbHits: number;
  resolveOnAutoSend: boolean;
  version: number;
}

/** Conservative fallback used when the row is missing or the read fails. */
export const SAFE_DEFAULT_POLICY: TenantPolicy = {
  autoSendEnabled: false,
  confidenceThreshold: 0.85,
  allowedTypes: ['question', 'billing', 'feature_request'],
  allowedUrgencies: ['low', 'medium'],
  minKbSimilarity: 0.7,
  minKbHits: 1,
  resolveOnAutoSend: true,
  version: 0,
};

const CACHE_TTL_MS = 60 * 1000;

const cache = new Map<string, { policy: TenantPolicy; expiresAt: number }>();

interface PolicyRow {
  tenant_id: string;
  auto_send_enabled: boolean;
  confidence_threshold: number | string;
  allowed_types: string[] | null;
  allowed_urgencies: string[] | null;
  min_kb_similarity: number | string;
  min_kb_hits: number | string;
  resolve_on_auto_send: boolean;
  version: number | string;
}

function toNumber(value: number | string | null | undefined, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function rowToPolicy(row: PolicyRow): TenantPolicy {
  return {
    autoSendEnabled: row.auto_send_enabled === true,
    confidenceThreshold: toNumber(row.confidence_threshold, SAFE_DEFAULT_POLICY.confidenceThreshold),
    allowedTypes: row.allowed_types ?? SAFE_DEFAULT_POLICY.allowedTypes,
    allowedUrgencies: row.allowed_urgencies ?? SAFE_DEFAULT_POLICY.allowedUrgencies,
    minKbSimilarity: toNumber(row.min_kb_similarity, SAFE_DEFAULT_POLICY.minKbSimilarity),
    minKbHits: toNumber(row.min_kb_hits, SAFE_DEFAULT_POLICY.minKbHits),
    resolveOnAutoSend: row.resolve_on_auto_send === true,
    version: toNumber(row.version, SAFE_DEFAULT_POLICY.version),
  };
}

/**
 * Read a tenant's policy. Cached for 60s. Never throws: returns
 * SAFE_DEFAULT_POLICY (and logs) when the row is missing or the query fails.
 */
export async function getTenantPolicy(tenantId: string): Promise<TenantPolicy> {
  const cached = cache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.policy;

  try {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from('tenant_policies')
      .select(
        'tenant_id, auto_send_enabled, confidence_threshold, allowed_types, allowed_urgencies, min_kb_similarity, min_kb_hits, resolve_on_auto_send, version'
      )
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (error) {
      console.error(`[Policies] getTenantPolicy(${tenantId}) failed:`, error.message);
      return SAFE_DEFAULT_POLICY;
    }
    if (!data) {
      console.warn(`[Policies] no policy row for tenant ${tenantId}, using safe default`);
      return SAFE_DEFAULT_POLICY;
    }

    const policy = rowToPolicy(data as PolicyRow);
    cache.set(tenantId, { policy, expiresAt: Date.now() + CACHE_TTL_MS });
    return policy;
  } catch (err) {
    console.error(`[Policies] getTenantPolicy(${tenantId}) threw:`, err);
    return SAFE_DEFAULT_POLICY;
  }
}

export type TenantPolicyPatch = Partial<Omit<TenantPolicy, 'version'>>;

/**
 * Upsert a tenant's policy, merging `patch` over the current values, and
 * invalidate the cache. Returns the stored policy, or null on error.
 */
export async function updateTenantPolicy(
  tenantId: string,
  patch: TenantPolicyPatch,
  userId: string
): Promise<TenantPolicy | null> {
  const current = await getTenantPolicy(tenantId);
  const merged = { ...current, ...patch };

  try {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from('tenant_policies')
      .upsert(
        {
          tenant_id: tenantId,
          auto_send_enabled: merged.autoSendEnabled,
          confidence_threshold: merged.confidenceThreshold,
          allowed_types: merged.allowedTypes,
          allowed_urgencies: merged.allowedUrgencies,
          min_kb_similarity: merged.minKbSimilarity,
          min_kb_hits: merged.minKbHits,
          resolve_on_auto_send: merged.resolveOnAutoSend,
          updated_by: userId,
        },
        { onConflict: 'tenant_id' }
      )
      .select(
        'tenant_id, auto_send_enabled, confidence_threshold, allowed_types, allowed_urgencies, min_kb_similarity, min_kb_hits, resolve_on_auto_send, version'
      )
      .single();

    if (error || !data) {
      console.error(`[Policies] updateTenantPolicy(${tenantId}) failed:`, error?.message ?? 'no row returned');
      return null;
    }

    const policy = rowToPolicy(data as PolicyRow);
    cache.set(tenantId, { policy, expiresAt: Date.now() + CACHE_TTL_MS });
    return policy;
  } catch (err) {
    console.error(`[Policies] updateTenantPolicy(${tenantId}) threw:`, err);
    return null;
  }
}

/** Clear the cache for one tenant, or all tenants when no id is given. */
export function invalidatePolicyCache(tenantId?: string): void {
  if (tenantId) {
    cache.delete(tenantId);
  } else {
    cache.clear();
  }
}
