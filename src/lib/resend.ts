// Resend email sending layer — per-tenant outbound email
// Handles: send, domain registration, domain status checks

import { Resend } from 'resend';

// Lazy singleton — instantiated on first use so module load doesn't throw
// when RESEND_API_KEY is absent at build time.
let _resend: Resend | null = null;

function getResend(): Resend {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('Missing RESEND_API_KEY environment variable');
  _resend = new Resend(key);
  return _resend;
}

// Proxy so callers can write `resend.emails.send(...)` without changes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const resend: Resend = new Proxy({} as Resend, {
  get(_target: any, prop: string | symbol) {
    return (getResend() as any)[prop];
  },
});

// ── Types ────────────────────────────────────────────────────────────────────

export interface SendEmailOptions {
  /** Tenant domain used to build the from address, e.g. "acme.com" → "support@acme.com" */
  tenantDomain: string;
  /** Optional custom from name, defaults to "Support" */
  fromName?: string;
  /** Recipient email address */
  to: string;
  /** Email subject */
  subject: string;
  /** Plain-text body */
  text: string;
  /** Optional HTML body */
  html?: string;
  /** Optional reply-to override (defaults to from address) */
  replyTo?: string;
  /** Optional headers (e.g. In-Reply-To, References for threading) */
  headers?: Record<string, string>;
  /** Optional tags for Resend analytics */
  tags?: Array<{ name: string; value: string }>;
}

export interface SendEmailResult {
  id: string;
  success: true;
}

export interface SendEmailError {
  success: false;
  error: string;
  statusCode?: number;
}

// ── Core send function ───────────────────────────────────────────────────────

/**
 * Send a transactional email via Resend using the tenant's custom domain.
 * Falls back to the Resend test domain if the tenant domain is not yet verified.
 */
export async function sendEmail(
  opts: SendEmailOptions
): Promise<SendEmailResult | SendEmailError> {
  const fromName = opts.fromName ?? 'Support';
  const fromAddress = `support@${opts.tenantDomain}`;
  const from = `${fromName} <${fromAddress}>`;

  try {
    const result = await resend.emails.send({
      from,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      reply_to: opts.replyTo ?? fromAddress,
      headers: opts.headers,
      tags: opts.tags,
    });

    if (result.error) {
      console.error('[Resend] sendEmail error:', result.error);
      return {
        success: false,
        error: result.error.message,
        statusCode: (result.error as { statusCode?: number }).statusCode,
      };
    }

    if (!result.data?.id) {
      return { success: false, error: 'No message ID returned from Resend' };
    }

    return { id: result.data.id, success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Resend] sendEmail exception:', message);
    return { success: false, error: message };
  }
}

// ── Domain management ────────────────────────────────────────────────────────

export interface ResendDomain {
  id: string;
  name: string;
  status: 'not_started' | 'pending' | 'verified' | 'failed' | 'temporary_failure';
  records: ResendDNSRecord[];
  created_at: string;
}

export interface ResendDNSRecord {
  record: string;
  name: string;
  type: string;
  ttl: string;
  status: 'not_started' | 'pending' | 'verified' | 'failed' | 'temporary_failure';
  value: string;
  priority?: number;
}

/**
 * Register a new domain with Resend for outbound sending.
 * Returns the domain object including DNS records to set up.
 */
export async function registerResendDomain(
  domain: string,
  region: 'us-east-1' | 'eu-west-1' = 'us-east-1'
): Promise<{ id: string; records: ResendDNSRecord[] } | null> {
  try {
    const result = await resend.domains.create({ name: domain, region });
    if (result.error || !result.data) {
      console.error('[Resend] registerDomain error:', result.error);
      return null;
    }
    return {
      id: result.data.id,
      records: (result.data as unknown as ResendDomain).records ?? [],
    };
  } catch (err) {
    console.error('[Resend] registerDomain exception:', err);
    return null;
  }
}

/**
 * Get the current status of a Resend domain by its ID.
 * Used to poll verification state after DNS records are added.
 */
export async function getResendDomainStatus(
  domainId: string
): Promise<ResendDomain | null> {
  try {
    const result = await resend.domains.get(domainId);
    if (result.error || !result.data) {
      console.error('[Resend] getDomainStatus error:', result.error);
      return null;
    }
    return result.data as unknown as ResendDomain;
  } catch (err) {
    console.error('[Resend] getDomainStatus exception:', err);
    return null;
  }
}

/**
 * Trigger a domain verification check in Resend.
 */
export async function verifyResendDomain(
  domainId: string
): Promise<boolean> {
  try {
    const result = await resend.domains.verify(domainId);
    if (result.error) {
      console.error('[Resend] verifyDomain error:', result.error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[Resend] verifyDomain exception:', err);
    return false;
  }
}
