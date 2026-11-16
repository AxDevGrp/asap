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
  DuplicateLabelError: class DuplicateLabelError extends Error {
    constructor() {
      super('A label with that name already exists');
      this.name = 'DuplicateLabelError';
    }
  },
  LabelNotFoundError: class LabelNotFoundError extends Error {
    constructor() {
      super('Label not found');
      this.name = 'LabelNotFoundError';
    }
  },
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

import { GET, POST } from '../route';

function request(method: string, body?: unknown) {
  return new NextRequest('http://localhost/api/tenants/tenant-1/labels', {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const params = { params: Promise.resolve({ id: 'tenant-1' }) };

describe('tenant labels route', () => {
  beforeEach(() => {
    authState.role = 'owner';
    vi.clearAllMocks();
  });

  it('GET lists labels for an agent', async () => {
    authState.role = 'agent';
    labelsMock.listLabels.mockResolvedValue([{ id: 'label-1', name: 'bug' }]);

    const res = await GET(request('GET'), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'label-1', name: 'bug' }]);
    expect(labelsMock.listLabels).toHaveBeenCalledWith('tenant-1');
  });

  it('returns 401 when unauthenticated', async () => {
    authState.role = null;

    const res = await POST(request('POST', { name: 'bug' }), params);

    expect(res.status).toBe(401);
    expect(labelsMock.createLabel).not.toHaveBeenCalled();
  });

  it('returns 403 when an agent creates a label', async () => {
    authState.role = 'agent';

    const res = await POST(request('POST', { name: 'bug' }), params);

    expect(res.status).toBe(403);
    expect(labelsMock.createLabel).not.toHaveBeenCalled();
  });

  it('returns 409 on a duplicate label name', async () => {
    labelsMock.createLabel.mockRejectedValue(new labelsMock.DuplicateLabelError());

    const res = await POST(request('POST', { name: 'bug' }), params);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'A label with that name already exists',
    });
  });

  it('creates a label for an owner and returns 201', async () => {
    labelsMock.createLabel.mockResolvedValue({ id: 'label-1', name: 'bug' });

    const res = await POST(request('POST', { name: ' bug ' }), params);

    expect(res.status).toBe(201);
    expect(labelsMock.createLabel).toHaveBeenCalledWith('tenant-1', { name: 'bug' });
  });
});
