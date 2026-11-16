import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const authState = vi.hoisted(() => ({ mode: 'ok' as 'ok' | '401' }));

const dbState = vi.hoisted(() => ({
  prefix: 'GOA' as string | null,
  ticket: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/auth', async () => {
  const { NextResponse } = await import('next/server');
  return {
    requireTenantMember: vi.fn(async () => {
      if (authState.mode === '401') {
        return {
          error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
        };
      }
      return { userId: 'user-1', email: 'user@example.test', role: 'agent' };
    }),
  };
});

vi.mock('@/lib/supabase', () => {
  class Query {
    constructor(private readonly table: string) {}
    select() {
      return this;
    }
    eq() {
      return this;
    }
    order() {
      return this;
    }
    maybeSingle() {
      if (this.table === 'tenants') {
        return Promise.resolve({
          data:
            dbState.prefix === null
              ? null
              : { ticket_prefix: dbState.prefix },
          error: null,
        });
      }
      if (this.table === 'tickets') {
        return Promise.resolve({ data: dbState.ticket, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }
    then(
      onFulfilled: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) {
      return Promise.resolve({ data: [], error: null }).then(
        onFulfilled,
        onRejected
      );
    }
  }

  return { supabase: { from: (table: string) => new Query(table) } };
});

import { GET } from '../[key]/route';

const TENANT = '00000000-0000-4000-8000-000000000010';
const params = (key: string) => ({ params: { key } });

function request() {
  return new NextRequest(
    `http://localhost/api/tickets/by-number?tenant_id=${TENANT}`
  );
}

describe('GET /api/tickets/by-number/[key]', () => {
  beforeEach(() => {
    authState.mode = 'ok';
    dbState.prefix = 'GOA';
    dbState.ticket = null;
  });

  it('returns 401 when unauthenticated', async () => {
    authState.mode = '401';

    const res = await GET(request(), params('GOA-1'));

    expect(res.status).toBe(401);
  });

  it('returns 404 for a malformed key', async () => {
    const res = await GET(request(), params('nope'));

    expect(res.status).toBe(404);
  });

  it('returns 404 when the prefix is not the tenant prefix', async () => {
    const res = await GET(request(), params('ABC-1'));

    expect(res.status).toBe(404);
  });

  it('returns 404 when the number does not exist in the tenant', async () => {
    const res = await GET(request(), params('goa-99'));

    expect(res.status).toBe(404);
  });

  it('returns the same shape as the id route when found', async () => {
    dbState.ticket = { id: 'ticket-1', number: 5, tenant_id: TENANT };

    const res = await GET(request(), params('GOA-5'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ticket: dbState.ticket,
      messages: [],
      outboundMessages: [],
    });
  });
});
