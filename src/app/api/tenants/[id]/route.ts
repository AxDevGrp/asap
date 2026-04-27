// GET    /api/tenants/[id]            — get tenant by ID
// PATCH  /api/tenants/[id]            — update tenant
// GET    /api/tenants/[id]/dns-records — get DNS records for tenant domain

import { NextRequest, NextResponse } from 'next/server';
import { getTenantById, updateTenant } from '@/lib/tenant';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const tenant = await getTenantById(id);
  if (!tenant) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }
  return NextResponse.json(tenant);
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const tenant = await updateTenant(id, body as Parameters<typeof updateTenant>[1]);
  if (!tenant) {
    return NextResponse.json({ error: 'Tenant not found or update failed' }, { status: 404 });
  }
  return NextResponse.json(tenant);
}
