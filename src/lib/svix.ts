import { createHmac, timingSafeEqual } from 'crypto';

// ── Svix webhook signature verification ─────────────────────────────────────────
// Resend sends Svix-signed webhooks. Verified with Node crypto so we don't need
// the svix package.
//
// Svix scheme: key = base64-decode(secret without the "whsec_" prefix);
// signature = base64(HMAC-SHA256(key, "{svix-id}.{svix-timestamp}.{body}"));
// the svix-signature header is a space-separated list of "v1,<signature>".

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export function verifySvixSignature(
  payload: string,
  secret: string,
  id: string,
  timestamp: string,
  signatureHeader: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  // Reject stale or future-dated requests (replay protection).
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }

  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  if (key.length === 0) return false;

  const expectedBuf = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest();

  const signatures = signatureHeader
    .split(' ')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1,'))
    .map((part) => part.slice(3));

  for (const sig of signatures) {
    const sigBuf = Buffer.from(sig, 'base64');
    if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) {
      return true;
    }
  }
  return false;
}
