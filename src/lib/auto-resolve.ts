// Phase 3 — Auto-Resolve Configuration
// Controls when AI replies are sent automatically vs held for human review.

export interface AutoResolvePolicy {
  /** Enable auto-resolve for this product */
  enabled: boolean;
  /** Minimum triage confidence (0-1) to auto-send. Below this = draft only. */
  confidenceThreshold: number;
  /** Ticket types that CAN be auto-resolved (others always draft) */
  allowedTypes: string[];
  /** Urgency levels that CAN be auto-resolved (others always draft) */
  allowedUrgencies: string[];
  /** Minimum KB similarity score for the top match to trust the reply */
  minKbSimilarity: number;
  /** Minimum number of KB articles matched to trust the reply */
  minKbHits: number;
  /** Auto-resolve the Chatwoot conversation after auto-sending */
  autoResolveConversation: boolean;
}

/** Default policies per product — can be overridden via DB or env vars */
export const DEFAULT_POLICIES: Record<string, AutoResolvePolicy> = {
  strk: {
    enabled: true,
    confidenceThreshold: 0.85,
    allowedTypes: ['question', 'billing', 'feature_request'],
    allowedUrgencies: ['low', 'medium'],
    minKbSimilarity: 0.7,
    minKbHits: 1,
    autoResolveConversation: true,
  },
  cashpile: {
    enabled: true,
    confidenceThreshold: 0.85,
    allowedTypes: ['question', 'billing', 'feature_request'],
    allowedUrgencies: ['low', 'medium'],
    minKbSimilarity: 0.7,
    minKbHits: 1,
    autoResolveConversation: true,
  },
  dailypost: {
    enabled: true,
    confidenceThreshold: 0.85,
    allowedTypes: ['question', 'billing', 'feature_request'],
    allowedUrgencies: ['low', 'medium'],
    minKbSimilarity: 0.7,
    minKbHits: 1,
    autoResolveConversation: true,
  },
  unknown: {
    enabled: false,
    confidenceThreshold: 1.0, // Never auto-send for unknown products
    allowedTypes: [],
    allowedUrgencies: [],
    minKbSimilarity: 1.0,
    minKbHits: 999,
    autoResolveConversation: false,
  },
};

/**
 * Decide whether an AI reply should be auto-sent or kept as a draft.
 * Returns the decision with a reason for the audit trail.
 */
export function shouldAutoResolve(
  product: string,
  triage: {
    confidence?: number | null;
    type?: string | null;
    urgency?: string | null;
  },
  kbHits: number,
  topKbSimilarity: number | null
): { autoSend: boolean; reason: string } {
  const policy = DEFAULT_POLICIES[product] ?? DEFAULT_POLICIES.unknown;

  if (!policy.enabled) {
    return { autoSend: false, reason: 'auto-resolve disabled for product' };
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
