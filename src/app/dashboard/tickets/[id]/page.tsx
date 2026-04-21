'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

// ── Types ──────────────────────────────────────────────────────────────────────

interface Ticket {
  id: string;
  contact_name: string | null;
  contact_email: string | null;
  product: string;
  triage_type: string | null;
  triage_urgency: string | null;
  triage_summary: string | null;
  triage_confidence: number | null;
  auto_reply_sent: boolean;
  auto_reply_text: string | null;
  auto_resolved: boolean;
  status: 'open' | 'resolved' | 'pending';
  created_at: string;
  updated_at: string;
}

interface Message {
  id: string;
  direction: 'incoming' | 'outgoing';
  content: string;
  sender_name: string | null;
  created_at: string;
}

interface OutboundMessage {
  id: string;
  to_email: string;
  from_email: string;
  subject: string;
  body_text: string;
  status: string;
  created_at: string;
}

// ── Colour helpers ─────────────────────────────────────────────────────────────

const urgencyColors: Record<string, string> = {
  critical: 'text-red-700 bg-red-50 border-red-200',
  high: 'text-orange-700 bg-orange-50 border-orange-200',
  medium: 'text-yellow-700 bg-yellow-50 border-yellow-200',
  low: 'text-green-700 bg-green-50 border-green-200',
};

const statusColors: Record<string, string> = {
  open: 'text-amber-700 bg-amber-50',
  resolved: 'text-green-700 bg-green-50',
  pending: 'text-blue-700 bg-blue-50',
};

const outboundStatusColors: Record<string, string> = {
  sent: 'text-green-600 bg-green-50',
  delivered: 'text-green-700 bg-green-100',
  pending: 'text-blue-600 bg-blue-50',
  failed: 'text-red-600 bg-red-50',
  bounced: 'text-red-700 bg-red-100',
};

// ── Component ──────────────────────────────────────────────────────────────────

