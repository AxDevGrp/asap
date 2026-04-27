// GET /api/tenants/[id]/dns-records
// Fetch DNS records for the tenant's domain from Resend.

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { createSupabaseAdminClient } from '@/lib/supabase-server';

type Params = { params: Promise<{ id: string }> };

interface ResendDnsRecord {
  record?: string;
  name?: string;
  host?: string;
  type?: string;
  value?: string;
  priority?: number;
  ttl?: number;
}

interface NormalizedRecord {
  type: string;
  host: string;
  value: string;
  priority?: number;
  ttl: number;
  purpose: string;
}

function normalizeRecord(raw: ResendDnsRecord): NormalizedRecord {
  const type = raw.type ?? '';
  const host = raw.name ?? raw.host ?? '';
  const value = raw.value ?? '';
  const priority = typeof raw.priority === 'number' ? raw.priority : undefined;
  const ttl = typeof raw.ttl === 'number' ? raw.ttl : 300;

  let purpose = raw.record ?? '';
  if (!purpose) {
    if (type === 'MX') purpose = 'Inbound email routing';
    else if (type === 'TXT' && value.includes('v=spf1')) purpose = 'SPF — authorize sending';
    else if (type === 'TXT' && value.includes('v=DMARC1')) purpose = 'DMARC policy';
    else if (type === 'TXT' && host.includes('_domainkey')) purpose = 'DKIM signing key';
    else if (type === 'CNAME' && host.includes('_domainkey')) purpose = 'DKIM signing key';
    else purpose = 'DNS record';
  }

  return { type, host, value, priority, ttl, purpose };
}

export async function GET(_request: NextRequest, { params }: Params) {
  // 1. Authenticate user
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

  const { id } = await params;
  const admin = createSupabaseAdminClient();

  // 2. Validate tenant exists and current user is a member
  const { data: tenant, error: tenantError } = await admin
    .from('tenants')
    .select('id, resend_domain_id')
    .eq('id', id)
    .maybeSingle();

  if (tenantError) {
    console.error('[DNS Records] tenant lookup error:', tenantError.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  if (!tenant) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  const { data: membership, error: membershipError } = await admin
    .from('tenant_memberships')
    .select('id')
    .eq('tenant_id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (membershipError) {
    console.error('[DNS Records] membership lookup error:', membershipError.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  if (!membership) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 3. Get tenant's resend_domain_id
  const resendDomainId = tenant.resend_domain_id;
  if (!resendDomainId) {
    return NextResponse.json(
      { error: 'No Resend domain registered for this tenant' },
      { status: 400 }
    );
  }

  // 4. Call Resend API
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    console.error('[DNS Records] RESEND_API_KEY is not set');
    return NextResponse.json(
      { error: 'Resend API key not configured' },
      { status: 500 }
    );
  }

  const resendResponse = await fetch(
    `https://api.resend.com/domains/${resendDomainId}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!resendResponse.ok) {
    const errorText = await resendResponse.text().catch(() => 'Unknown error');
    console.error(
      '[DNS Records] Resend API error:',
      resendResponse.status,
      errorText
    );
    return NextResponse.json(
      { error: 'Failed to fetch DNS records from Resend' },
      { status: 502 }
    );
  }

  // 5. Extract and normalize DNS records
  const resendData = (await resendResponse.json()) as {
    records?: ResendDnsRecord[];
  };

  const rawRecords = Array.isArray(resendData.records) ? resendData.records : [];
  const records = rawRecords.map(normalizeRecord);

  // 6. Return normalized records
  return NextResponse.json({ records });
}
