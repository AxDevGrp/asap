'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

// Step definitions
type Step = 'account' | 'domain' | 'dns' | 'verify' | 'complete';

const STEPS: { id: Step; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'domain', label: 'Domain' },
  { id: 'dns', label: 'DNS Setup' },
  { id: 'verify', label: 'Verify' },
  { id: 'complete', label: 'Done' },
];

interface TenantData {
  id: string;
  name: string;
  slug: string;
  domain: string;
  resend_domain_id: string | null;
}

interface DNSRecord {
  type: string;
  host: string;
  value: string;
  priority?: number;
  purpose: string;
}

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('account');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1: Account
  const [companyName, setCompanyName] = useState('');
  const [companyDomain, setCompanyDomain] = useState('');
  const [companySlug, setCompanySlug] = useState('');

  // Tenant data (set after creation)
  const [tenant, setTenant] = useState<TenantData | null>(null);
  const [dnsRecords, setDnsRecords] = useState<DNSRecord[]>([]);

  // Step 4: Verify
  const [verifyStatus, setVerifyStatus] = useState<'pending' | 'verified' | 'failed' | null>(null);
  const [verifying, setVerifying] = useState(false);

  const currentStepIndex = STEPS.findIndex((s) => s.id === step);

  function slugify(name: string) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function handleNameChange(val: string) {
    setCompanyName(val);
    setCompanySlug(slugify(val));
  }

  // Step 1 → Create tenant
  async function handleCreateAccount() {
    if (!companyName.trim() || !companyDomain.trim()) {
      setError('Company name and domain are required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: companyName,
          slug: companySlug || slugify(companyName),
          domain: companyDomain,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Failed to create account');
      }

      const created: TenantData = await res.json();
      setTenant(created);
      setStep('domain');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  // Step 2 → Register domain with Resend
  async function handleRegisterDomain() {
    if (!tenant) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/tenants/${tenant.id}/domain`, {
        method: 'POST',
      });

      if (!res.ok) {
        const data = await res.json();
        // If already registered, continue
        if (res.status === 409) {
          setStep('dns');
          setLoading(false);
          return;
        }
        throw new Error(data.error ?? 'Failed to register domain');
      }

      const data = await res.json();
      setTenant({ ...tenant, resend_domain_id: data.resend_domain_id });
      setStep('dns');

      // Fetch DNS records
      await fetchDnsRecords(tenant.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  async function fetchDnsRecords(tenantId: string) {
    const res = await fetch(`/api/tenants/${tenantId}/dns-records`);
    if (res.ok) {
      const data = await res.json();
      setDnsRecords(data.records ?? []);
    }
  }

  // When entering DNS step, fetch records if not yet loaded
  async function enterDnsStep() {
    if (tenant && dnsRecords.length === 0) {
      await fetchDnsRecords(tenant.id);
    }
    setStep('verify');
  }

  // Step 4 → Trigger verification
  async function handleVerify() {
    if (!tenant) return;

    setVerifying(true);
    setVerifyStatus(null);

    try {
      const res = await fetch(`/api/tenants/${tenant.id}/domain`, {
        method: 'PATCH',
      });

      if (!res.ok) {
        setVerifyStatus('failed');
        return;
      }

      const data = await res.json();
      setVerifyStatus(data.status === 'verified' ? 'verified' : 'pending');
    } catch {
      setVerifyStatus('failed');
    } finally {
      setVerifying(false);
    }
  }

  function skipToComplete() {
    setStep('complete');
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <span className="text-lg font-bold">ASAP Setup</span>
          <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-900">
            Skip for now →
          </Link>
        </div>
      </header>

      <main className="flex-1 max-w-3xl mx-auto w-full px-4 sm:px-6 py-10">
        {/* Progress */}
        <div className="flex items-center gap-2 mb-10">
          {STEPS.map((s, i) => (
            <div key={s.id} className="flex items-center gap-2">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                  i < currentStepIndex
                    ? 'bg-green-500 text-white'
                    : i === currentStepIndex
                    ? 'bg-gray-900 text-white'
                    : 'bg-gray-200 text-gray-500'
                }`}
              >
                {i < currentStepIndex ? '✓' : i + 1}
              </div>
              <span
                className={`text-sm hidden sm:block ${
                  i === currentStepIndex ? 'font-medium text-gray-900' : 'text-gray-400'
                }`}
              >
                {s.label}
              </span>
              {i < STEPS.length - 1 && (
                <div className={`flex-1 h-px w-8 ${i < currentStepIndex ? 'bg-green-400' : 'bg-gray-200'}`} />
              )}
            </div>
          ))}
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-md px-4 py-3 mb-6 text-sm">
            {error}
          </div>
        )}

        {/* Step 1: Account */}
        {step === 'account' && (
          <div className="bg-white rounded-lg border border-gray-200 p-8">
            <h1 className="text-2xl font-bold mb-2">Set up your account</h1>
            <p className="text-gray-500 text-sm mb-8">
              Tell us about your company. This takes about 2 minutes.
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Company Name *
                </label>
                <input
                  type="text"
                  value={companyName}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder="e.g. Acme Corp"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Support Domain *
                </label>
                <input
                  type="text"
                  value={companyDomain}
                  onChange={(e) => setCompanyDomain(e.target.value)}
                  placeholder="e.g. acme.com"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
                />
                <p className="text-xs text-gray-400 mt-1">
                  Your customers will email support@{companyDomain || 'yourdomain.com'}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Slug (URL identifier)
                </label>
                <input
                  type="text"
                  value={companySlug}
                  onChange={(e) => setCompanySlug(e.target.value)}
                  placeholder="e.g. acme"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gray-900"
                />
              </div>
            </div>

            <button
              onClick={handleCreateAccount}
              disabled={loading}
              className="mt-8 w-full bg-gray-900 text-white py-2.5 rounded-md text-sm font-medium hover:bg-gray-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Creating account…' : 'Continue →'}
            </button>
          </div>
        )}

        {/* Step 2: Domain registration */}
        {step === 'domain' && tenant && (
          <div className="bg-white rounded-lg border border-gray-200 p-8">
            <h1 className="text-2xl font-bold mb-2">Register your domain</h1>
            <p className="text-gray-500 text-sm mb-8">
              We'll register <strong>{tenant.domain}</strong> with Resend for email delivery.
              This enables ASAP to send replies from <strong>support@{tenant.domain}</strong>.
            </p>

            <div className="bg-gray-50 rounded-lg p-4 mb-8 text-sm text-gray-600">
              <div className="font-medium mb-1">What happens next:</div>
              <ol className="list-decimal pl-4 space-y-1">
                <li>We register your domain with Resend (our email provider)</li>
                <li>You'll get DNS records to add to your domain registrar (e.g. Cloudflare)</li>
                <li>Once DNS propagates, your domain is verified and email is ready</li>
              </ol>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleRegisterDomain}
                disabled={loading}
                className="flex-1 bg-gray-900 text-white py-2.5 rounded-md text-sm font-medium hover:bg-gray-700 disabled:opacity-50 transition-colors"
              >
                {loading ? 'Registering…' : 'Register Domain →'}
              </button>
              <button
                onClick={() => setStep('dns')}
                className="px-4 py-2.5 text-sm text-gray-600 hover:text-gray-900 border border-gray-300 rounded-md hover:border-gray-500 transition-colors"
              >
                Skip (do later)
              </button>
            </div>
          </div>
        )}

        {/* Step 3: DNS Setup */}
        {step === 'dns' && tenant && (
          <div className="bg-white rounded-lg border border-gray-200 p-8">
            <h1 className="text-2xl font-bold mb-2">Add DNS records</h1>
            <p className="text-gray-500 text-sm mb-8">
              Add these records to your DNS provider (e.g. Cloudflare) for <strong>{tenant.domain}</strong>.
            </p>

            {dnsRecords.length > 0 ? (
              <div className="space-y-3 mb-8">
                {dnsRecords.map((record, i) => (
                  <div key={i} className="border border-gray-200 rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-bold px-2 py-0.5 bg-gray-100 rounded font-mono">
                        {record.type}
                      </span>
                      <span className="text-xs text-gray-500">{record.purpose}</span>
                    </div>
                    <div className="text-xs font-mono space-y-1">
                      <div>
                        <span className="text-gray-400">Host: </span>
                        <span className="text-gray-900">{record.host}</span>
                      </div>
                      <div>
                        <span className="text-gray-400">Value: </span>
                        <span className="text-gray-900 break-all">{record.value}</span>
                      </div>
                      {record.priority !== undefined && (
                        <div>
                          <span className="text-gray-400">Priority: </span>
                          <span className="text-gray-900">{record.priority}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-yellow-50 border border-yellow-200 text-yellow-700 rounded-md p-4 mb-8 text-sm">
                DNS records could not be loaded. You can view them later from Settings → Domain.
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={enterDnsStep}
                className="flex-1 bg-gray-900 text-white py-2.5 rounded-md text-sm font-medium hover:bg-gray-700 transition-colors"
              >
                I've added the records →
              </button>
              <button
                onClick={skipToComplete}
                className="px-4 py-2.5 text-sm text-gray-600 hover:text-gray-900 border border-gray-300 rounded-md hover:border-gray-500 transition-colors"
              >
                Skip for now
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Verify */}
        {step === 'verify' && tenant && (
          <div className="bg-white rounded-lg border border-gray-200 p-8">
            <h1 className="text-2xl font-bold mb-2">Verify your domain</h1>
            <p className="text-gray-500 text-sm mb-8">
              Click verify to check if your DNS records have propagated.
              This can take a few minutes to 48 hours.
            </p>

            {verifyStatus === 'verified' && (
              <div className="bg-green-50 border border-green-200 text-green-700 rounded-md px-4 py-3 mb-6 text-sm flex items-center gap-2">
                <span>✓</span> Domain verified! Your email setup is complete.
              </div>
            )}
            {verifyStatus === 'pending' && (
              <div className="bg-yellow-50 border border-yellow-200 text-yellow-700 rounded-md px-4 py-3 mb-6 text-sm">
                DNS records not yet propagated. Try again in a few hours.
              </div>
            )}
            {verifyStatus === 'failed' && (
              <div className="bg-red-50 border border-red-200 text-red-700 rounded-md px-4 py-3 mb-6 text-sm">
                Verification failed. Check your DNS records and try again.
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={handleVerify}
                disabled={verifying || verifyStatus === 'verified'}
                className="flex-1 bg-gray-900 text-white py-2.5 rounded-md text-sm font-medium hover:bg-gray-700 disabled:opacity-50 transition-colors"
              >
                {verifying ? 'Checking…' : verifyStatus === 'verified' ? '✓ Verified' : 'Check Verification →'}
              </button>
              <button
                onClick={skipToComplete}
                className="px-4 py-2.5 text-sm text-gray-600 hover:text-gray-900 border border-gray-300 rounded-md hover:border-gray-500 transition-colors"
              >
                {verifyStatus === 'verified' ? 'Continue →' : 'Skip for now'}
              </button>
            </div>

            {verifyStatus === 'verified' && (
              <button
                onClick={skipToComplete}
                className="mt-3 w-full bg-green-600 text-white py-2.5 rounded-md text-sm font-medium hover:bg-green-700 transition-colors"
              >
                Continue to Dashboard →
              </button>
            )}
          </div>
        )}

        {/* Step 5: Complete */}
        {step === 'complete' && tenant && (
          <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
            <div className="text-5xl mb-4">🎉</div>
            <h1 className="text-2xl font-bold mb-2">You're all set!</h1>
            <p className="text-gray-500 text-sm mb-8">
              <strong>{tenant.name}</strong> is ready on ASAP. Your next step is to add
              knowledge base articles so the AI can start answering customer questions.
            </p>

            <div className="space-y-3">
              <a
                href="/dashboard/kb"
                className="block w-full bg-gray-900 text-white py-2.5 rounded-md text-sm font-medium hover:bg-gray-700 transition-colors"
              >
                Add Knowledge Base Articles →
              </a>
              <a
                href="/dashboard"
                className="block w-full text-gray-600 py-2.5 rounded-md text-sm font-medium hover:text-gray-900 border border-gray-200 hover:border-gray-400 transition-colors"
              >
                Go to Dashboard
              </a>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
