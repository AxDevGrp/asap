// PATCH  /api/tenants/[id]/labels/[labelId] — rename / recolor (owner or admin)
// DELETE /api/tenants/[id]/labels/[labelId] — delete a label (owner or admin)

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantMember } from '@/lib/auth';
import { checkApiWriteLimit } from '@/lib/rate-limit';
import {
  deleteLabel,
  DuplicateLabelError,
  LabelNotFoundError,
  updateLabel,
} from '@/lib/tickets/labels';

type Params = { params: Promise<{ id: string; labelId: string }> };

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const labelPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(50).optional(),
    color: z.string().regex(HEX_COLOR).optional(),
    description: z.string().max(500).nullable().optional(),
  })
  .strict();

function rateLimited() {
  return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id, labelId } = await params;
  const member = await requireTenantMember(id, ['owner', 'admin']);
  if ('error' in member) return member.error;
  if (!checkApiWriteLimit(id)) return rateLimited();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = labelPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid label', issues: parsed.error.issues },
      { status: 400 }
    );
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  try {
    return NextResponse.json(await updateLabel(id, labelId, parsed.data));
  } catch (err) {
    if (err instanceof DuplicateLabelError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof LabelNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { id, labelId } = await params;
  const member = await requireTenantMember(id, ['owner', 'admin']);
  if ('error' in member) return member.error;
  if (!checkApiWriteLimit(id)) return rateLimited();

  try {
    await deleteLabel(id, labelId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof LabelNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}
