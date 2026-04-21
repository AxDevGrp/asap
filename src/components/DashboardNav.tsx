'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase-browser';
import { useRouter } from 'next/navigation';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  domain: string;
  role: string;
}

interface User {
  id: string;
  email?: string;
}

interface Props {
  user: User;
  tenants: Tenant[];
  isSuperAdmin: boolean;
}

const navLinks = [
  { href: '/dashboard', label: 'Overview', icon: '◻' },
  { href: '/dashboard/tickets', label: 'Tickets', icon: '✉' },
  { href: '/dashboard/kb', label: 'Knowledge Base', icon: '📚' },
  { href: '/dashboard/monitoring', label: 'Monitoring', icon: '📊' },
  { href: '/dashboard/settings', label: 'Settings', icon: '⚙' },
];

export default function DashboardNav({ user, tenants, isSuperAdmin }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createSupabaseBrowserClient();

  const [tenantMenuOpen, setTenantMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  // Determine active tenant from URL or default to first
  const activeTenant = tenants[0];

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  function isActive(href: string) {
    if (href === '/dashboard') return pathname === '/dashboard';
    return pathname.startsWith(href);
  }

  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center justify-between h-14">
        {/* Brand + Tenant Name */}
        <div className="flex items-center gap-4">
          <Link href="/dashboard" className="text-lg font-bold tracking-tight">
            ASAP
          </Link>

          {/* Tenant switcher */}
          {activeTenant && (
            <div className="relative">
              <button
                onClick={() => setTenantMenuOpen(!tenantMenuOpen)}
                className="flex items-center gap-2 text-sm text-gray-700 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-md transition-colors"
              >
                <span className="font-medium">{activeTenant.name}</span>
                {tenants.length > 1 && (
                  <span className="text-gray-400 text-xs">▾</span>
                )}
              </button>

              {tenantMenuOpen && tenants.length > 1 && (
                <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-48 z-50">
                  <div className="px-3 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Switch Tenant
                  </div>
                  {tenants.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => {
                        // In a real multi-tenant app, this would set the active tenant cookie/context
                        // For now, navigate to a tenant-specific route
                        setTenantMenuOpen(false);
                      }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center justify-between"
                    >
                      <span>{t.name}</span>
                      <span className="text-xs text-gray-400">{t.role}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Nav Links */}
        <nav className="hidden md:flex items-center gap-1">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                isActive(link.href)
                  ? 'bg-gray-900 text-white'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* User menu */}
        <div className="relative">
          <button
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className="flex items-center gap-2 text-sm text-gray-700 hover:text-gray-900"
          >
            <div className="w-7 h-7 rounded-full bg-gray-900 text-white flex items-center justify-center text-xs font-bold">
              {user.email?.[0]?.toUpperCase() ?? '?'}
            </div>
          </button>

          {userMenuOpen && (
            <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-48 z-50">
              <div className="px-3 py-2 text-sm text-gray-500 border-b border-gray-100">
                {user.email}
              </div>
              {isSuperAdmin && (
                <div className="px-3 py-1 text-xs text-indigo-600 font-medium">
                  Super Admin
                </div>
              )}
              <button
                onClick={handleSignOut}
                className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Mobile nav */}
      <div className="md:hidden border-t border-gray-100 flex overflow-x-auto px-4 gap-1 pb-2 pt-1">
        {navLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={`flex-shrink-0 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              isActive(link.href)
                ? 'bg-gray-900 text-white'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
            }`}
          >
            {link.label}
          </Link>
        ))}
      </div>
    </header>
  );
}
