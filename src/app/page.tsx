export const dynamic = 'force-dynamic';

import Link from 'next/link';

export default function Home() {
  return (
    <div className="min-h-screen bg-white">
      {/* Navigation */}
      <nav className="border-b border-gray-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center">
              <span className="text-xl font-bold text-gray-900">goASAP</span>
            </div>
            <div className="flex items-center gap-4">
              <Link
                href="/login"
                className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
              >
                Sign in
              </Link>
              <Link
                href="/signup"
                className="text-sm font-medium bg-gray-900 text-white px-4 py-2 rounded-md hover:bg-gray-700 transition-colors"
              >
                Get Started
              </Link>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="py-24 sm:py-32 text-center">
          <h1 className="text-5xl sm:text-6xl font-bold tracking-tight text-gray-900">
            AI Support,
            <br />
            <span className="text-gray-500">Anytime</span>
          </h1>
          <p className="mt-6 text-lg leading-8 text-gray-600 max-w-2xl mx-auto">
            The multi-tenant AI support platform that handles tickets, triages emails,
            and keeps your customers happy — 24/7.
          </p>
          <div className="mt-10 flex items-center justify-center gap-x-6">
            <Link
              href="/signup"
              className="rounded-md bg-gray-900 px-6 py-3 text-sm font-semibold text-white shadow-sm hover:bg-gray-700 transition-colors"
            >
              Start Free Trial
            </Link>
            <Link
              href="/login"
              className="text-sm font-semibold leading-6 text-gray-900 hover:text-gray-600 transition-colors"
            >
              Sign in to your account <span aria-hidden="true">&rarr;</span>
            </Link>
          </div>
        </div>

        {/* Features */}
        <div className="py-16 border-t border-gray-100">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <FeatureCard
              icon="🎫"
              title="Smart Ticketing"
              description="AI-powered ticket routing and prioritization that learns your workflow."
            />
            <FeatureCard
              icon="📧"
              title="Email Triage"
              description="Incoming emails sorted, tagged, and routed to the right team automatically."
            />
            <FeatureCard
              icon="🤖"
              title="AI Responses"
              description="Draft intelligent replies with context-aware suggestions."
            />
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-100 mt-24">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <p className="text-center text-sm text-gray-400">
            &copy; {new Date().getFullYear()} goASAP.ai — AI Support Anytime Platform
          </p>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-lg border border-gray-200 p-6 hover:border-gray-300 transition-colors">
      <div className="text-3xl mb-4">{icon}</div>
      <h3 className="text-lg font-semibold text-gray-900 mb-2">{title}</h3>
      <p className="text-sm text-gray-600">{description}</p>
    </div>
  );
}
