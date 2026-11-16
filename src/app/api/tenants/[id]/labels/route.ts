// GET  /api/tenants/[id]/labels — list labels (any member)
// POST /api/tenants/[id]/labels — create a label (owner or admin)

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantMember } from '@/lib/auth';
import { checkApiReadLimit, checkApiWriteLimit } from '@/lib/rate-limit';
import { createLabel, DuplicateLabelError, listLabels } from '@/lib/tickets/labels';

type Params = { params: Promise<{ id: string }> };

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const labelInputSchema = z
  .object({
    name: z.string().trim().min(1).max(50),
    color: z.string().regex(HEX_COLOR).optional(),
    description: z.string().max(500).nullable().optional(),
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

  return NextResponse.json(await listLabels(id));
}

export async function POST(request: NextRequest, { params }: Params) {
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

  const parsed = labelInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid label', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const label = await createLabel(id, parsed.data);
    return NextResponse.json(label, { status: 201 });
  } catch (err) {
    if (err instanceof DuplicateLabelError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
