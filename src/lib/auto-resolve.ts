// Auto-resolve decision — pure function over a tenant policy.
// Policy data lives in the tenant_policies table (see src/lib/policies.ts).

import type { TenantPolicy } from '@/lib/policies';

export type { TenantPolicy };

/**
 * Decide whether an AI reply should be auto-sent or kept as a draft.
 * Returns the decision with a reason for the audit trail.
 */
export function shouldAutoResolve(
  policy: TenantPolicy,
  triage: {
    confidence?: number | null;
    type?: string | null;
    urgency?: string | null;
  },
  kbHits: number,
  topKbSimilarity: number | null
): { autoSend: boolean; reason: string } {
  if (!policy.autoSendEnabled) {
    return { autoSend: false, reason: 'auto-send disabled for tenant' };
  }

  if ((triage.confidence ?? 0) < policy.confidenceThreshold) {
    return {
      autoSend: false,
      reason: `confidence ${(triage.confidence ?? 0).toFixed(2)} below threshold ${policy.confidenceThreshold}`,
    };
  }

  if (triage.type && !policy.allowedTypes.includes(triage.type)) {
    return {
      autoSend: false,
      reason: `type "${triage.type}" not in allowed types: ${policy.allowedTypes.join(', ')}`,
    };
  }

  if (triage.urgency && !policy.allowedUrgencies.includes(triage.urgency)) {
    return {
      autoSend: false,
      reason: `urgency "${triage.urgency}" not allowed for auto-resolve (allowed: ${policy.allowedUrgencies.join(', ')})`,
    };
  }

  if (kbHits < policy.minKbHits) {
    return {
      autoSend: false,
      reason: `KB hits ${kbHits} below minimum ${policy.minKbHits}`,
    };
  }

  if (topKbSimilarity !== null && topKbSimilarity < policy.minKbSimilarity) {
    return {
      autoSend: false,
      reason: `top KB similarity ${topKbSimilarity.toFixed(2)} below threshold ${policy.minKbSimilarity}`,
    };
  }

  return {
    autoSend: true,
    reason: `confidence=${(triage.confidence ?? 0).toFixed(2)} type=${triage.type} urgency=${triage.urgency} kbHits=${kbHits} topSim=${topKbSimilarity?.toFixed(2) ?? 'N/A'}`,
  };
}
