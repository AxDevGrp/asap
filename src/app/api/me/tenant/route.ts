// GET /api/me/tenant — returns the primary tenant for the authenticated user
// Used by client components to determine their tenant context

import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase-server';

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Get the user's primary tenant membership
  const { data: membership, error } = await supabase
    .from('tenant_memberships')
    .select('tenant_id, role, tenants(id, name, slug, domain)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

  if (error || !membership) {
    return NextResponse.json({ error: 'No tenant found' }, { status: 404 });
  }

  const tenant = (membership as any).tenants;

  return NextResponse.json({
    tenantId: tenant?.id ?? membership.tenant_id,
    tenantName: tenant?.name ?? null,
    tenantSlug: tenant?.slug ?? null,
    tenantDomain: tenant?.domain ?? null,
    role: membership.role,
  });
}
