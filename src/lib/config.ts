// Tenant/product config — DB-driven with hardcoded fallback for legacy code
// New code should use getTenantByInboxId() from src/lib/tenant.ts directly.

// Fallback map for local dev or if the DB is unreachable
export const INBOX_PRODUCT_MAP: Record<number, string> = {
  1: 'strk',
  2: 'cashpile',
  3: 'dailypost',
};

export const PRODUCT_NAMES: Record<string, string> = {
  strk: 'STRK',
  cashpile: 'Cashpile',
  dailypost: 'The Daily Post',
};

/** Fallback: get product slug from inbox_id (use getTenantByInboxId for new code) */
export function getProductFromInbox(inboxId: number): string {
  return INBOX_PRODUCT_MAP[inboxId] ?? 'unknown';
}

export function getProductName(product: string): string {
  return PRODUCT_NAMES[product] ?? 'Unknown Product';
}
