'use client';

import { useState, useEffect, useCallback } from 'react';

interface TenantSettings {
  id: string;
  name: string;
  slug: string;
  domain: string;
  chatwoot_account_id: number | null;
  chatwoot_inbox_id: number | null;
  resend_domain_id: string | null;
  settings: {
    brand_color?: string;
    ai_tone?: 'professional' | 'friendly' | 'concise' | 'empathetic';
    auto_resolve_threshold?: number; // 0-100
    [key: string]: unknown;
  };
}

const AI_TONE_OPTIONS = [
  { value: 'professional', label: 'Professional', desc: 'Formal, precise, business-like' },
  { value: 'friendly', label: 'Friendly', desc: 'Warm, approachable, helpful' },
  { value: 'concise', label: 'Concise', desc: 'Brief, direct, no fluff' },
  { value: 'empathetic', label: 'Empathetic', desc: 'Compassionate, understanding' },
];

export default function SettingsPage() {
  const [tenant, setTenant] = useState<TenantSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form fields
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [brandColor, setBrandColor] = useState('#111827');
  const [aiTone, setAiTone] = useState<string>('professional');
  const [autoResolveThreshold, setAutoResolveThreshold] = useState(80);
  const [chatwootAccountId, setChatwootAccountId] = useState('');
  const [chatwootInboxId, setChatwootInboxId] = useState('');
  const [resendDomainId, setResendDomainId] = useState('');

  const fetchTenant = useCallback(async () => {
    setLoading(true);
    try {
      // Get tenant via the /api/me/tenant route
      const meRes = await fetch('/api/me/tenant');
      if (!meRes.ok) throw new Error('Not authenticated or no tenant');
      const { tenantId } = await meRes.json();

      const res = await fetch(`/api/tenants/${tenantId}`);
      if (!res.ok) throw new Error('Failed to load tenant');
      const data: TenantSettings = await res.json();

      setTenant(data);
      setName(data.name);
      setDomain(data.domain);
      setBrandColor(data.settings?.brand_color ?? '#111827');
      setAiTone(data.settings?.ai_tone ?? 'professional');
      setAutoResolveThreshold(data.settings?.auto_resolve_threshold ?? 80);
      setChatwootAccountId(String(data.chatwoot_account_id ?? ''));
      setChatwootInboxId(String(data.chatwoot_inbox_id ?? ''));
      setResendDomainId(data.resend_domain_id ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTenant();
  }, [fetchTenant]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!tenant) return;

    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const res = await fetch(`/api/tenants/${tenant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          domain,
          chatwoot_account_id: chatwootAccountId ? Number(chatwootAccountId) : null,
          chatwoot_inbox_id: chatwootInboxId ? Number(chatwootInboxId) : null,
          resend_domain_id: resendDomainId || null,
          settings: {
            ...tenant.settings,
            brand_color: brandColor,
            ai_tone: aiTone,
            auto_resolve_threshold: autoResolveThreshold,
          },
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Save failed');
      }

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <div className="text-gray-400 text-sm">Loading settings…</div>
      </div>
    );
  }

  if (!tenant) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-md px-4 py-3 text-sm">
          {error ?? 'Unable to load tenant settings'}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-500 mt-1">{tenant.name} · {tenant.slug}</p>
      </div>

      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 rounded-md px-4 py-3 mb-6 text-sm">
          Settings saved successfully.
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-md px-4 py-3 mb-6 text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-8">

        {/* Brand section */}
        <section className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-4">Brand</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Company Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Domain
              </label>
              <input
                type="text"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="e.g. acme.com"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Brand Colour
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={brandColor}
                  onChange={(e) => setBrandColor(e.target.value)}
                  className="w-10 h-10 rounded border border-gray-300 cursor-pointer"
                />
                <input
                  type="text"
                  value={brandColor}
                  onChange={(e) => setBrandColor(e.target.value)}
                  placeholder="#111827"
                  className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gray-900"
                />
              </div>
            </div>
          </div>
        </section>

        {/* AI Configuration */}
        <section className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-4">AI Configuration</h2>

          <div className="mb-5">
            <label className="block text-sm font-medium text-gray-700 mb-3">
              AI Response Tone
            </label>
            <div className="grid grid-cols-2 gap-3">
              {AI_TONE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setAiTone(opt.value)}
                  className={`text-left p-3 rounded-lg border-2 transition-colors ${
                    aiTone === opt.value
                      ? 'border-gray-900 bg-gray-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="text-sm font-medium text-gray-900">{opt.label}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Auto-Resolve Confidence Threshold: {autoResolveThreshold}%
            </label>
            <p className="text-xs text-gray-400 mb-3">
              Tickets with AI confidence above this threshold are auto-resolved without human review.
            </p>
            <input
              type="range"
              min={50}
              max={99}
              value={autoResolveThreshold}
              onChange={(e) => setAutoResolveThreshold(Number(e.target.value))}
              className="w-full accent-gray-900"
            />
            <div className="flex justify-between text-xs text-gray-400 mt-1">
              <span>50% (aggressive)</span>
              <span>99% (conservative)</span>
            </div>
          </div>
        </section>

        {/* Inbox Configuration */}
        <section className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-4">Inbox Configuration</h2>
          <p className="text-xs text-gray-400 mb-4">
            Configure Chatwoot and Resend for this tenant's email support.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Chatwoot Account ID
              </label>
              <input
                type="number"
                value={chatwootAccountId}
                onChange={(e) => setChatwootAccountId(e.target.value)}
                placeholder="1"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Chatwoot Inbox ID
              </label>
              <input
                type="number"
                value={chatwootInboxId}
                onChange={(e) => setChatwootInboxId(e.target.value)}
                placeholder="1"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Resend Domain ID
              </label>
              <input
                type="text"
                value={resendDomainId}
                onChange={(e) => setResendDomainId(e.target.value)}
                placeholder="e.g. re_xxxxxxxxxxxxxxxxx"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            </div>
          </div>
        </section>

        {/* Save */}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="bg-gray-900 text-white text-sm font-medium px-6 py-2.5 rounded-md hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
        </div>
      </form>
    </div>
  );
}