export default function TicketDetailPage() {
  const params = useParams();
  const router = useRouter();
  const ticketId = params.id as string;

  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [outboundMessages, setOutboundMessages] = useState<OutboundMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reply composer state
  const [replyText, setReplyText] = useState('');
  const [replySubject, setReplySubject] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendSuccess, setSendSuccess] = useState(false);

  // Status update state
  const [updatingStatus, setUpdatingStatus] = useState(false);

  const fetchTicket = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tickets/${ticketId}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Failed to load ticket');
      }
      const data = await res.json();
      setTicket(data.ticket);
      setMessages(data.messages ?? []);
      setOutboundMessages(data.outboundMessages ?? []);

      // Pre-fill reply subject
      if (data.ticket?.contact_name) {
        setReplySubject(`Re: Your support request`);
      } else {
        setReplySubject('Re: Your support request');
      }

      // Pre-fill reply with AI draft if present and not yet sent
      if (data.ticket?.auto_reply_text && !data.ticket?.auto_reply_sent) {
        setReplyText(data.ticket.auto_reply_text);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ticket');
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    fetchTicket();
  }, [fetchTicket]);

  // ── Send reply ───────────────────────────────────────────────────────────────

  async function handleSendReply() {
    if (!ticket || !replyText.trim() || !ticket.contact_email) return;

    setSending(true);
    setSendError(null);
    setSendSuccess(false);

    try {
      // Get tenant ID
      const meRes = await fetch('/api/me/tenant');
      if (!meRes.ok) throw new Error('Not authenticated');
      const { tenantId } = await meRes.json();

      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId,
          to: ticket.contact_email,
          subject: replySubject || 'Re: Your support request',
          text: replyText,
          ticketId: ticket.id,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Send failed');
      }

      setSendSuccess(true);
      setReplyText('');
      setTimeout(() => setSendSuccess(false), 3000);

      // Refresh ticket to show new outbound message
      await fetchTicket();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send reply');
    } finally {
      setSending(false);
    }
  }

  // ── Update status ────────────────────────────────────────────────────────────

  async function handleStatusChange(newStatus: 'open' | 'resolved' | 'pending') {
    if (!ticket) return;
    setUpdatingStatus(true);

    try {
      const res = await fetch(`/api/tickets/${ticket.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Status update failed');
      }

      const data = await res.json();
      setTicket(data.ticket);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status');
    } finally {
      setUpdatingStatus(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16 text-center text-gray-400 text-sm">
        Loading ticket…
      </div>
    );
  }

  if (error || !ticket) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-md px-4 py-3 text-sm mb-4">
          {error ?? 'Ticket not found'}
        </div>
        <Link
          href="/dashboard/tickets"
          className="text-sm text-gray-500 hover:text-gray-900 font-medium"
        >
          ← Back to Tickets
        </Link>
      </div>
    );
  }

  // Build chronological thread: merge messages + outbound for display
  const contactDisplay = ticket.contact_name ?? ticket.contact_email ?? 'Unknown contact';

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <Link
            href="/dashboard/tickets"
            className="text-sm text-gray-400 hover:text-gray-700 font-medium mb-2 block"
          >
            ← All Tickets
          </Link>
          <h1 className="text-xl font-bold text-gray-900">{contactDisplay}</h1>
          {ticket.contact_email && (
            <p className="text-sm text-gray-400 mt-0.5">{ticket.contact_email}</p>
          )}
        </div>

        {/* Status badge + actions */}
        <div className="flex items-center gap-2 flex-shrink-0 mt-6">
          <span
            className={`text-xs font-semibold px-3 py-1 rounded-full ${statusColors[ticket.status] ?? 'text-gray-600 bg-gray-100'}`}
          >
            {ticket.status}
          </span>

          {ticket.status !== 'resolved' ? (
            <button
              onClick={() => handleStatusChange('resolved')}
              disabled={updatingStatus}
              className="text-xs font-medium px-3 py-1 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 transition-colors"
            >
              {updatingStatus ? '…' : 'Resolve'}
            </button>
          ) : (
            <button
              onClick={() => handleStatusChange('open')}
              disabled={updatingStatus}
              className="text-xs font-medium px-3 py-1 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 disabled:opacity-50 transition-colors"
            >
              {updatingStatus ? '…' : 'Reopen'}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Left: Conversation thread + reply */}
        <div className="lg:col-span-2 space-y-4">

          {/* Message thread */}
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900 text-sm">Conversation</h2>
            </div>

            {messages.length === 0 && outboundMessages.length === 0 ? (
              <div className="px-5 py-12 text-center text-gray-400 text-sm">
                No messages in this conversation yet.
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {/* Inbound messages from the messages table */}
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`px-5 py-4 ${msg.direction === 'incoming' ? 'bg-white' : 'bg-indigo-50'}`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className={`text-xs font-semibold ${
                          msg.direction === 'incoming' ? 'text-gray-700' : 'text-indigo-700'
                        }`}
                      >
                        {msg.direction === 'incoming'
                          ? (msg.sender_name ?? contactDisplay)
                          : (msg.sender_name ?? 'Support Agent')}
                      </span>
                      <span className="text-xs text-gray-400">
                        {new Date(msg.created_at).toLocaleString()}
                      </span>
                      {msg.direction === 'outgoing' && (
                        <span className="text-xs text-indigo-500 bg-indigo-100 px-1.5 py-0.5 rounded font-medium">
                          sent
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
                      {msg.content}
                    </p>
                  </div>
                ))}

                {/* Outbound messages sent via Resend (if not already in messages table) */}
                {outboundMessages.map((om) => (
                  <div key={om.id} className="px-5 py-4 bg-green-50">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-semibold text-green-700">Support Agent</span>
                      <span className="text-xs text-gray-400">
                        {new Date(om.created_at).toLocaleString()}
                      </span>
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded font-medium ${outboundStatusColors[om.status] ?? 'text-gray-600 bg-gray-100'}`}
                      >
                        {om.status}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 mb-1 font-medium">{om.subject}</p>
                    <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
                      {om.body_text}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Reply composer */}
          {ticket.contact_email ? (
            <div className="bg-white border border-gray-200 rounded-lg p-5">
              <h2 className="font-semibold text-gray-900 text-sm mb-4">Reply to {ticket.contact_email}</h2>

              {sendSuccess && (
                <div className="bg-green-50 border border-green-200 text-green-700 rounded-md px-4 py-2 mb-4 text-sm">
                  Reply sent successfully.
                </div>
              )}
              {sendError && (
                <div className="bg-red-50 border border-red-200 text-red-700 rounded-md px-4 py-2 mb-4 text-sm">
                  {sendError}
                </div>
              )}

              <div className="mb-3">
                <label className="block text-xs font-medium text-gray-500 mb-1">Subject</label>
                <input
                  type="text"
                  value={replySubject}
                  onChange={(e) => setReplySubject(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
                />
              </div>

              <div className="mb-4">
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-gray-500">Message</label>
                  {ticket.auto_reply_text && !ticket.auto_reply_sent && (
                    <button
                      type="button"
                      onClick={() => setReplyText(ticket.auto_reply_text!)}
                      className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                    >
                      Use AI draft ✦
                    </button>
                  )}
                </div>
                <textarea
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Write your reply here…"
                  rows={6}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 resize-y"
                />
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={handleSendReply}
                  disabled={sending || !replyText.trim()}
                  className="bg-gray-900 text-white text-sm font-medium px-5 py-2 rounded-md hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {sending ? 'Sending…' : 'Send Reply'}
                </button>
                {ticket.status !== 'resolved' && (
                  <button
                    onClick={async () => {
                      await handleSendReply();
                      if (!sendError) handleStatusChange('resolved');
                    }}
                    disabled={sending || !replyText.trim()}
                    className="text-sm text-gray-600 hover:text-gray-900 px-3 py-2 font-medium disabled:opacity-50"
                  >
                    Send & Resolve
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-gray-50 border border-gray-200 rounded-lg px-5 py-4 text-sm text-gray-400">
              No email address on record — cannot send a reply.
            </div>
          )}
        </div>

        {/* Right: AI triage panel + ticket metadata */}
        <div className="space-y-4">

          {/* AI Triage */}
          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <h2 className="font-semibold text-gray-900 text-sm mb-4">AI Triage</h2>

            {ticket.triage_type || ticket.triage_urgency || ticket.triage_summary ? (
              <dl className="space-y-3">
                {ticket.triage_type && (
                  <div>
                    <dt className="text-xs text-gray-400 font-medium uppercase tracking-wider">Type</dt>
                    <dd className="text-sm text-gray-800 mt-0.5 capitalize">{ticket.triage_type.replace('_', ' ')}</dd>
                  </div>
                )}

                {ticket.triage_urgency && (
                  <div>
                    <dt className="text-xs text-gray-400 font-medium uppercase tracking-wider">Urgency</dt>
                    <dd className="mt-0.5">
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                          urgencyColors[ticket.triage_urgency] ?? 'text-gray-600 bg-gray-50 border-gray-200'
                        }`}
                      >
                        {ticket.triage_urgency}
                      </span>
                    </dd>
                  </div>
                )}

                {ticket.triage_confidence != null && (
                  <div>
                    <dt className="text-xs text-gray-400 font-medium uppercase tracking-wider">Confidence</dt>
                    <dd className="mt-1">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                          <div
                            className={`h-1.5 rounded-full ${
                              ticket.triage_confidence >= 0.8
                                ? 'bg-green-500'
                                : ticket.triage_confidence >= 0.6
                                ? 'bg-yellow-500'
                                : 'bg-red-500'
                            }`}
                            style={{ width: `${Math.round(ticket.triage_confidence * 100)}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-600 font-mono">
                          {Math.round(ticket.triage_confidence * 100)}%
                        </span>
                      </div>
                    </dd>
                  </div>
                )}

                {ticket.triage_summary && (
                  <div>
                    <dt className="text-xs text-gray-400 font-medium uppercase tracking-wider">Summary</dt>
                    <dd className="text-sm text-gray-700 mt-0.5 leading-relaxed">{ticket.triage_summary}</dd>
                  </div>
                )}
              </dl>
            ) : (
              <p className="text-sm text-gray-400">No AI triage data yet.</p>
            )}

            {/* AI Draft indicator */}
            {ticket.auto_reply_text && (
              <div className={`mt-4 pt-4 border-t border-gray-100`}>
                <dt className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-2">
                  AI Draft Reply
                </dt>
                <div className={`rounded-md p-3 text-xs leading-relaxed ${
                  ticket.auto_reply_sent
                    ? 'bg-green-50 text-green-700'
                    : 'bg-indigo-50 text-indigo-800'
                }`}>
                  {ticket.auto_reply_sent ? (
                    <span className="font-semibold block mb-1">✓ Auto-sent</span>
                  ) : (
                    <span className="font-semibold block mb-1">Draft (not yet sent)</span>
                  )}
                  <span className="line-clamp-3">{ticket.auto_reply_text}</span>
                </div>
              </div>
            )}
          </div>

          {/* Ticket metadata */}
          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <h2 className="font-semibold text-gray-900 text-sm mb-4">Details</h2>
            <dl className="space-y-2.5">
              <div>
                <dt className="text-xs text-gray-400 font-medium">Product</dt>
                <dd className="text-sm text-gray-800 capitalize">{ticket.product}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-400 font-medium">Status</dt>
                <dd>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${statusColors[ticket.status] ?? 'text-gray-600 bg-gray-100'}`}>
                    {ticket.status}
                  </span>
                </dd>
              </div>
              {ticket.auto_resolved && (
                <div>
                  <dt className="text-xs text-gray-400 font-medium">Resolution</dt>
                  <dd className="text-xs text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-full w-fit font-medium">
                    auto-resolved
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-gray-400 font-medium">Created</dt>
                <dd className="text-sm text-gray-600">{new Date(ticket.created_at).toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-400 font-medium">Last updated</dt>
                <dd className="text-sm text-gray-600">{new Date(ticket.updated_at).toLocaleString()}</dd>
              </div>
            </dl>

            {/* Quick status buttons */}
            <div className="mt-4 pt-4 border-t border-gray-100">
              <p className="text-xs text-gray-400 font-medium mb-2">Change Status</p>
              <div className="flex gap-2 flex-wrap">
                {(['open', 'pending', 'resolved'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => handleStatusChange(s)}
                    disabled={updatingStatus || ticket.status === s}
                    className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors disabled:cursor-not-allowed ${
                      ticket.status === s
                        ? 'bg-gray-900 text-white cursor-default'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
