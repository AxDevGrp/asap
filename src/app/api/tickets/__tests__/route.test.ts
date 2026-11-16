import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const authState = vi.hoisted(() => ({ mode: 'ok' as 'ok' | '401' | '403' }));

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

vi.mock('@/lib/tickets/query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tickets/query')>();
  return { ...actual, listTickets: vi.fn() };
});

import * as query from '@/lib/tickets/query';
import { GET } from '../route';

const TENANT = '00000000-0000-4000-8000-000000000010';
const listTickets = vi.mocked(query.listTickets);

function request(query: string) {
  return new NextRequest(`http://localhost/api/tickets?${query}`);
}

describe('GET /api/tickets', () => {
  beforeEach(() => {
    authState.mode = 'ok';
    listTickets.mockReset();
  });

  it('returns 401 when unauthenticated', async () => {
    authState.mode = '401';

    const res = await GET(request(`tenant_id=${TENANT}`));

    expect(res.status).toBe(401);
    expect(listTickets).not.toHaveBeenCalled();
  });

  it('returns 403 when tenant_id is not a membership', async () => {
    authState.mode = '403';

    const res = await GET(request(`tenant_id=${TENANT}`));

    expect(res.status).toBe(403);
    expect(listTickets).not.toHaveBeenCalled();
  });

  it('returns 403 for a malformed tenant_id', async () => {
    const res = await GET(request('tenant_id=not-a-uuid'));

    expect(res.status).toBe(403);
    expect(listTickets).not.toHaveBeenCalled();
  });

  it('returns 400 with issues for invalid query params', async () => {
    const res = await GET(request(`tenant_id=${TENANT}&status=bogus`));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues).toBeTruthy();
    expect(listTickets).not.toHaveBeenCalled();
  });

  it('returns a page of tickets and passes built filters through', async () => {
    listTickets.mockResolvedValue({
      tickets: [{ id: 'ticket-1', key: 'GOA-1' } as never],
      nextCursor: 'next',
    });

    const res = await GET(
      request(
        `tenant_id=${TENANT}&status=todo,resolved&priority=high&owner=me&sort=priority&limit=10`
      )
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tickets: [{ id: 'ticket-1', key: 'GOA-1' }],
      nextCursor: 'next',
    });
    expect(listTickets).toHaveBeenCalledTimes(1);
    expect(listTickets).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        statuses: ['todo', 'resolved'],
        priorities: ['high'],
        owner: { kind: 'id', id: 'user-1' },
        sort: { key: 'priority', column: 'priority_rank', ascending: false },
        limit: 10,
      })
    );
  });
});
