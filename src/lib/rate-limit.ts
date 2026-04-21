// Rate limiting utility — in-memory, per-key sliding window counter.
//
// Designed for Edge/Node environments. Uses a simple Map-based store
// that resets on cold start. Suitable for MVP scale; replace with
// Redis (Upstash) for distributed/multi-instance deployments.
//
// Usage:
//   const allowed = checkRateLimit('ip:1.2.3.4', 60, 30);
//   // true = allowed; false = rate limit exceeded
//
// Key design choices (Karpathy rule: functions do one thing):
//   - Sliding window avoids the burst-at-reset problem of fixed windows
//   - No external deps — works on Vercel Edge, Railway, local

interface WindowEntry {
  requests: number[];  // timestamps of recent requests (epoch ms)
}

// Module-level store — shared across requests within the same process
const store = new Map<string, WindowEntry>();

// Periodically clean up stale keys (every 5 min, lazy cleanup)
let lastCleanup = Date.now();
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function cleanup(windowMs: number) {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  const cutoff = now - windowMs;
  const keysToDelete: string[] = [];
  store.forEach((entry, key) => {
    const fresh = entry.requests.filter((t: number) => t > cutoff);
    if (fresh.length === 0) {
      keysToDelete.push(key);
    } else {
      entry.requests = fresh;
    }
  });
  keysToDelete.forEach((k) => store.delete(k));
}

/**
 * Check and record a rate-limited event for the given key.
 *
 * @param key        - Unique key (e.g. "ip:1.2.3.4" or "tenant:abc")
 * @param windowSecs - Sliding window size in seconds
 * @param maxRequests - Max allowed requests within the window
 * @returns true if the request is allowed; false if limit exceeded
 */
export function checkRateLimit(
  key: string,
  windowSecs: number,
  maxRequests: number
): boolean {
  const windowMs = windowSecs * 1000;
  cleanup(windowMs);

  const now = Date.now();
  const cutoff = now - windowMs;

  const entry = store.get(key) ?? { requests: [] };

  // Evict timestamps outside the window
  entry.requests = entry.requests.filter((t) => t > cutoff);

  if (entry.requests.length >= maxRequests) {
    store.set(key, entry);
    return false;
  }

  entry.requests.push(now);
  store.set(key, entry);
  return true;
}

/**
 * Get current usage for a key without recording a new request.
 * Useful for monitoring/debug endpoints.
 */
export function getRateLimitUsage(
  key: string,
  windowSecs: number
): { count: number; windowSecs: number } {
  const windowMs = windowSecs * 1000;
  const cutoff = Date.now() - windowMs;
  const entry = store.get(key);
  const count = entry
    ? entry.requests.filter((t) => t > cutoff).length
    : 0;
  return { count, windowSecs };
}

// ── Pre-configured limiters ─────────────────────────────────────────────────
//
// Centralise all rate limit policies here so they're easy to adjust.

/** Webhook endpoints — 1000 events/min per IP (Resend can be chatty) */
export function checkWebhookLimit(ip: string): boolean {
  return checkRateLimit(`webhook:${ip}`, 60, 1000);
}

/** API read endpoints — 300 req/min per tenant */
export function checkApiReadLimit(tenantId: string): boolean {
  return checkRateLimit(`api-read:${tenantId}`, 60, 300);
}

/** API write endpoints (send reply) — 60 req/min per tenant */
export function checkApiWriteLimit(tenantId: string): boolean {
  return checkRateLimit(`api-write:${tenantId}`, 60, 60);
}

/** Auth endpoints (login/signup) — 10 req/min per IP */
export function checkAuthLimit(ip: string): boolean {
  return checkRateLimit(`auth:${ip}`, 60, 10);
}
