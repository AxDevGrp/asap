// POST /api/tenants — create a new tenant
// GET  /api/tenants — list all tenants

import { NextRequest, NextResponse } from 'next/server';
import { listTenants, createTenant } from '@/lib/tenant';

export async function GET() {
  const tenants = await listTenants();
  return NextResponse.json(tenants);
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { name, slug, domain, chatwoot_account_id, chatwoot_inbox_id, resend_domain_id, settings } =
    body as Record<string, unknown>;

  if (!name || !slug || !domain) {
    return NextResponse.json(
      { error: 'name, slug, and domain are required' },
      { status: 400 }
    );
  }

  const tenant = await createTenant({
    name: name as string,
    slug: slug as string,
    domain: domain as string,
    chatwoot_account_id: chatwoot_account_id as number | undefined,
    chatwoot_inbox_id: chatwoot_inbox_id as number | undefined,
    resend_domain_id: resend_domain_id as string | undefined,
    settings: settings as Record<string, unknown> | undefined,
  });

  if (!tenant) {
    return NextResponse.json({ error: 'Failed to create tenant' }, { status: 500 });
  }

  return NextResponse.json(tenant, { status: 201 });
}
