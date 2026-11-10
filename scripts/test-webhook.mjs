// Post a Resend `email.received`-shaped payload to the local webhook.
// Run with: node scripts/test-webhook.mjs [url]
//
// Requires the dev server running: npm run dev
//
// NOTE: `email.received` carries metadata only — the webhook fetches the body
// from https://api.resend.com/emails/receiving/{email_id} using RESEND_API_KEY.
// The placeholder email_id below is not real, so this script will get a 500
// unless RESEND_API_KEY is stubbed (or the webhook's body fetch is mocked) and
// the email_id points at a real received email. Signature verification is
// skipped when RESEND_WEBHOOK_SECRET is unset.

const url = process.argv[2] ?? 'http://localhost:3000/api/webhook/resend';

const payload = {
  type: 'email.received',
  data: {
    email_id: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c',
    created_at: '2026-01-01T00:00:00.000Z',
    from: 'Test Customer <testcustomer@gmail.com>',
    to: ['support@goasap.ai'],
    cc: [],
    bcc: [],
    received_for: ['support@goasap.ai'],
    message_id: '<test-' + Date.now() + '@gmail.com>',
    subject: 'Help! I cannot log in',
    attachments: [],
  },
};

console.log(`POST ${url}`);
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

console.log('Status:', res.status);
console.log(JSON.stringify(await res.json(), null, 2));
