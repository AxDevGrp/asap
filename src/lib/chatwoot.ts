const CHATWOOT_URL = process.env.CHATWOOT_API_URL!;
const CHATWOOT_KEY = process.env.CHATWOOT_API_KEY!;
const ACCOUNT_ID = 1; // GlobalCorp Chatwoot account

function headers() {
  return {
    'api_access_token': CHATWOOT_KEY,
    'Content-Type': 'application/json',
  };
}

/**
 * Send an outgoing message to a Chatwoot conversation
 */
export async function sendReply(conversationId: number, message: string): Promise<void> {
  const res = await fetch(
    `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversationId}/messages`,
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
 * Add a label to a Chatwoot conversation (e.g. 'urgent', 'bug', 'billing')
 */
export async function addLabel(conversationId: number, label: string): Promise<void> {
  const res = await fetch(
    `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversationId}/labels`,
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
export async function updateStatus(conversationId: number, status: 'open' | 'resolved' | 'pending'): Promise<void> {
  const res = await fetch(
    `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversationId}`,
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
