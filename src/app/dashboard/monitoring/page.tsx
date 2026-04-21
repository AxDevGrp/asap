'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

// ── Types ──────────────────────────────────────────────────────────────────────

interface Metrics {
  generatedAt: string;
  tickets: {
    total: number;
    last24h: number;
    last7d: number;
    open: number;
    autoResolved: number;
    autoResolveRate: number;
  };
  email: {
    totalSent30d: number;
    deliveryRate30d: number | null;
    byStatus: Record<string, number>;
  };
  triage: {
    last7d: number;
    byType: Record<string, number>;
    byUrgency: Record<string, number>;
  };
  knowledgeBase: {
    articles: number;
  };
}

// ── Colour helpers ─────────────────────────────────────────────────────────────

const urgencyColors: Record<string, string> = {
  critical: 'text-red-700 bg-red-50',
  high: 'text-orange-700 bg-orange-50',
  medium: 'text-yellow-700 bg-yellow-50',
  low: 'text-green-700 bg-green-50',
};

const emailStatusColors: Record<string, string> = {
  delivered: 'text-green-700 bg-green-50',
  sent: 'text-blue-700 bg-blue-50',
  pending: 'text-gray-600 bg-gray-50',
  failed: 'text-red-700 bg-red-50',
  bounced: 'text-red-800 bg-red-100',
  complained: 'text-orange-700 bg-orange-50',
};

