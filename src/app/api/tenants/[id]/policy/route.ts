// GET  /api/tenants/[id]/policy — read the auto-resolve policy (any member)
// PUT  /api/tenants/[id]/policy — update the policy (owner or admin)

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantMember } from '@/lib/auth';
import { checkApiReadLimit, checkApiWriteLimit } from '@/lib/rate-limit';
import { getTenantPolicy, updateTenantPolicy } from '@/lib/policies';

type Params = { params: Promise<{ id: string }> };

const TICKET_TYPES = ['question', 'billing', 'feature_request', 'bug', 'other'] as const;
const URGENCIES = ['low', 'medium', 'high', 'critical'] as const;

const policyPatchSchema = z
  .object({
    autoSendEnabled: z.boolean().optional(),
    confidenceThreshold: z.number().min(0).max(1).optional(),
    allowedTypes: z.array(z.enum(TICKET_TYPES)).optional(),
    allowedUrgencies: z.array(z.enum(URGENCIES)).optional(),
    minKbSimilarity: z.number().min(0).max(1).optional(),
    minKbHits: z.number().int().min(0).max(20).optional(),
    resolveOnAutoSend: z.boolean().optional(),
  })
  .strict();

function rateLimited() {
  return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
}

export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const member = await requireTenantMember(id);
  if ('error' in member) return member.error;
  if (!checkApiReadLimit(id)) return rateLimited();

  const policy = await getTenantPolicy(id);
  return NextResponse.json(policy);
}

export async function PUT(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const member = await requireTenantMember(id, ['owner', 'admin']);
  if ('error' in member) return member.error;
  if (!checkApiWriteLimit(id)) return rateLimited();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = policyPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid policy', issues: parsed.error.issues },
      { status: 400 }
    );
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  const policy = await updateTenantPolicy(id, parsed.data, member.userId);
  if (!policy) {
    return NextResponse.json({ error: 'Failed to update policy' }, { status: 500 });
  }
  return NextResponse.json(policy);
}
