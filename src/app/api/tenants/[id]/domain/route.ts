// POST  /api/tenants/[id]/domain — register tenant domain with Resend
// GET   /api/tenants/[id]/domain — get current Resend domain status
// PATCH /api/tenants/[id]/domain — trigger domain verification check

import { NextRequest, NextResponse } from 'next/server';
import { getTenantById, updateTenant } from '@/lib/tenant';
import {
  registerResendDomain,
  getResendDomainStatus,
  verifyResendDomain,
} from '@/lib/resend';

type Params = { params: Promise<{ id: string }> };

/**
 * GET — fetch Resend domain status for this tenant.
 * Returns domain verification records and current status.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;

  const tenant = await getTenantById(id);
  if (!tenant) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  if (!tenant.resend_domain_id) {
    return NextResponse.json({
      status: 'not_registered',
      message: 'No Resend domain registered yet. POST to this endpoint to register.',
      domain: tenant.domain,
    });
  }

  const domainStatus = await getResendDomainStatus(tenant.resend_domain_id);
  if (!domainStatus) {
    return NextResponse.json(
      { error: 'Failed to fetch domain status from Resend' },
      { status: 502 }
    );
  }

  return NextResponse.json({
    tenant_id: tenant.id,
    domain: tenant.domain,
    resend_domain_id: tenant.resend_domain_id,
    status: domainStatus.status,
    records: domainStatus.records,
    created_at: domainStatus.created_at,
  });
}

/**
 * POST — register the tenant's domain with Resend.
 * Saves the resend_domain_id back to the tenants table.
 * Optional body: { region: "us-east-1" | "eu-west-1" }
 */
export async function POST(request: NextRequest, { params }: Params) {
  const { id } = await params;

  const tenant = await getTenantById(id);
  if (!tenant) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  if (tenant.resend_domain_id) {
    return NextResponse.json(
      {
        error: 'Domain already registered',
        resend_domain_id: tenant.resend_domain_id,
        hint: 'Use PATCH to trigger verification, or GET to check status.',
      },
      { status: 409 }
    );
  }

  let region: 'us-east-1' | 'eu-west-1' = 'us-east-1';
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.region === 'eu-west-1') region = 'eu-west-1';
  } catch { /* use default */ }

  const result = await registerResendDomain(tenant.domain, region);
  if (!result) {
    return NextResponse.json(
      { error: 'Failed to register domain with Resend. Check RESEND_API_KEY.' },
      { status: 502 }
    );
  }

  // Persist the Resend domain ID to the tenant record
  await updateTenant(id, { resend_domain_id: result.id });

  return NextResponse.json({
    tenant_id: tenant.id,
    domain: tenant.domain,
    resend_domain_id: result.id,
    dns_records: result.records,
    next_steps: [
      '1. Add the DNS records above to your domain registrar.',
      '2. Wait for DNS propagation (can take up to 48h).',
      '3. PATCH this endpoint to trigger Resend verification check.',
      '4. Check GET this endpoint to confirm status is "verified".',
    ],
  }, { status: 201 });
}

/**
 * PATCH — trigger a Resend domain verification check.
 * Call this after DNS records have been added.
 */
export async function PATCH(_request: NextRequest, { params }: Params) {
  const { id } = await params;

  const tenant = await getTenantById(id);
  if (!tenant) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  if (!tenant.resend_domain_id) {
    return NextResponse.json(
      { error: 'No Resend domain registered yet. POST first.' },
      { status: 400 }
    );
  }

  const success = await verifyResendDomain(tenant.resend_domain_id);
  if (!success) {
    return NextResponse.json(
      { error: 'Verification check failed. DNS records may not have propagated yet.' },
      { status: 502 }
    );
  }

  // Fetch updated status
  const domainStatus = await getResendDomainStatus(tenant.resend_domain_id);

  return NextResponse.json({
    tenant_id: tenant.id,
    domain: tenant.domain,
    resend_domain_id: tenant.resend_domain_id,
    status: domainStatus?.status ?? 'unknown',
    message:
      domainStatus?.status === 'verified'
        ? 'Domain verified! Outbound email is ready.'
        : 'Verification triggered. DNS propagation may still be in progress.',
  });
}
