import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processInboundEmail } from '@/lib/pipeline';
import { triageTicket } from '@/lib/gemini';
import { updateTicket } from '@/lib/db';
import { getTenantPolicy, type TenantPolicy } from '@/lib/policies';
import { listLabels } from '@/lib/tickets/labels';
import { transitionTicket } from '@/lib/tickets/service';
import { decideTriage, type TriageDecision } from '@/lib/triage/decide';
import { generateRagReply, searchKB } from '@/lib/rag';
import type { Tenant } from '@/lib/tenant';

/* eslint-disable @typescript-eslint/no-explicit-any */

vi.mock('@/lib/gemini', () => ({ triageTicket: vi.fn() }));

vi.mock('@/lib/db', () => ({
  updateTicket: vi.fn(async () => undefined),
  getMessagesByTicketId: vi.fn(async () => []),
  createResolveAudit: vi.fn(async () => undefined),
  createOutboundMessage: vi.fn(async () => undefined),
  reserveOutboundMessage: vi.fn(async () => ({ row: null, conflict: false })),
  getOutboundMessageByIdempotencyKey: vi.fn(async () => null),
  updateOutboundMessage: vi.fn(async () => undefined),
  createMessage: vi.fn(async () => undefined),
  urgencyToPriority: (urgency: string | null | undefined) =>
    urgency === 'critical'
      ? 'urgent'
      : urgency === 'high'
        ? 'high'
        : urgency === 'medium'
          ? 'medium'
          : urgency === 'low'
            ? 'low'
            : 'none',
}));

vi.mock('@/lib/rag', () => ({
  searchKB: vi.fn(async () => []),
  generateRagReply: vi.fn(async () => 'draft reply'),
  generateFollowUpReply: vi.fn(async () => 'follow-up reply'),
}));

vi.mock('@/lib/policies', () => ({ getTenantPolicy: vi.fn() }));

vi.mock('@/lib/tickets/labels', () => ({ listLabels: vi.fn(async () => []) }));

vi.mock('@/lib/tickets/service', () => ({
  transitionTicket: vi.fn(async () => undefined),
  InvalidTransitionError: class InvalidTransitionError extends Error {},
}));

vi.mock('@/lib/triage/decide', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/triage/decide')>();
  return { ...actual, decideTriage: vi.fn() };
});

const mockedTriageTicket = vi.mocked(triageTicket);
const mockedUpdateTicket = vi.mocked(updateTicket);
const mockedGetTenantPolicy = vi.mocked(getTenantPolicy);
const mockedListLabels = vi.mocked(listLabels);
const mockedDecideTriage = vi.mocked(decideTriage);
const mockedSearchKB = vi.mocked(searchKB);
const mockedGenerateRagReply = vi.mocked(generateRagReply);
const mockedTransitionTicket = vi.mocked(transitionTicket);

