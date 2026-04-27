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
