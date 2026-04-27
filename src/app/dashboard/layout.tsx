// Dashboard layout — wraps all /dashboard/* pages
// Provides: auth guard, tenant resolution, persistent nav

import { createSupabaseServerClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { listTenants } from '@/lib/tenant';
import Link from 'next/link';
import DashboardNav from '@/components/DashboardNav';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  // Fetch the user's tenant memberships
  const { data: memberships } = await supabase
    .from('tenant_memberships')
    .select('role, tenant_id, tenants(id, name, slug, domain)')
    .eq('user_id', user.id);

  const tenants = (memberships ?? []).map((m: any) => ({
    id: m.tenants?.id ?? m.tenant_id,
    name: m.tenants?.name ?? 'Unknown',
    slug: m.tenants?.slug ?? '',
    domain: m.tenants?.domain ?? '',
    role: m.role,
  }));

  // Super-admins can see all tenants
  const isSuperAdmin = memberships?.some((m: any) => m.role === 'owner') ?? false;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <DashboardNav
        user={user}
        tenants={tenants}
        isSuperAdmin={isSuperAdmin}
      />
      <main className="flex-1">{children}</main>
    </div>
  );
}
