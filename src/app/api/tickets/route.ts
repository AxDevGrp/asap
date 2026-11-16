// GET /api/tickets — paginated, filtered ticket list for the caller's tenant.

import { NextRequest, NextResponse } from 'next/server';
import { checkApiReadLimit } from '@/lib/rate-limit';
import {
  buildTicketFilters,
  InvalidCursorError,
  listTickets,
  resolveCallerTenant,
  ticketListQuerySchema,
} from '@/lib/tickets/query';

function rateLimited() {
  return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
}

export async function GET(request: NextRequest) {
  const tenant = await resolveCallerTenant(request);
  if ('error' in tenant) return tenant.error;

  if (!checkApiReadLimit(tenant.tenantId)) return rateLimited();

  const parsed = ticketListQuerySchema.safeParse(request.nextUrl.searchParams);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid query', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const filters = buildTicketFilters(parsed.data, {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
    });
    const result = await listTickets(filters);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof InvalidCursorError) {
      return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 });
    }
    throw err;
  }
}
