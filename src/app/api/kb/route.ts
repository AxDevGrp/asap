// Knowledge Base CRUD API — signed-in tenant members only.
// The tenant always comes from the caller's membership, never from the request
// alone. An optional tenant_id (query or body) only selects among tenants the
// caller belongs to.
//
// GET    /api/kb                       — list the caller's tenant articles
// POST   /api/kb                       — add article (auto-embeds)
// PUT    /api/kb?id=<uuid>             — update article (re-embeds on content change)
// DELETE /api/kb?id=<uuid>             — delete article

import { NextRequest, NextResponse } from 'next/server';
import { createKBArticle, listKBArticles, updateKBArticle, deleteKBArticle } from '@/lib/db';
import { createSupabaseServerClient } from '@/lib/supabase-server';
import { getTenantById } from '@/lib/tenant';
import { checkApiReadLimit, checkApiWriteLimit } from '@/lib/rate-limit';
import { unauthorizedResponse, forbiddenResponse } from '@/lib/auth';

const MAX_TITLE = 300;
const MAX_CONTENT = 20_000;

type KbAuth = { tenantId: string } | { error: NextResponse };

/** Resolve the signed-in user's tenant, optionally narrowed to `requestedTenantId`. */
async function authorize(requestedTenantId?: string | null): Promise<KbAuth> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: unauthorizedResponse() };

  const { data: memberships, error } = await supabase
    .from('tenant_memberships')
    .select('tenant_id')
    .eq('user_id', user.id);

  if (error) {
    console.error('[KB] membership lookup failed:', error.message);
    return { error: NextResponse.json({ error: 'Membership lookup failed' }, { status: 500 }) };
  }

  const tenantIds = (memberships ?? []).map((m) => m.tenant_id as string);
  if (tenantIds.length === 0) return { error: forbiddenResponse('You are not a member of any workspace') };

  if (requestedTenantId) {
    if (!tenantIds.includes(requestedTenantId)) {
      return { error: forbiddenResponse('You are not a member of this workspace') };
    }
    return { tenantId: requestedTenantId };
  }
  return { tenantId: tenantIds[0] };
}

function rateLimited() {
  return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
}

function validate(title: unknown, content: unknown, partial: boolean): string | null {
  if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE)) {
    return `title must be a non-empty string up to ${MAX_TITLE} characters`;
  }
  if (content !== undefined && (typeof content !== 'string' || !content.trim() || content.length > MAX_CONTENT)) {
    return `content must be a non-empty string up to ${MAX_CONTENT} characters`;
  }
  if (!partial && (title === undefined || content === undefined)) {
    return 'Missing required fields: title, content';
  }
  return null;
}

export async function GET(request: NextRequest) {
  const auth = await authorize(request.nextUrl.searchParams.get('tenant_id'));
  if ('error' in auth) return auth.error;
  if (!checkApiReadLimit(auth.tenantId)) return rateLimited();

  const articles = await listKBArticles(auth.tenantId);
  return NextResponse.json({ articles, count: articles.length });
}

export async function POST(request: NextRequest) {
  let body: { title?: unknown; content?: unknown; tenant_id?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const auth = await authorize(body.tenant_id);
  if ('error' in auth) return auth.error;
  if (!checkApiWriteLimit(auth.tenantId)) return rateLimited();

  const invalid = validate(body.title, body.content, false);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  // Product label is the tenant slug (server-side, not client-supplied).
  const tenant = await getTenantById(auth.tenantId);
  const product = tenant?.slug ?? 'unknown';

  const article = await createKBArticle({
    product,
    title: (body.title as string).trim(),
    content: (body.content as string).trim(),
    tenant_id: auth.tenantId,
  });
  if (!article) {
    return NextResponse.json({ error: 'Failed to create article' }, { status: 500 });
  }
  return NextResponse.json({ article }, { status: 201 });
}

export async function PUT(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'Missing required param: id' }, { status: 400 });
  }

  let body: { title?: unknown; content?: unknown; tenant_id?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const auth = await authorize(body.tenant_id);
  if ('error' in auth) return auth.error;
  if (!checkApiWriteLimit(auth.tenantId)) return rateLimited();

  if (body.title === undefined && body.content === undefined) {
    return NextResponse.json(
      { error: 'Must provide at least one field to update: title, content' },
      { status: 400 }
    );
  }
  const invalid = validate(body.title, body.content, true);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  const updates: { title?: string; content?: string } = {};
  if (typeof body.title === 'string') updates.title = body.title.trim();
  if (typeof body.content === 'string') updates.content = body.content.trim();

  // Scoped to the caller's tenant: another tenant's article id simply isn't found.
  const article = await updateKBArticle(id, updates, auth.tenantId);
  if (!article) {
    return NextResponse.json({ error: 'Update failed or article not found' }, { status: 404 });
  }
  return NextResponse.json({ article });
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'Missing required param: id' }, { status: 400 });
  }

  const auth = await authorize(request.nextUrl.searchParams.get('tenant_id'));
  if ('error' in auth) return auth.error;
  if (!checkApiWriteLimit(auth.tenantId)) return rateLimited();

  const ok = await deleteKBArticle(id, auth.tenantId);
  if (!ok) {
    return NextResponse.json({ error: 'Delete failed or article not found' }, { status: 404 });
  }
  return NextResponse.json({ deleted: id });
}
