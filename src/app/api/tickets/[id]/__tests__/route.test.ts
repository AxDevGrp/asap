import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const authState = vi.hoisted(() => ({ mode: 'ok' as 'ok' | '401' | '403' }));

const dbState = vi.hoisted(() => ({
  ticketExists: true,
  ownerIsMember: true,
  updatedTicket: {
    id: 'ticket-1',
    tenant_id: '00000000-0000-4000-8000-000000000010',
    status: 'resolved',
    priority: 'high',
    owner_id: null,
    title: 'Updated',
  } as Record<string, unknown>,
}));

const serviceMock = vi.hoisted(() => ({
  transitionTicket: vi.fn(),
  setPriority: vi.fn(),
  setOwner: vi.fn(),
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
      if (authState.mode === '403') {
        return {
          error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
        };
      }
      return { userId: 'user-1', email: 'user@example.test', role: 'agent' };
    }),
  };
});

vi.mock('@/lib/supabase', () => {
  class Query {
    private mode: 'read' | 'update' = 'read';
    constructor(private readonly table: string) {}
    select() {
      return this;
    }
    update() {
      this.mode = 'update';
      return this;
    }
    eq() {
      return this;
    }
    is() {
      return this;
    }
    in() {
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    or() {
      return this;
    }
    maybeSingle() {
      if (this.table === 'tickets') {
        return Promise.resolve({
          data:
            this.mode === 'read' && dbState.ticketExists
              ? { id: 'ticket-1' }
              : null,
          error: null,
        });
      }
      if (this.table === 'tenant_memberships') {
        return Promise.resolve({
          data: dbState.ownerIsMember ? { user_id: 'owner-1' } : null,
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    }
    single() {
      return Promise.resolve({ data: dbState.updatedTicket, error: null });
    }
    then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
      return Promise.resolve({ data: null, error: null }).then(
        onFulfilled,
        onRejected
      );
    }
  }

  return { supabase: { from: (table: string) => new Query(table) } };
});

vi.mock('@/lib/tickets/service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/tickets/service')>();
  return { ...actual, ...serviceMock };
});

import * as service from '@/lib/tickets/service';
import { GET, PATCH } from '../route';
import { GET as eventsGET } from '../events/route';

const TENANT = '00000000-0000-4000-8000-000000000010';
const OWNER = '00000000-0000-4000-8000-0000000000aa';
const params = { params: { id: 'ticket-1' } };

function patchRequest(body: unknown) {
  return new NextRequest(
    `http://localhost/api/tickets/ticket-1?tenant_id=${TENANT}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

function getRequest() {
  return new NextRequest(
    `http://localhost/api/tickets/ticket-1?tenant_id=${TENANT}`
  );
}

describe('PATCH /api/tickets/[id]', () => {
  beforeEach(() => {
    authState.mode = 'ok';
    dbState.ticketExists = true;
    dbState.ownerIsMember = true;
    vi.clearAllMocks();
    serviceMock.transitionTicket.mockResolvedValue({});
    serviceMock.setPriority.mockResolvedValue({});
    serviceMock.setOwner.mockResolvedValue({});
  });

  it('returns 404 for a ticket in another tenant', async () => {
    dbState.ticketExists = false;

    const res = await PATCH(patchRequest({ status: 'resolved' }), params);

    expect(res.status).toBe(404);
    expect(serviceMock.transitionTicket).not.toHaveBeenCalled();
  });

  it('returns 409 with from/to on an invalid transition', async () => {
    serviceMock.transitionTicket.mockRejectedValue(
      new service.InvalidTransitionError('todo', 'resolved')
    );

    const res = await PATCH(patchRequest({ status: 'resolved' }), params);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ from: 'todo', to: 'resolved' });
  });

  it('returns 400 on an invalid body', async () => {
    const res = await PATCH(patchRequest({ status: 'bogus' }), params);

    expect(res.status).toBe(400);
    expect(serviceMock.transitionTicket).not.toHaveBeenCalled();
  });

  it('returns 400 on an empty body', async () => {
    const res = await PATCH(patchRequest({}), params);

    expect(res.status).toBe(400);
    expect(serviceMock.transitionTicket).not.toHaveBeenCalled();
  });

  it('returns 400 when owner_id is not a tenant member', async () => {
    dbState.ownerIsMember = false;

    const res = await PATCH(patchRequest({ owner_id: OWNER }), params);

    expect(res.status).toBe(400);
    expect(serviceMock.setOwner).not.toHaveBeenCalled();
  });

  it('applies status first, then priority, owner and title', async () => {
    const res = await PATCH(
      patchRequest({
        status: 'resolved',
        priority: 'high',
        owner_id: OWNER,
        title: 'Updated',
      }),
      params
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticket: dbState.updatedTicket });

    expect(serviceMock.transitionTicket).toHaveBeenCalledWith(
      'ticket-1',
      'resolved',
      { type: 'user', id: 'user-1' },
      { tenantId: TENANT }
    );
    expect(serviceMock.setPriority).toHaveBeenCalledWith(
      'ticket-1',
      'high',
      { type: 'user', id: 'user-1' },
      { tenantId: TENANT }
    );
    expect(serviceMock.setOwner).toHaveBeenCalledWith(
      'ticket-1',
      OWNER,
      { type: 'user', id: 'user-1' },
      { tenantId: TENANT }
    );
    expect(
      serviceMock.transitionTicket.mock.invocationCallOrder[0]
    ).toBeLessThan(serviceMock.setPriority.mock.invocationCallOrder[0]);
  });
});

describe('GET /api/tickets/[id]', () => {
  beforeEach(() => {
    authState.mode = 'ok';
    dbState.ticketExists = true;
  });

  it('returns 404 for a ticket in another tenant', async () => {
    dbState.ticketExists = false;

    const res = await GET(getRequest(), params);

    expect(res.status).toBe(404);
  });
});

describe('GET /api/tickets/[id]/events', () => {
  beforeEach(() => {
    authState.mode = 'ok';
    dbState.ticketExists = true;
  });

  it('returns 404 for a ticket in another tenant', async () => {
    dbState.ticketExists = false;

    const res = await eventsGET(getRequest(), params);

    expect(res.status).toBe(404);
  });
});
