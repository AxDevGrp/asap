// GET    /api/tenants/[id]            — get tenant (any member)
// PATCH  /api/tenants/[id]            — update name/settings (owner or admin)
// Domain changes go through /api/tenants/[id]/domain so they get verified.

import { NextRequest, NextResponse } from 'next/server';
import { getTenantById, updateTenant } from '@/lib/tenant';
import { requireTenantMember } from '@/lib/auth';
import { checkApiReadLimit, checkApiWriteLimit } from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string }> };

function rateLimited() {
  return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
}

export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const member = await requireTenantMember(id);
  if ('error' in member) return member.error;
  if (!checkApiReadLimit(id)) return rateLimited();

  const tenant = await getTenantById(id);
  if (!tenant) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }
  return NextResponse.json(tenant);
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const member = await requireTenantMember(id, ['owner', 'admin']);
  if ('error' in member) return member.error;
  if (!checkApiWriteLimit(id)) return rateLimited();

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 });
  }

  const current = await getTenantById(id);
  if (!current) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  // Domain fields may be echoed back unchanged by the settings form, but can't
  // be changed here: that would skip Resend domain verification.
  if (
    (body.domain !== undefined && body.domain !== current.domain) ||
    (body.resend_domain_id !== undefined && (body.resend_domain_id || null) !== current.resend_domain_id)
  ) {
    return NextResponse.json(
      { error: 'Change the domain from domain setup, not settings' },
      { status: 400 }
    );
  }

  // Only these fields are editable; id, slug, domain, timestamps are not.
  const updates: { name?: string; settings?: Record<string, unknown> } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120) {
      return NextResponse.json({ error: 'name must be 1-120 characters' }, { status: 400 });
    }
    updates.name = body.name.trim();
  }
  if (body.settings !== undefined) {
    if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings)) {
      return NextResponse.json({ error: 'settings must be an object' }, { status: 400 });
    }
    updates.settings = body.settings as Record<string, unknown>;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update (name, settings)' }, { status: 400 });
  }

  const tenant = await updateTenant(id, updates);
  if (!tenant) {
    return NextResponse.json({ error: 'Tenant not found or update failed' }, { status: 404 });
  }
  return NextResponse.json(tenant);
}
