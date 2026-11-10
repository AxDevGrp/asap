import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase-server';

export interface AuthContext {
  userId: string;
  email: string;
}

/**
 * Resolve the authenticated user from the current request.
 * Returns the user context or null if unauthenticated.
 *
 * Usage in API route handlers:
 *   const auth = await requireAuth(req);
 *   if (!auth) return; // response already sent
 *   const { userId } = auth;
 */
export async function requireAuth(
  req: NextRequest
): Promise<AuthContext | null> {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return null;
  }

  return { userId: user.id, email: user.email ?? '' };
}

/**
 * Get tenant membership for the current user.
 * Returns the tenant_id and role, or null if not a member.
 */
export async function getUserTenantMembership(
  userId: string,
  tenantId?: string
): Promise<{ tenantId: string; role: string } | null> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('tenant_memberships')
    .select('tenant_id, role')
    .eq('user_id', userId);

  if (tenantId) {
    query = query.eq('tenant_id', tenantId);
  }

  const { data, error } = await query.single();

  if (error || !data) return null;

  return { tenantId: data.tenant_id, role: data.role };
}

/**
 * Convenience helper: returns 401 JSON response.
 */
export function unauthorizedResponse() {
  return NextResponse.json(
    { error: 'Unauthorized — please log in to continue' },
    { status: 401 }
  );
}

/**
 * Convenience helper: returns 403 JSON response.
 */
export function forbiddenResponse(message = 'Forbidden') {
  return NextResponse.json({ error: message }, { status: 403 });
}

export type TenantRole = 'owner' | 'admin' | 'agent';

/**
 * Require a signed-in user who is a member of `tenantId` (optionally with one
 * of `roles`). Returns the member context, or a ready-to-return error response.
 *
 *   const member = await requireTenantMember(tenantId, ['owner', 'admin']);
 *   if ('error' in member) return member.error;
 */
export async function requireTenantMember(
  tenantId: string,
  roles?: TenantRole[]
): Promise<{ userId: string; email: string; role: TenantRole } | { error: NextResponse }> {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return { error: unauthorizedResponse() };

  const { data: membership, error } = await supabase
    .from('tenant_memberships')
    .select('role')
    .eq('user_id', user.id)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (error) {
    console.error('[Auth] membership lookup failed:', error.message);
    return { error: NextResponse.json({ error: 'Membership lookup failed' }, { status: 500 }) };
  }
  if (!membership) return { error: forbiddenResponse('You are not a member of this workspace') };

  const role = membership.role as TenantRole;
  if (roles && !roles.includes(role)) {
    return { error: forbiddenResponse(`Requires role: ${roles.join(' or ')}`) };
  }
  return { userId: user.id, email: user.email ?? '', role };
}
