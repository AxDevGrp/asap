// GET /api/tenants/[id]/dns-records
// Returns the DNS records a tenant needs to set up for their custom domain
// (SPF, DKIM, MX, DMARC, plus Resend domain status if available)

import { NextRequest, NextResponse } from 'next/server';
import { getTenantById } from '@/lib/tenant';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;

  const tenant = await getTenantById(id);
  if (!tenant) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  const domain = tenant.domain;

  // Standard email DNS records for the tenant domain
  const records = [
    {
      type: 'MX',
      host: domain,
      value: 'mx.resend.com',
      priority: 10,
      purpose: 'Inbound email routing (Resend)',
    },
    {
      type: 'TXT',
      host: domain,
      value: `v=spf1 include:amazonses.com ~all`,
      purpose: 'SPF — authorise Resend to send on your behalf',
    },
    {
      type: 'TXT',
      host: `_dmarc.${domain}`,
      value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}; ruf=mailto:dmarc@${domain}; fo=1`,
      purpose: 'DMARC policy',
    },
    {
      type: 'CNAME',
      host: `resend._domainkey.${domain}`,
      value: 'resend._domainkey.resend.com',
      purpose: 'DKIM signing key (Resend)',
      note: 'Actual DKIM record provided by Resend after domain registration',
    },
  ];

  // If this tenant has a Resend domain, include a note about fetching DKIM from Resend
  const resendNote = tenant.resend_domain_id
    ? `Resend domain ID: ${tenant.resend_domain_id}. Check Resend dashboard for actual DKIM records.`
    : 'No Resend domain registered yet. Use POST /api/tenants/:id to set resend_domain_id after registering.';

  return NextResponse.json({
    tenant_id: tenant.id,
    domain,
    records,
    notes: [
      resendNote,
      'After adding these records, domain verification may take up to 48 hours.',
      'DKIM records will be provided by Resend after you register the domain in their dashboard.',
    ],
  });
}
