// Knowledge Base CRUD API — tenant-scoped
// GET    /api/kb?tenant_id=xxx         — list articles for tenant
// GET    /api/kb?product=strk          — list articles by product (legacy)
// POST   /api/kb                       — add article (auto-embeds)
// PUT    /api/kb?id=<uuid>             — update article (re-embeds on content change)
// DELETE /api/kb?id=<uuid>             — delete article

import { NextRequest, NextResponse } from 'next/server';
import { createKBArticle, listKBArticles, updateKBArticle, deleteKBArticle } from '@/lib/db';
import { createSupabaseServerClient } from '@/lib/supabase-server';

async function getAuthenticatedTenantId(): Promise<string | null> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    const { data: membership } = await supabase
      .from('tenant_memberships')
      .select('tenant_id')
      .eq('user_id', user.id)
      .limit(1)
      .single();

    return membership?.tenant_id ?? null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const tenantId = request.nextUrl.searchParams.get('tenant_id') ?? undefined;
  const product = request.nextUrl.searchParams.get('product') ?? undefined;

  // If no explicit tenant_id param, try to resolve from session
  let resolvedTenantId = tenantId;
  if (!resolvedTenantId) {
    resolvedTenantId = (await getAuthenticatedTenantId()) ?? undefined;
  }

  const articles = await listKBArticles(product, resolvedTenantId);
  return NextResponse.json({ articles, count: articles.length });
}

export async function POST(request: NextRequest) {
  let body: { product?: string; title?: string; content?: string; tenant_id?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { title, content } = body;
  if (!title || !content) {
    return NextResponse.json(
      { error: 'Missing required fields: title, content' },
      { status: 400 }
    );
  }

  // Resolve tenant_id from request body or session
  let tenantId = body.tenant_id ?? null;
  if (!tenantId) {
    tenantId = await getAuthenticatedTenantId();
  }

  // Product defaults to 'unknown' if not specified
  const product = body.product ?? 'unknown';

  const article = await createKBArticle({ product, title, content, tenant_id: tenantId });
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

  let body: { product?: string; title?: string; content?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.product && !body.title && !body.content) {
    return NextResponse.json(
      { error: 'Must provide at least one field to update: product, title, content' },
      { status: 400 }
    );
  }

  const article = await updateKBArticle(id, body);
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

  const ok = await deleteKBArticle(id);
  if (!ok) {
    return NextResponse.json({ error: 'Delete failed or article not found' }, { status: 404 });
  }
  return NextResponse.json({ deleted: id });
}