// ── Stat card ──────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string | number;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-5 ${
        highlight ? 'bg-indigo-50 border-indigo-200' : 'bg-white border-gray-200'
      }`}
    >
      <div className={`text-2xl font-bold ${highlight ? 'text-indigo-700' : 'text-gray-900'}`}>
        {value}
      </div>
      <div className="text-sm font-medium text-gray-700 mt-1">{label}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function MonitoringPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<{ status: string; database?: any } | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [metricsRes, healthRes] = await Promise.all([
        fetch('/api/metrics'),
        fetch('/api/health?deep=1'),
      ]);

      if (!metricsRes.ok) throw new Error('Failed to load metrics');

      const [metricsData, healthData] = await Promise.all([
        metricsRes.json(),
        healthRes.json(),
      ]);

      setMetrics(metricsData);
      setHealth(healthData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load monitoring data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    // Auto-refresh every 60 seconds
    const interval = setInterval(fetchAll, 60_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-16 text-center text-gray-400 text-sm">
        Loading monitoring data…
      </div>
    );
  }

  if (error || !metrics) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-md px-4 py-3 text-sm">
          {error ?? 'No data available'}
        </div>
      </div>
    );
  }

  const dbOk = health?.database?.status === 'ok';

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">

      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Monitoring</h1>
          <p className="text-sm text-gray-500 mt-1">
            Updated {new Date(metrics.generatedAt).toLocaleTimeString()}
          </p>
        </div>
        <button
          onClick={fetchAll}
          className="text-xs font-medium px-3 py-1.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-md transition-colors"
        >
          ↻ Refresh
        </button>
      </div>

      {/* System Health */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
          System Health
        </h2>
        <div className="bg-white border border-gray-200 rounded-lg p-5">
          <div className="flex items-center gap-6 flex-wrap">
            <div className="flex items-center gap-2">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  health?.status === 'ok' ? 'bg-green-500' : 'bg-red-500'
                }`}
              />
              <span className="text-sm font-medium text-gray-800">API</span>
              <span
                className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  health?.status === 'ok'
                    ? 'text-green-700 bg-green-50'
                    : 'text-red-700 bg-red-50'
                }`}
              >
                {health?.status ?? 'unknown'}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  dbOk ? 'bg-green-500' : health?.database ? 'bg-red-500' : 'bg-gray-300'
                }`}
              />
              <span className="text-sm font-medium text-gray-800">Database</span>
              <span
                className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  dbOk
                    ? 'text-green-700 bg-green-50'
                    : 'text-gray-600 bg-gray-100'
                }`}
              >
                {dbOk
                  ? `ok — ${health.database.latency_ms}ms`
                  : health?.database?.status ?? 'not checked'}
              </span>
            </div>

            {(metrics.email.byStatus.bounced ?? 0) > 0 && (
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
                <span className="text-sm font-medium text-gray-800">Email Bounces</span>
                <span className="text-xs px-2 py-0.5 rounded-full font-medium text-red-700 bg-red-50">
                  {metrics.email.byStatus.bounced} bounced
                </span>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Ticket stats */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
          Tickets
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          <StatCard label="Total" value={metrics.tickets.total} />
          <StatCard label="Open" value={metrics.tickets.open} sub="needs attention" />
          <StatCard label="Last 24h" value={metrics.tickets.last24h} />
          <StatCard label="Last 7 days" value={metrics.tickets.last7d} />
          <StatCard
            label="Auto-Resolved"
            value={metrics.tickets.autoResolved}
            sub={`${metrics.tickets.autoResolveRate}% of total`}
            highlight={metrics.tickets.autoResolveRate > 50}
          />
          <StatCard label="KB Articles" value={metrics.knowledgeBase.articles} />
        </div>
      </section>

      {/* Email delivery */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
          Email Delivery (Last 30 Days)
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold text-gray-800">Delivery Rate</span>
              <span
                className={`text-lg font-bold ${
                  (metrics.email.deliveryRate30d ?? 0) >= 95
                    ? 'text-green-600'
                    : (metrics.email.deliveryRate30d ?? 0) >= 80
                    ? 'text-yellow-600'
                    : 'text-red-600'
                }`}
              >
                {metrics.email.deliveryRate30d !== null
                  ? `${metrics.email.deliveryRate30d}%`
                  : '—'}
              </span>
            </div>
            {metrics.email.deliveryRate30d !== null && (
              <div className="w-full bg-gray-100 rounded-full h-2">
                <div
                  className={`h-2 rounded-full transition-all ${
                    metrics.email.deliveryRate30d >= 95
                      ? 'bg-green-500'
                      : metrics.email.deliveryRate30d >= 80
                      ? 'bg-yellow-500'
                      : 'bg-red-500'
                  }`}
                  style={{ width: `${metrics.email.deliveryRate30d}%` }}
                />
              </div>
            )}
            <p className="text-xs text-gray-400 mt-2">
              {metrics.email.totalSent30d} emails sent
            </p>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <span className="text-sm font-semibold text-gray-800 block mb-3">By Status</span>
            {Object.keys(metrics.email.byStatus).length === 0 ? (
              <p className="text-sm text-gray-400">No emails sent yet.</p>
            ) : (
              <div className="space-y-1.5">
                {Object.entries(metrics.email.byStatus)
                  .sort(([, a], [, b]) => b - a)
                  .map(([status, count]) => (
                    <div key={status} className="flex items-center justify-between">
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                          emailStatusColors[status] ?? 'text-gray-600 bg-gray-50'
                        }`}
                      >
                        {status}
                      </span>
                      <span className="text-sm font-semibold text-gray-800">{count}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Triage breakdown */}
      {metrics.triage.last7d > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
            AI Triage (Last 7 Days — {metrics.triage.last7d} tickets)
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* By type */}
            <div className="bg-white border border-gray-200 rounded-lg p-5">
              <span className="text-sm font-semibold text-gray-800 block mb-3">By Type</span>
              {Object.keys(metrics.triage.byType).length === 0 ? (
                <p className="text-sm text-gray-400">No data.</p>
              ) : (
                <div className="space-y-2">
                  {Object.entries(metrics.triage.byType)
                    .sort(([, a], [, b]) => b - a)
                    .map(([type, count]) => (
                      <div key={type} className="flex items-center justify-between">
                        <span className="text-sm text-gray-700 capitalize">
                          {type.replace('_', ' ')}
                        </span>
                        <div className="flex items-center gap-2">
                          <div className="w-24 bg-gray-100 rounded-full h-1.5">
                            <div
                              className="h-1.5 rounded-full bg-indigo-400"
                              style={{
                                width: `${Math.round((count / metrics.triage.last7d) * 100)}%`,
                              }}
                            />
                          </div>
                          <span className="text-xs font-semibold text-gray-600 w-6 text-right">
                            {count}
                          </span>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>

            {/* By urgency */}
            <div className="bg-white border border-gray-200 rounded-lg p-5">
              <span className="text-sm font-semibold text-gray-800 block mb-3">By Urgency</span>
              {Object.keys(metrics.triage.byUrgency).length === 0 ? (
                <p className="text-sm text-gray-400">No data.</p>
              ) : (
                <div className="space-y-2">
                  {(['critical', 'high', 'medium', 'low'] as const)
                    .filter((u) => metrics.triage.byUrgency[u] !== undefined)
                    .map((urgency) => (
                      <div key={urgency} className="flex items-center justify-between">
                        <span
                          className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                            urgencyColors[urgency] ?? 'text-gray-600 bg-gray-50'
                          }`}
                        >
                          {urgency}
                        </span>
                        <span className="text-sm font-semibold text-gray-800">
                          {metrics.triage.byUrgency[urgency]}
                        </span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Quick links */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Link
          href="/dashboard/tickets"
          className="bg-white border border-gray-200 rounded-lg p-4 hover:border-gray-400 transition-colors"
        >
          <div className="font-medium text-sm text-gray-900">View Tickets →</div>
          <div className="text-xs text-gray-400 mt-0.5">{metrics.tickets.open} open</div>
        </Link>
        <Link
          href="/dashboard/kb"
          className="bg-white border border-gray-200 rounded-lg p-4 hover:border-gray-400 transition-colors"
        >
          <div className="font-medium text-sm text-gray-900">Knowledge Base →</div>
          <div className="text-xs text-gray-400 mt-0.5">{metrics.knowledgeBase.articles} articles</div>
        </Link>
        <Link
          href="/dashboard/settings"
          className="bg-white border border-gray-200 rounded-lg p-4 hover:border-gray-400 transition-colors"
        >
          <div className="font-medium text-sm text-gray-900">Settings →</div>
          <div className="text-xs text-gray-400 mt-0.5">AI config, domains, inboxes</div>
        </Link>
      </div>
    </div>
  );
}
