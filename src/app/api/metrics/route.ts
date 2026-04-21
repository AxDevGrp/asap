// GET /api/metrics — per-tenant usage metrics for the monitoring dashboard
//
// Returns ticket counts, email delivery rates, auto-resolve rates,
// and recent activity — all scoped to the authenticated user's tenant.
//
// Auth: requires valid Supabase session (tenant member).

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

async function getAuthedTenantId(): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from('tenant_memberships')
    .select('tenant_id')
    .eq('user_id', user.id)
    .limit(1)
    .single();

  return data?.tenant_id ?? null;
}

export async function GET(_req: NextRequest) {
  const tenantId = await getAuthedTenantId();
  if (!tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getServiceClient();
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // ── Ticket stats ─────────────────────────────────────────────────────────

  const [ticketsTotal, tickets24h, tickets7d, ticketsOpen, ticketsAutoResolved] =
    await Promise.all([
      db.from('tickets').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
      db.from('tickets').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', last24h),
      db.from('tickets').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', last7d),
      db.from('tickets').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'open'),
      db.from('tickets').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('auto_resolved', true),
    ]);

  // ── Outbound email delivery stats (last 30 days) ──────────────────────────

  const { data: outboundData } = await db
    .from('outbound_messages')
    .select('status')
    .eq('tenant_id', tenantId)
    .gte('created_at', last30d);

  const outbound = outboundData ?? [];
  const outboundByStatus = outbound.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});

  const totalOutbound = outbound.length;
  const deliveryRate =
    totalOutbound > 0
      ? Math.round(((outboundByStatus.delivered ?? 0) / totalOutbound) * 100)
      : null;

  // ── Triage breakdown (last 7 days) ───────────────────────────────────────

  const { data: triageData } = await db
    .from('tickets')
    .select('triage_type, triage_urgency')
    .eq('tenant_id', tenantId)
    .gte('created_at', last7d)
    .not('triage_type', 'is', null);

  const byType = (triageData ?? []).reduce<Record<string, number>>((acc, row) => {
    if (row.triage_type) acc[row.triage_type] = (acc[row.triage_type] ?? 0) + 1;
    return acc;
  }, {});

  const byUrgency = (triageData ?? []).reduce<Record<string, number>>((acc, row) => {
    if (row.triage_urgency) acc[row.triage_urgency] = (acc[row.triage_urgency] ?? 0) + 1;
    return acc;
  }, {});

  // ── KB stats ─────────────────────────────────────────────────────────────

  const { count: kbCount } = await db
    .from('knowledge_base')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);

  // ── Build response ────────────────────────────────────────────────────────

  return NextResponse.json({
    generatedAt: now.toISOString(),
    tickets: {
      total: ticketsTotal.count ?? 0,
      last24h: tickets24h.count ?? 0,
      last7d: tickets7d.count ?? 0,
      open: ticketsOpen.count ?? 0,
      autoResolved: ticketsAutoResolved.count ?? 0,
      autoResolveRate:
        (ticketsTotal.count ?? 0) > 0
          ? Math.round(((ticketsAutoResolved.count ?? 0) / (ticketsTotal.count ?? 1)) * 100)
          : 0,
    },
    email: {
      totalSent30d: totalOutbound,
      deliveryRate30d: deliveryRate,
      byStatus: outboundByStatus,
    },
    triage: {
      last7d: (triageData ?? []).length,
      byType,
      byUrgency,
    },
    knowledgeBase: {
      articles: kbCount ?? 0,
    },
  });
}
