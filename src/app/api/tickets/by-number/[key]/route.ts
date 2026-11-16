// GET /api/tickets/by-number/[key] — fetch a ticket by its tenant key (GOA-123).
//
// The key prefix must match the caller tenant's ticket_prefix; anything else is
// a 404 (never 403) so keys from other tenants do not leak.

import { NextRequest, NextResponse } from 'next/server';
import { checkApiReadLimit } from '@/lib/rate-limit';
import {
  getTenantTicketPrefix,
  loadTicketDetail,
  parseTicketKey,
  resolveCallerTenant,
} from '@/lib/tickets/query';

type Params = { params: { key: string } };

function notFound() {
  return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
}

export async function GET(request: NextRequest, { params }: Params) {
  const tenant = await resolveCallerTenant(request);
  if ('error' in tenant) return tenant.error;

  if (!checkApiReadLimit(tenant.tenantId)) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const parsed = parseTicketKey(params.key);
  if (!parsed) return notFound();

  const prefix = await getTenantTicketPrefix(tenant.tenantId);
  if (!prefix || parsed.prefix !== prefix.toUpperCase()) return notFound();

  const detail = await loadTicketDetail(tenant.tenantId, {
    number: parsed.number,
  });
  if (!detail) return notFound();

  return NextResponse.json(detail);
}
