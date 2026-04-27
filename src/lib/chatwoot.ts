const CHATWOOT_URL = process.env.CHATWOOT_API_URL!;
const CHATWOOT_KEY = process.env.CHATWOOT_API_KEY!;
const DEFAULT_ACCOUNT_ID = 1; // fallback for legacy / internal k3nz0 account

function headers() {
  return {
    'api_access_token': CHATWOOT_KEY,
    'Content-Type': 'application/json',
  };
}

function accountId(tenantAccountId?: number | null): number {
  return tenantAccountId ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Send an outgoing message to a Chatwoot conversation
 */
export async function sendReply(
  conversationId: number,
  message: string,
  tenantAccountId?: number | null
): Promise<void> {
  const res = await fetch(
    `${CHATWOOT_URL}/api/v1/accounts/${accountId(tenantAccountId)}/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        content: message,
        message_type: 'outgoing',
        private: false,
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Chatwoot sendReply failed ${res.status}: ${err}`);
  }
}

/**
 * Send a private note (internal note) to a Chatwoot conversation.
 * Used for AI draft replies that need human review before sending.
 */
export async function sendPrivateNote(
  conversationId: number,
  message: string,
  tenantAccountId?: number | null
): Promise<void> {
  const res = await fetch(
    `${CHATWOOT_URL}/api/v1/accounts/${accountId(tenantAccountId)}/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        content: message,
        message_type: 'outgoing',
        private: true,
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Chatwoot sendPrivateNote failed ${res.status}: ${err}`);
  }
}

/**
 * Add a label to a Chatwoot conversation (e.g. 'urgent', 'bug', 'billing')
 */
export async function addLabel(
  conversationId: number,
  label: string,
  tenantAccountId?: number | null
): Promise<void> {
  const res = await fetch(
    `${CHATWOOT_URL}/api/v1/accounts/${accountId(tenantAccountId)}/conversations/${conversationId}/labels`,
    {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ labels: [label] }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Chatwoot addLabel failed ${res.status}: ${err}`);
  }
}

/**
 * Update conversation status
 */
export async function updateStatus(
  conversationId: number,
  status: 'open' | 'resolved' | 'pending',
  tenantAccountId?: number | null
): Promise<void> {
  const res = await fetch(
    `${CHATWOOT_URL}/api/v1/accounts/${accountId(tenantAccountId)}/conversations/${conversationId}`,
    {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ status }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Chatwoot updateStatus failed ${res.status}: ${err}`);
  }
}