const tenant: Tenant = {
  id: 'tenant-1',
  name: 'Acme',
  slug: 'acme',
  domain: 'acme.test',
  resend_domain_id: null,
  settings: {},
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const gemma = {
  product: 'Acme',
  type: 'billing',
  urgency: 'medium' as const,
  confidence: 0.6,
  summary: 'Gemma summary',
  suggested_reply: 'Thanks, we are on it.',
};

function policy(overrides: Partial<TenantPolicy> = {}): TenantPolicy {
  return {
    autoSendEnabled: false,
    confidenceThreshold: 0.85,
    allowedTypes: ['question', 'billing', 'feature_request'],
    allowedUrgencies: ['low', 'medium'],
    minKbSimilarity: 0.7,
    minKbHits: 1,
    resolveOnAutoSend: true,
    decisionMode: 'shadow',
    decisionThresholds: { spam_auto_decline: 0.95, label_suggest: 0.7, needs_human: 0.5 },
    version: 1,
    ...overrides,
  };
}

function decision(overrides: Partial<TriageDecision> = {}): TriageDecision {
  return {
    type: 'bug',
    priority: 'high',
    priorityIndex: 2,
    spamProbability: 0.2,
    needsHumanProbability: 0.3,
    suggestedLabelIds: ['label-a'],
    confidence: 0.9,
    engine: 'jev',
    model: 'typesafe/jev-test',
    cost: 0.00002,
    ...overrides,
  };
}

function input() {
  return {
    tenant,
    ticketId: 'ticket-1',
    conversationId: 'conversation-1',
    contactEmail: 'ada@example.com',
    contactName: 'Ada',
    subject: 'Invoice is wrong',
    body: 'Please fix invoice #42',
    isFollowUp: false,
  };
}

function firstTicketUpdate(): Record<string, unknown> {
  return mockedUpdateTicket.mock.calls[0][1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetTenantPolicy.mockResolvedValue(policy());
  mockedTriageTicket.mockResolvedValue(gemma);
  mockedListLabels.mockResolvedValue([]);
  mockedSearchKB.mockResolvedValue([]);
  mockedGenerateRagReply.mockResolvedValue('draft reply');
});

describe('processInboundEmail — decision modes', () => {
  it('llm mode: uses Gemma only and never calls decideTriage', async () => {
    mockedGetTenantPolicy.mockResolvedValue(policy({ decisionMode: 'llm' }));

    await processInboundEmail(input());

    expect(mockedDecideTriage).not.toHaveBeenCalled();
    expect(mockedListLabels).not.toHaveBeenCalled();
    expect(firstTicketUpdate()).toMatchObject({
      triage_type: 'billing',
      triage_urgency: 'medium',
      triage_summary: 'Gemma summary',
      triage_confidence: 0.6,
      priority: 'medium',
    });
    expect(firstTicketUpdate()).not.toHaveProperty('ai_suggested_priority');
  });

  it('shadow mode: runs JEV and LLM decisions in parallel, stores Gemma triage + JEV suggestions', async () => {
    const jev = decision({ type: 'bug', priority: 'high', suggestedLabelIds: ['label-a'] });
    const llm = decision({
      type: 'question',
      priority: 'low',
      engine: 'llm',
      model: 'google/gemma-test',
      suggestedLabelIds: [],
    });
    mockedDecideTriage.mockImplementation(async (_ticket, _labels, _tier, opts) =>
      opts.engine === 'llm' ? llm : jev
    );

    await processInboundEmail(input());

    expect(mockedDecideTriage).toHaveBeenCalledTimes(2);
    expect(mockedDecideTriage.mock.calls.map((call) => call[3].engine)).toEqual(['jev', 'llm']);
    expect(mockedListLabels).toHaveBeenCalledWith('tenant-1');

    expect(firstTicketUpdate()).toMatchObject({
      triage_type: 'billing',
      triage_urgency: 'medium',
      triage_summary: 'Gemma summary',
      triage_confidence: 0.6,
      priority: 'medium',
      ai_suggested_priority: 'high',
      ai_suggested_type: 'bug',
      ai_suggested_label_ids: ['label-a'],
      ai_spam_probability: 0.2,
      ai_needs_human_probability: 0.3,
    });
  });

  it('shadow mode: a decision failure is logged and does not break the pipeline', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockedDecideTriage.mockRejectedValue(new Error('decisions down'));

    const result = await processInboundEmail(input());

    expect(result.autoSent).toBe(false);
    expect(firstTicketUpdate()).toMatchObject({
      triage_type: 'billing',
      triage_urgency: 'medium',
      triage_summary: 'Gemma summary',
    });
    expect(firstTicketUpdate()).not.toHaveProperty('ai_suggested_priority');
  });

  it('shadow mode: falls back to the LLM suggestion when JEV throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockedDecideTriage.mockImplementation(async (_ticket, _labels, _tier, opts) => {
      if (opts.engine === 'jev') throw new Error('jev down');
      return decision({ type: 'question', priority: 'low', engine: 'llm', suggestedLabelIds: [] });
    });

    await processInboundEmail(input());

    expect(firstTicketUpdate()).toMatchObject({
      ai_suggested_type: 'question',
      ai_suggested_priority: 'low',
      ai_suggested_label_ids: [],
    });
  });

  it('jev mode: decision supplies type/priority/urgency/confidence, Gemma the summary', async () => {
    mockedGetTenantPolicy.mockResolvedValue(policy({ decisionMode: 'jev' }));
    mockedDecideTriage.mockResolvedValue(decision({ type: 'bug', priority: 'urgent', confidence: 0.92 }));

    await processInboundEmail(input());

    expect(mockedDecideTriage).toHaveBeenCalledTimes(1);
    expect(mockedDecideTriage.mock.calls[0][3].engine).toBe('jev');
    expect(firstTicketUpdate()).toMatchObject({
      triage_type: 'bug',
      triage_urgency: 'critical',
      priority: 'urgent',
      triage_summary: 'Gemma summary',
      triage_confidence: 0.92,
      ai_suggested_priority: 'urgent',
      ai_suggested_type: 'bug',
      ai_suggested_label_ids: ['label-a'],
      ai_spam_probability: 0.2,
      ai_needs_human_probability: 0.3,
    });
  });

  it('jev mode: falls back to Gemma values when the decision throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockedGetTenantPolicy.mockResolvedValue(policy({ decisionMode: 'jev' }));
    mockedDecideTriage.mockRejectedValue(new Error('jev down'));

    await processInboundEmail(input());

    expect(firstTicketUpdate()).toMatchObject({
      triage_type: 'billing',
      triage_urgency: 'medium',
      triage_summary: 'Gemma summary',
      triage_confidence: 0.6,
      priority: 'medium',
    });
    expect(firstTicketUpdate()).not.toHaveProperty('ai_suggested_priority');
  });

  it('never applies suggestions: no status, label or transition changes', async () => {
    mockedDecideTriage.mockResolvedValue(decision());

    await processInboundEmail(input());

    expect(mockedTransitionTicket).not.toHaveBeenCalled();
    for (const [, updates] of mockedUpdateTicket.mock.calls) {
      const payload = updates as Record<string, unknown>;
      expect(payload).not.toHaveProperty('status');
      expect(payload).not.toHaveProperty('decline_kind');
      expect(payload).not.toHaveProperty('owner_id');
      expect(payload).not.toHaveProperty('label_ids');
    }
  });
});
