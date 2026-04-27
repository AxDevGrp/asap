// Tenant-scoped analytics helpers
// All queries are filtered by tenant_id to ensure data isolation

import { createClient } from '@supabase/supabase-js';

function getServiceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createClient(url, key);
}

export interface TenantAnalytics {
  totalTickets: number;
  openTickets: number;
  resolvedTickets: number;
  autoResolvedTickets: number;
  autoResolveRate: number; // 0-100
  totalKBArticles: number;
  recentTickets: RecentTicket[];
}

export interface RecentTicket {
  id: string;
  contact_name: string | null;
  contact_email: string | null;
  triage_type: string | null;
  triage_urgency: string | null;
  status: string;
  auto_resolved: boolean;
  created_at: string;
}

/**
 * Fetch analytics for a specific tenant.
 */
export async function getTenantAnalytics(tenantId: string): Promise<TenantAnalytics> {
  const supabase = getServiceSupabase();

  // Run queries in parallel
  const [ticketResult, kbResult, recentResult] = await Promise.all([
    supabase
      .from('tickets')
      .select('id, status, auto_resolved')
      .eq('tenant_id', tenantId),
    supabase
      .from('knowledge_base')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId),
    supabase
      .from('tickets')
      .select('id, contact_name, contact_email, triage_type, triage_urgency, status, auto_resolved, created_at')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(10),
  ]);

  const tickets = ticketResult.data ?? [];
  const totalTickets = tickets.length;
  const openTickets = tickets.filter((t) => t.status === 'open').length;
  const resolvedTickets = tickets.filter((t) => t.status === 'resolved').length;
  const autoResolvedTickets = tickets.filter((t) => t.auto_resolved).length;
  const autoResolveRate = totalTickets > 0
    ? Math.round((autoResolvedTickets / totalTickets) * 100)
    : 0;

  return {
    totalTickets,
    openTickets,
    resolvedTickets,
    autoResolvedTickets,
    autoResolveRate,
    totalKBArticles: kbResult.count ?? 0,
    recentTickets: (recentResult.data ?? []) as RecentTicket[],
  };
}
