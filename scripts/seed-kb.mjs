#!/usr/bin/env node
// Seed the knowledge base via the ASAP API.
// Usage: node scripts/seed-kb.mjs
// Requires: ASAP dev server running on localhost:3000
//   cd /Volumes/Black_Mamba_4TB/Projects/asap && npm run dev

const BASE_URL = process.env.APP_URL || 'http://localhost:3000';

const articles = [
  // ── STRK ──────────────────────────────────────────────────────────────────
  {
    product: 'strk',
    title: 'How do I create my first STRK link?',
    content: `To create your first STRK link, log in to your dashboard and click "New Link" in the top right. Enter the destination URL, customise the short slug if you want a memorable name, then click Save. Your STRK link is live instantly and will start tracking clicks immediately.`,
  },
  {
    product: 'strk',
    title: 'What analytics does STRK provide?',
    content: `STRK tracks clicks, unique visitors, geographic location (country/city), device type (mobile/desktop), referrer source, and timestamp for every link. You can view real-time stats on the link detail page or export a CSV for deeper analysis.`,
  },
  {
    product: 'strk',
    title: 'Can I use a custom domain with STRK?',
    content: `Yes! Custom domains are available on the Pro plan and above. Go to Settings → Domains and add your domain. You'll need to point a CNAME record at our servers — we provide step-by-step DNS instructions for all major registrars.`,
  },
  {
    product: 'strk',
    title: 'How do I delete a STRK link?',
    content: `Open the link from your dashboard, click the three-dot menu (⋮) in the top right of the link card, and select Delete. Deleted links immediately return a 404. This action is permanent and cannot be undone.`,
  },
  {
    product: 'strk',
    title: 'STRK pricing and plans',
    content: `STRK offers a Free plan (up to 25 active links, basic analytics), a Pro plan ($9/month, unlimited links, custom domains, advanced analytics), and a Team plan ($29/month, collaborative workspaces, API access). All paid plans include a 14-day free trial.`,
  },

  // ── Cashpile ──────────────────────────────────────────────────────────────
  {
    product: 'cashpile',
    title: 'How does Cashpile work?',
    content: `Cashpile is a rewards and cashback platform. Connect your payment card, shop at participating retailers, and earn automatic cashback. Your earnings accumulate in your Cashpile balance and can be withdrawn to your bank account or redeemed for gift cards.`,
  },
  {
    product: 'cashpile',
    title: 'What payment methods does Cashpile support?',
    content: `Cashpile supports all major Visa, Mastercard, and American Express credit and debit cards. You can link multiple cards from the Cards section of your account settings. We use bank-grade encryption and never store full card numbers.`,
  },
  {
    product: 'cashpile',
    title: 'How do I withdraw my Cashpile earnings?',
    content: `Go to Wallet → Withdraw. Enter the amount (minimum $5) and choose your withdrawal method: bank transfer (1-3 business days) or instant to a linked debit card (small fee applies). Withdrawals are processed Monday–Friday during business hours.`,
  },
  {
    product: 'cashpile',
    title: 'Cashpile refund policy',
    content: `If a retailer issues a refund for a purchase, the corresponding cashback will be reversed from your Cashpile balance. If your balance goes negative, it will be offset against future earnings. For disputes, contact support within 30 days of the transaction.`,
  },
  {
    product: 'cashpile',
    title: 'Is my data secure with Cashpile?',
    content: `Yes. Cashpile uses 256-bit AES encryption for all stored data and TLS 1.3 for data in transit. We are PCI DSS Level 1 certified. We never sell your personal data to third parties. You can request a full data export or account deletion at any time from your account settings.`,
  },

  // ── TheDailyPost ──────────────────────────────────────────────────────────
  {
    product: 'dailypost',
    title: 'How does TheDailyPost generate content?',
    content: `TheDailyPost uses large language models to generate high-quality blog posts, social media updates, and newsletters tailored to your business niche. You set your topics, tone, and posting schedule — the AI handles the rest, producing original content daily.`,
  },
  {
    product: 'dailypost',
    title: 'Can I customise the AI tone and style?',
    content: `Absolutely. In Settings → Brand Voice, describe your brand personality (e.g. "professional but friendly", "playful and emoji-heavy") and provide up to 5 example posts you love. TheDailyPost will match your style across all generated content.`,
  },
  {
    product: 'dailypost',
    title: 'How often is content published?',
    content: `You choose your schedule. Options range from daily to weekly. For social media, you can set per-platform schedules (e.g. LinkedIn 3x/week, Twitter daily). All posts go through a review queue where you can approve, edit, or reject before publishing.`,
  },
  {
    product: 'dailypost',
    title: 'How do I connect my social accounts?',
    content: `Go to Integrations → Social Accounts. We support LinkedIn, Twitter/X, Facebook, Instagram, and Medium. Click Connect next to each platform and follow the OAuth flow. Permissions are read/write for posting only — we never access your messages or followers list.`,
  },
  {
    product: 'dailypost',
    title: 'TheDailyPost subscription and billing',
    content: `TheDailyPost offers a Starter plan ($19/month, 1 brand, up to 30 posts/month), a Growth plan ($49/month, 3 brands, unlimited posts), and an Agency plan ($149/month, unlimited brands, white-label options, priority support). All plans renew monthly and can be cancelled anytime.`,
  },
];

async function seed() {
  console.log(`Seeding ${articles.length} KB articles to ${BASE_URL}/api/kb ...\n`);
  let success = 0;
  let fail = 0;

  for (const article of articles) {
    try {
      const res = await fetch(`${BASE_URL}/api/kb`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(article),
      });
      const data = await res.json();
      if (res.ok) {
        console.log(`  ✓ [${article.product}] ${article.title}`);
        success++;
      } else {
        console.error(`  ✗ [${article.product}] ${article.title}: ${JSON.stringify(data)}`);
        fail++;
      }
    } catch (err) {
      console.error(`  ✗ [${article.product}] ${article.title}: ${err.message}`);
      fail++;
    }
    // Small delay to avoid rate-limiting the embedding API
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nDone. ${success} inserted, ${fail} failed.`);
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
