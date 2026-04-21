import { createSupabaseServerClient } from '@/lib/supabase-server';
import { createClient } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

function getServiceSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

const urgencyColors: Record<string, string> = {
  critical: 'text-red-700 bg-red-50 border-red-200',
  high: 'text-orange-700 bg-orange-50 border-orange-200',
  medium: 'text-yellow-700 bg-yellow-50 border-yellow-200',
  low: 'text-green-700 bg-green-50 border-green-200',
};

export default async function TicketsPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  // Get user's primary tenant
  const { data: membership } = await supabase
    .from('tenant_memberships')
    .select('tenant_id, tenants(id, name, slug)')
    .eq('user_id', user.id)
    .limit(1)
    .single();

  const tenant = (membership as any)?.tenants;
  const tenantId = tenant?.id ?? (membership as any)?.tenant_id;

  if (!tenantId) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-16 text-center">
        <p className="text-gray-500 text-sm">No tenant access.</p>
      </div>
    );
  }

  const serviceSupabase = getServiceSupabase();
  const { data: tickets } = await serviceSupabase
    .from('tickets')
    .select('id, contact_name, contact_email, triage_type, triage_urgency, triage_summary, status, auto_resolved, auto_reply_sent, created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(50);

  const rows = tickets ?? [];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Tickets</h1>
        <p className="text-sm text-gray-500 mt-1">
          {tenant?.name} — {rows.length} recent tickets
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg py-16 text-center">
          <div className="text-4xl mb-4">✉️</div>
          <h3 className="font-semibold text-gray-900 mb-2">No tickets yet</h3>
          <p className="text-sm text-gray-500">
            Tickets will appear here when customers contact your support inbox.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                <th className="text-left px-4 py-3">Contact</th>
                <th className="text-left px-4 py-3 hidden md:table-cell">Category</th>
                <th className="text-left px-4 py-3 hidden lg:table-cell">Summary</th>
                <th className="text-left px-4 py-3">Urgency</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3 hidden sm:table-cell">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {rows.map((ticket: any) => (
                <tr key={ticket.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <Link href={`/dashboard/tickets/${ticket.id}`} className="block group">
                      <div className="font-medium text-gray-900 truncate max-w-[140px] group-hover:text-indigo-700 transition-colors">
                        {ticket.contact_name ?? 'Unknown'}
                      </div>
                      <div className="text-xs text-gray-400 truncate max-w-[140px]">
                        {ticket.contact_email ?? ''}
                      </div>
                    </Link>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-gray-600">
                    {ticket.triage_type ?? '—'}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-gray-500 max-w-xs">
                    <span className="line-clamp-1">{ticket.triage_summary ?? '—'}</span>
                  </td>
                  <td className="px-4 py-3">
                    {ticket.triage_urgency ? (
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                          urgencyColors[ticket.triage_urgency] ?? 'text-gray-600 bg-gray-100 border-gray-200'
                        }`}
                      >
                        {ticket.triage_urgency}
                      </span>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded-full w-fit ${
                          ticket.status === 'open'
                            ? 'text-amber-700 bg-amber-50'
                            : 'text-green-700 bg-green-50'
                        }`}
                      >
                        {ticket.status}
                      </span>
                      {ticket.auto_resolved && (
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full text-indigo-700 bg-indigo-50 w-fit">
                          auto
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell text-xs text-gray-400">
                    {new Date(ticket.created_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
