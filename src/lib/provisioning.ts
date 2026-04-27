// Chatwoot provisioning helpers — create accounts and inboxes via API
// Uses CHATWOOT_BASE_URL and CHATWOOT_SUPER_ADMIN_TOKEN env vars

export interface ChatwootAccount {
  id: number;
  name: string;
}

export interface ChatwootInbox {
  id: number;
  name: string;
  email: string;
}

function chatwootHeaders() {
  return {
    'Content-Type': 'application/json',
    'api_access_token': process.env.CHATWOOT_SUPER_ADMIN_TOKEN ?? '',
  };
}

function chatwootBase() {
  return process.env.CHATWOOT_BASE_URL ?? 'https://chatwoot-production-9d1d.up.railway.app';
}

/**
 * Create a new Chatwoot account for a tenant.
 */
export async function createChatwootAccount(
  name: string
): Promise<ChatwootAccount | null> {
  try {
    const res = await fetch(`${chatwootBase()}/auth/sign_in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.CHATWOOT_SUPER_ADMIN_EMAIL, password: process.env.CHATWOOT_SUPER_ADMIN_PASSWORD }),
    });

    if (!res.ok) return null;

    // Create account via Super Admin API
    const accountRes = await fetch(`${chatwootBase()}/super_admin/accounts`, {
      method: 'POST',
      headers: chatwootHeaders(),
      body: JSON.stringify({ account: { name } }),
    });

    if (!accountRes.ok) {
      console.error('[Chatwoot] createAccount failed:', accountRes.status, await accountRes.text());
      return null;
    }

    const data = await accountRes.json();
    return { id: data.id, name: data.name };
  } catch (err) {
    console.error('[Chatwoot] createAccount error:', err);
    return null;
  }
}

/**
 * Create a Chatwoot email inbox for a tenant account.
 */
export async function createChatwootEmailInbox(
  accountId: number,
  name: string,
  email: string
): Promise<ChatwootInbox | null> {
  try {
    const res = await fetch(
      `${chatwootBase()}/api/v1/accounts/${accountId}/inboxes`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api_access_token': process.env.CHATWOOT_ACCOUNT_ACCESS_TOKEN ?? '',
        },
        body: JSON.stringify({
          channel: {
            type: 'email',
            email,
          },
          name,
        }),
      }
    );

    if (!res.ok) {
      console.error('[Chatwoot] createInbox failed:', res.status, await res.text());
      return null;
    }

    const data = await res.json();
    return { id: data.id, name: data.name, email };
  } catch (err) {
    console.error('[Chatwoot] createInbox error:', err);
    return null;
  }
}

/**
 * Send a welcome email to a new tenant admin.
 */
export async function sendWelcomeEmail(
  to: string,
  tenantName: string,
  domain: string
): Promise<void> {
  try {
    const { resend } = await import('@/lib/resend');
    await resend.emails.send({
      from: 'ASAP <onboarding@goasap.ai>',
      to,
      subject: `Welcome to ASAP — ${tenantName} is ready!`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="font-size: 24px; font-weight: 700; margin-bottom: 8px;">Welcome to ASAP 🎉</h1>
          <p style="color: #6b7280; margin-bottom: 24px;">Your AI support platform for <strong>${tenantName}</strong> is set up and ready.</p>

          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
            <h2 style="font-size: 16px; font-weight: 600; margin-bottom: 12px;">What's ready:</h2>
            <ul style="margin: 0; padding-left: 20px; color: #374151; line-height: 1.8;">
              <li>AI-powered support inbox for ${domain}</li>
              <li>Knowledge base for training your AI</li>
              <li>Ticket management dashboard</li>
              <li>Auto-resolve for common questions</li>
            </ul>
          </div>

          <a href="https://app.goasap.ai/dashboard"
             style="display: inline-block; background: #111827; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500; font-size: 14px;">
            Go to Dashboard →
          </a>

          <p style="color: #9ca3af; font-size: 12px; margin-top: 32px;">
            ASAP · AI Support Anytime Platform · <a href="https://goasap.ai" style="color: #9ca3af;">goasap.ai</a>
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.error('[Provisioning] sendWelcomeEmail error:', err);
  }
}
