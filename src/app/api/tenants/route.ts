// POST /api/tenants — create a new tenant
// GET  /api/tenants — list all tenants

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { listTenants } from '@/lib/tenant';
import { createSupabaseAdminClient } from '@/lib/supabase-server';

export async function GET() {
  const tenants = await listTenants();
  return NextResponse.json(tenants);
}

export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          },
        },
      }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse and validate body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const { name, slug, domain } = body as Record<string, unknown>;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    if (!domain || typeof domain !== 'string' || domain.trim().length === 0) {
      return NextResponse.json({ error: 'Domain is required' }, { status: 400 });
    }

    if (!slug || typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug)) {
      return NextResponse.json(
        { error: 'Slug must contain only lowercase letters, numbers, and hyphens' },
        { status: 400 }
      );
    }

    const admin = createSupabaseAdminClient();

    // Create tenant
    const { data: tenant, error: tenantError } = await admin
      .from('tenants')
      .insert({
        name: name.trim(),
        slug: slug.trim(),
        domain: domain.trim(),
        settings: {},
      })
      .select()
      .single();

    if (tenantError || !tenant) {
      console.error('[Tenants API] create tenant error:', tenantError);
      return NextResponse.json(
        { error: tenantError?.message ?? 'Failed to create tenant' },
        { status: 500 }
      );
    }

    // Create owner membership
    const { error: membershipError } = await admin
      .from('tenant_memberships')
      .insert({
        user_id: user.id,
        tenant_id: tenant.id,
        role: 'owner',
      });

    if (membershipError) {
      console.error('[Tenants API] create membership error:', membershipError);
      return NextResponse.json(
        { error: membershipError.message },
        { status: 500 }
      );
    }

    return NextResponse.json(tenant, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[Tenants API] unexpected error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
