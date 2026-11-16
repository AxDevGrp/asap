import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const authState = vi.hoisted(() => ({ role: null as string | null }));

const labelsMock = vi.hoisted(() => ({
  listLabels: vi.fn(),
  createLabel: vi.fn(),
  updateLabel: vi.fn(),
  deleteLabel: vi.fn(),
  addLabel: vi.fn(),
  removeLabel: vi.fn(),
  listTicketLabels: vi.fn(),
  DuplicateLabelError: class DuplicateLabelError extends Error {},
  LabelNotFoundError: class LabelNotFoundError extends Error {},
}));

const supabaseMock = vi.hoisted(() => ({
  from: vi.fn(() => ({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () => ({
          data: { tenant_id: 'tenant-1' },
          error: null,
        })),
      })),
    })),
  })),
}));

vi.mock('@/lib/auth', async () => {
  const { NextResponse } = await import('next/server');
  return {
    requireTenantMember: vi.fn(async (_tenantId: string, roles?: string[]) => {
      if (!authState.role) {
        return {
          error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
        };
      }
      if (roles && !roles.includes(authState.role)) {
        return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
      }
      return { userId: 'user-1', email: 'user@example.test', role: authState.role };
    }),
  };
});

vi.mock('@/lib/tickets/labels', () => labelsMock);
vi.mock('@/lib/supabase', () => ({ supabase: supabaseMock }));

import { DELETE, POST } from '../route';

const TICKET_ID = 'ticket-1';
const LABEL_ID = '11111111-1111-1111-1111-111111111111';
const params = { params: Promise.resolve({ id: TICKET_ID }) };

function request(method: string, body?: unknown, query = '') {
  return new NextRequest(
    `http://localhost/api/tickets/${TICKET_ID}/labels${query}`,
    {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }
  );
}

describe('ticket labels route', () => {
  beforeEach(() => {
    authState.role = 'agent';
    vi.clearAllMocks();
    labelsMock.listTicketLabels.mockResolvedValue([{ id: LABEL_ID, name: 'bug' }]);
  });

  it('lets an agent add a label and returns the ticket labels', async () => {
    labelsMock.addLabel.mockResolvedValue({ id: LABEL_ID, name: 'bug' });

    const res = await POST(request('POST', { labelId: LABEL_ID }), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: LABEL_ID, name: 'bug' }]);
    expect(labelsMock.addLabel).toHaveBeenCalledWith(
      TICKET_ID,
      LABEL_ID,
      { type: 'user', id: 'user-1' },
      { tenantId: 'tenant-1' }
    );
  });

  it('removes a label using ?labelId=', async () => {
    labelsMock.removeLabel.mockResolvedValue({ id: LABEL_ID, name: 'bug' });

    const res = await DELETE(
      request('DELETE', undefined, `?labelId=${LABEL_ID}`),
      params
    );

    expect(res.status).toBe(200);
    expect(labelsMock.removeLabel).toHaveBeenCalled();
  });

  it('returns 404 when the label is not in the tenant', async () => {
    labelsMock.addLabel.mockRejectedValue(new labelsMock.LabelNotFoundError());

    const res = await POST(request('POST', { labelId: LABEL_ID }), params);

    expect(res.status).toBe(404);
  });
});
