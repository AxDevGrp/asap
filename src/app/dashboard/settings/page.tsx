'use client';

import { useState, useEffect, useCallback } from 'react';

interface TenantSettings {
  id: string;
  name: string;
  slug: string;
  domain: string;
  resend_domain_id: string | null;
  settings: {
    brand_color?: string;
    ai_tone?: 'professional' | 'friendly' | 'concise' | 'empathetic';
    [key: string]: unknown;
  };
}

interface TenantPolicy {
  autoSendEnabled: boolean;
  confidenceThreshold: number;
  allowedTypes: string[];
  allowedUrgencies: string[];
  minKbSimilarity: number;
  minKbHits: number;
  resolveOnAutoSend: boolean;
  version: number;
}

const TICKET_TYPE_OPTIONS = [
  { value: 'question', label: 'Question' },
  { value: 'billing', label: 'Billing' },
  { value: 'feature_request', label: 'Feature request' },
  { value: 'bug', label: 'Bug' },
  { value: 'other', label: 'Other' },
];

const URGENCY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

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
  const [resendDomainId, setResendDomainId] = useState('');

  // Auto-resolve policy (loaded/saved separately via /api/tenants/[id]/policy)
  const [policy, setPolicy] = useState<TenantPolicy | null>(null);
  const [policySaving, setPolicySaving] = useState(false);
  const [policySuccess, setPolicySuccess] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);

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
      setResendDomainId(data.resend_domain_id ?? '');

      const policyRes = await fetch(`/api/tenants/${tenantId}/policy`);
      if (policyRes.ok) {
        setPolicy(await policyRes.json());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTenant();
  }, [fetchTenant]);

  async function handleSavePolicy() {
    if (!tenant || !policy) return;

    setPolicySaving(true);
    setPolicyError(null);
    setPolicySuccess(false);

    try {
      const res = await fetch(`/api/tenants/${tenant.id}/policy`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoSendEnabled: policy.autoSendEnabled,
          confidenceThreshold: policy.confidenceThreshold,
          allowedTypes: policy.allowedTypes,
          allowedUrgencies: policy.allowedUrgencies,
          minKbSimilarity: policy.minKbSimilarity,
          minKbHits: policy.minKbHits,
          resolveOnAutoSend: policy.resolveOnAutoSend,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Save failed');

      setPolicy(data);
      setPolicySuccess(true);
      setTimeout(() => setPolicySuccess(false), 3000);
    } catch (err) {
      setPolicyError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setPolicySaving(false);
    }
  }

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
          resend_domain_id: resendDomainId || null,
          settings: {
            ...tenant.settings,
            brand_color: brandColor,
            ai_tone: aiTone,
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

        </section>

        {/* Auto-resolve policy */}
        <section className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-1">Auto-resolve policy</h2>
          <p className="text-xs text-gray-400 mb-4">
            Controls when AI replies are sent automatically vs held as a draft. Each tenant has its own policy.
          </p>

          {!policy ? (
            <div className="text-gray-400 text-sm">Loading policy…</div>
          ) : (
            <div className="space-y-5">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={policy.autoSendEnabled}
                  onChange={(e) => setPolicy({ ...policy, autoSendEnabled: e.target.checked })}
                  className="h-4 w-4 accent-gray-900"
                />
                <span className="text-sm text-gray-700">
                  Enable auto-send
                  <span className="block text-xs text-gray-400">
                    When off, every AI reply is saved as a draft for human review.
                  </span>
                </span>
              </label>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Confidence threshold: {Math.round(policy.confidenceThreshold * 100)}%
                </label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(policy.confidenceThreshold * 100)}
                  onChange={(e) =>
                    setPolicy({ ...policy, confidenceThreshold: Number(e.target.value) / 100 })
                  }
                  className="w-full accent-gray-900"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Min KB similarity: {Math.round(policy.minKbSimilarity * 100)}%
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(policy.minKbSimilarity * 100)}
                    onChange={(e) =>
                      setPolicy({ ...policy, minKbSimilarity: Number(e.target.value) / 100 })
                    }
                    className="w-full accent-gray-900"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Min KB hits
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    value={policy.minKbHits}
                    onChange={(e) =>
                      setPolicy({ ...policy, minKbHits: Math.max(0, Math.min(20, Number(e.target.value) || 0)) })
                    }
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Allowed ticket types</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {TICKET_TYPE_OPTIONS.map((opt) => (
                    <label key={opt.value} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={policy.allowedTypes.includes(opt.value)}
                        onChange={(e) =>
                          setPolicy({
                            ...policy,
                            allowedTypes: e.target.checked
                              ? [...policy.allowedTypes, opt.value]
                              : policy.allowedTypes.filter((t) => t !== opt.value),
                          })
                        }
                        className="h-4 w-4 accent-gray-900"
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Allowed urgencies</label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {URGENCY_OPTIONS.map((opt) => (
                    <label key={opt.value} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={policy.allowedUrgencies.includes(opt.value)}
                        onChange={(e) =>
                          setPolicy({
                            ...policy,
                            allowedUrgencies: e.target.checked
                              ? [...policy.allowedUrgencies, opt.value]
                              : policy.allowedUrgencies.filter((u) => u !== opt.value),
                          })
                        }
                        className="h-4 w-4 accent-gray-900"
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={policy.resolveOnAutoSend}
                  onChange={(e) => setPolicy({ ...policy, resolveOnAutoSend: e.target.checked })}
                  className="h-4 w-4 accent-gray-900"
                />
                <span className="text-sm text-gray-700">Mark ticket resolved after auto-sending</span>
              </label>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleSavePolicy}
                  disabled={policySaving}
                  className="bg-gray-900 text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {policySaving ? 'Saving…' : 'Save policy'}
                </button>
                {policySuccess && <span className="text-sm text-green-700">Policy saved.</span>}
                {policyError && <span className="text-sm text-red-700">{policyError}</span>}
              </div>
            </div>
          )}
        </section>

        {/* Inbox Configuration */}
        <section className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-4">Inbox Configuration</h2>
          <p className="text-xs text-gray-400 mb-4">
            Configure Resend for this tenant&apos;s inbound and outbound email.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
