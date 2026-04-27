// POST  /api/tenants/[id]/domain — register tenant domain with Resend
// PATCH /api/tenants/[id]/domain — verify domain status with Resend

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { createSupabaseAdminClient } from '@/lib/supabase-server';

type Params = { params: Promise<{ id: string }> };

/**
 * POST — register the tenant's domain with Resend.
 * Stores the returned domain id as resend_domain_id.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;

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

    const admin = createSupabaseAdminClient();

    // Validate tenant exists
    const { data: tenant, error: tenantError } = await admin
      .from('tenants')
      .select('id, domain, resend_domain_id')
      .eq('id', id)
      .single();

    if (tenantError || !tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    // Verify user is owner or admin of this tenant
    const { data: membership, error: membershipError } = await admin
      .from('tenant_memberships')
      .select('role')
      .eq('tenant_id', id)
      .eq('user_id', user.id)
      .in('role', ['owner', 'admin'])
      .single();

    if (membershipError || !membership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (tenant.resend_domain_id) {
      return NextResponse.json(
        { error: 'Domain already registered' },
        { status: 409 }
      );
    }

    // Call Resend API to register domain
    const res = await fetch('https://api.resend.com/domains', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: tenant.domain }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('[POST /api/tenants/:id/domain] Resend error:', text);
      return NextResponse.json(
        { error: 'Failed to register domain with Resend' },
        { status: 502 }
      );
    }

    const data = (await res.json()) as {
      id: string;
      name: string;
      status: string;
    };

    // Persist resend_domain_id
    const { error: updateError } = await admin
      .from('tenants')
      .update({ resend_domain_id: data.id })
      .eq('id', id);

    if (updateError) {
      console.error('[POST /api/tenants/:id/domain] DB update error:', updateError);
      return NextResponse.json(
        { error: 'Failed to save domain ID' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      domainId: data.id,
      name: data.name,
      status: data.status,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[POST /api/tenants/:id/domain] unexpected error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * PATCH — verify the domain with Resend.
 * Updates the tenant record with the latest status.
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;

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

    const admin = createSupabaseAdminClient();

    // Validate tenant exists
    const { data: tenant, error: tenantError } = await admin
      .from('tenants')
      .select('id, domain, resend_domain_id, settings')
      .eq('id', id)
      .single();

    if (tenantError || !tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    // Verify user is owner or admin of this tenant
    const { data: membership, error: membershipError } = await admin
      .from('tenant_memberships')
      .select('role')
      .eq('tenant_id', id)
      .eq('user_id', user.id)
      .in('role', ['owner', 'admin'])
      .single();

    if (membershipError || !membership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (!tenant.resend_domain_id) {
      return NextResponse.json(
        { error: 'Domain not registered yet' },
        { status: 400 }
      );
    }

    // Call Resend API to check domain status
    const res = await fetch(
      `https://api.resend.com/domains/${tenant.resend_domain_id}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!res.ok) {
      const text = await res.text();
      console.error('[PATCH /api/tenants/:id/domain] Resend error:', text);
      return NextResponse.json(
        { error: 'Failed to fetch domain status from Resend' },
        { status: 502 }
      );
    }

    const data = (await res.json()) as {
      id: string;
      status: string;
    };

    // Update tenant record with latest status
    const currentSettings = (tenant.settings as Record<string, unknown> | null) || {};
    const { error: updateError } = await admin
      .from('tenants')
      .update({
        settings: { ...currentSettings, domainStatus: data.status },
      })
      .eq('id', id);

    if (updateError) {
      console.error('[PATCH /api/tenants/:id/domain] DB update error:', updateError);
      return NextResponse.json(
        { error: 'Failed to update tenant status' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      status: data.status as 'verified' | 'pending',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[PATCH /api/tenants/:id/domain] unexpected error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
