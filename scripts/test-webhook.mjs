// Post Resend `email.received`-shaped payloads to the local webhook.
// Run with: node scripts/test-webhook.mjs [url] [--follow-up]
//
// Requires the dev server running: npm run dev
//
// --follow-up sends a first email and then a reply with the same sender and a
// "Re: ..." subject + new message_id, so the second response shows
// is_follow_up: true. Both responses are printed.
//
// NOTE: `email.received` carries metadata only — the webhook fetches the body
// from https://api.resend.com/emails/receiving/{email_id} using RESEND_API_KEY.
// The placeholder email_id below is not real, so this script will get a 500
// unless RESEND_API_KEY is stubbed (or the webhook's body fetch is mocked) and
// the email_id points at a real received email. Signature verification is
// skipped when RESEND_WEBHOOK_SECRET is unset.

const args = process.argv.slice(2);
const followUp = args.includes('--follow-up');
const url =
  args.find((arg) => !arg.startsWith('--')) ??
  'http://localhost:3000/api/webhook/resend';

const from = 'Test Customer <testcustomer@gmail.com>';
const to = ['support@goasap.ai'];
const subject = 'Help! I cannot log in';

function buildPayload({ subject: emailSubject, messageId }) {
  return {
    type: 'email.received',
    data: {
      email_id: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c',
      created_at: '2026-01-01T00:00:00.000Z',
      from,
      to,
      cc: [],
      bcc: [],
      received_for: to,
      message_id: messageId,
      subject: emailSubject,
      attachments: [],
    },
  };
}

async function post(payload) {
  console.log(`POST ${url} (message_id: ${payload.data.message_id})`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  console.log('Status:', res.status);
  console.log(JSON.stringify(body, null, 2));
  return body;
}

const stamp = Date.now();

const first = await post(
  buildPayload({ subject, messageId: `<test-${stamp}@gmail.com>` })
);

if (followUp) {
  console.log('\n--- follow-up ---\n');
  await post(
    buildPayload({
      subject: `Re: ${subject}`,
      messageId: `<test-${stamp}-reply@gmail.com>`,
    })
  );
} else if (first) {
  console.log('\nTip: pass --follow-up to send a reply on the same thread.');
}
