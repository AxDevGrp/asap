import { createSupabaseServerClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { getTenantAnalytics } from '@/lib/analytics';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <div className="text-2xl font-bold text-gray-900">{value}</div>
      <div className="text-sm font-medium text-gray-700 mt-1">{label}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

const urgencyColors: Record<string, string> = {
  critical: 'text-red-700 bg-red-50',
  high: 'text-orange-700 bg-orange-50',
  medium: 'text-yellow-700 bg-yellow-50',
  low: 'text-green-700 bg-green-50',
};

export default async function DashboardPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  // Get user's primary tenant
  const { data: memberships } = await supabase
    .from('tenant_memberships')
    .select('role, tenant_id, tenants(id, name, slug, domain)')
    .eq('user_id', user.id)
    .limit(1);

  const membership = memberships?.[0];
  const tenant = (membership as any)?.tenants;

  if (!tenant) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-16 text-center">
        <div className="text-5xl mb-4">🏢</div>
        <h2 className="text-xl font-semibold mb-2">No tenant access</h2>
        <p className="text-gray-500 text-sm">
          You are not a member of any tenant yet. Ask an admin to add you.
        </p>
      </div>
    );
  }

  const analytics = await getTenantAnalytics(tenant.id);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">{tenant.name} — Overview</h1>
        <p className="text-sm text-gray-500 mt-1">{tenant.domain}</p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-10">
        <StatCard label="Total Tickets" value={analytics.totalTickets} />
        <StatCard label="Open" value={analytics.openTickets} sub="needs attention" />
        <StatCard label="Resolved" value={analytics.resolvedTickets} />
        <StatCard
          label="Auto-Resolved"
          value={`${analytics.autoResolveRate}%`}
          sub={`${analytics.autoResolvedTickets} tickets`}
        />
        <StatCard label="KB Articles" value={analytics.totalKBArticles} />
      </div>

      {/* Recent Tickets */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">Recent Tickets</h2>
          <Link
            href="/dashboard/tickets"
            className="text-xs text-gray-500 hover:text-gray-900 font-medium"
          >
            View all →
          </Link>
        </div>

        {analytics.recentTickets.length === 0 ? (
          <div className="px-5 py-12 text-center text-gray-400 text-sm">
            No tickets yet. They will appear here once support requests arrive.
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {analytics.recentTickets.map((ticket) => (
              <div
                key={ticket.id}
                className="px-5 py-4 flex items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-900 truncate">
                    {ticket.contact_name ?? ticket.contact_email ?? 'Unknown contact'}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5 truncate">
                    {ticket.triage_type ?? 'Uncategorised'}
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  {ticket.triage_urgency && (
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        urgencyColors[ticket.triage_urgency] ?? 'text-gray-600 bg-gray-100'
                      }`}
                    >
                      {ticket.triage_urgency}
                    </span>
                  )}
                  {ticket.auto_resolved && (
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full text-indigo-700 bg-indigo-50">
                      auto
                    </span>
                  )}
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      ticket.status === 'open'
                        ? 'text-amber-700 bg-amber-50'
                        : 'text-green-700 bg-green-50'
                    }`}
                  >
                    {ticket.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-8">
        <Link
          href="/dashboard/kb"
          className="bg-white border border-gray-200 rounded-lg p-5 hover:border-gray-400 transition-colors"
        >
          <div className="text-2xl mb-2">📚</div>
          <div className="font-medium text-gray-900">Knowledge Base</div>
          <div className="text-sm text-gray-500 mt-1">
            Manage AI training articles for {tenant.name}
          </div>
        </Link>
        <Link
          href="/dashboard/settings"
          className="bg-white border border-gray-200 rounded-lg p-5 hover:border-gray-400 transition-colors"
        >
          <div className="text-2xl mb-2">⚙️</div>
          <div className="font-medium text-gray-900">Settings</div>
          <div className="text-sm text-gray-500 mt-1">
            Brand, domain, inbox config, AI tone
          </div>
        </Link>
      </div>
    </div>
  );
}
