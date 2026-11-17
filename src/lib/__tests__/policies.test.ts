import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSupabaseAdminClient } from '@/lib/supabase-server';
import {
  DEFAULT_DECISION_THRESHOLDS,
  getTenantPolicy,
  invalidatePolicyCache,
  SAFE_DEFAULT_POLICY,
  updateTenantPolicy,
} from '@/lib/policies';

/* eslint-disable @typescript-eslint/no-explicit-any */

vi.mock('@/lib/supabase-server', () => ({
  createSupabaseAdminClient: vi.fn(),
}));

const mockedClient = vi.mocked(createSupabaseAdminClient);

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: 'tenant-1',
    auto_send_enabled: false,
    confidence_threshold: 0.85,
    allowed_types: ['question'],
    allowed_urgencies: ['low'],
    min_kb_similarity: 0.7,
    min_kb_hits: 1,
    resolve_on_auto_send: true,
    decision_mode: 'shadow',
    decision_thresholds: { ...DEFAULT_DECISION_THRESHOLDS },
    version: 1,
    ...overrides,
  };
}

function fakeRead(data: unknown): { from: ReturnType<typeof vi.fn>; chain: any } {
  const chain: any = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
  };
  const from = vi.fn(() => chain);
  mockedClient.mockReturnValue({ from } as any);
  return { from, chain };
}

beforeEach(() => {
  invalidatePolicyCache();
  mockedClient.mockReset();
});

describe('getTenantPolicy', () => {
  it('returns the safe default (shadow + default thresholds) when the row is missing', async () => {
    fakeRead(null);

    const policy = await getTenantPolicy('tenant-1');

    expect(policy.decisionMode).toBe(SAFE_DEFAULT_POLICY.decisionMode);
    expect(policy.decisionMode).toBe('shadow');
    expect(policy.decisionThresholds).toEqual(DEFAULT_DECISION_THRESHOLDS);
  });

  it('reads decision_mode and merges partial decision_thresholds with defaults', async () => {
    const { chain } = fakeRead(
      row({ decision_mode: 'jev', decision_thresholds: { label_suggest: 0.9 } })
    );

    const policy = await getTenantPolicy('tenant-1');

    expect(policy.decisionMode).toBe('jev');
    expect(policy.decisionThresholds).toEqual({
      spam_auto_decline: DEFAULT_DECISION_THRESHOLDS.spam_auto_decline,
      label_suggest: 0.9,
      needs_human: DEFAULT_DECISION_THRESHOLDS.needs_human,
    });

    const selectArg = chain.select.mock.calls[0][0] as string;
    expect(selectArg).toContain('decision_mode');
    expect(selectArg).toContain('decision_thresholds');
  });

  it('treats an invalid decision_mode as shadow', async () => {
    fakeRead(row({ decision_mode: 'magic' }));

    const policy = await getTenantPolicy('tenant-1');

    expect(policy.decisionMode).toBe('shadow');
  });
});

describe('updateTenantPolicy', () => {
  it('persists a patched decision mode and thresholds', async () => {
    const upsert = vi.fn();
    const updated = row({
      decision_mode: 'llm',
      decision_thresholds: { ...DEFAULT_DECISION_THRESHOLDS, needs_human: 0.2 },
    });
    const chain: any = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => ({ data: row(), error: null })),
      upsert: vi.fn((values: unknown, options: unknown) => {
        upsert(values, options);
        return chain;
      }),
      single: vi.fn(async () => ({ data: updated, error: null })),
    };
    mockedClient.mockReturnValue({ from: () => chain } as any);

    const result = await updateTenantPolicy(
      'tenant-1',
      {
        decisionMode: 'llm',
        decisionThresholds: { ...DEFAULT_DECISION_THRESHOLDS, needs_human: 0.2 },
      },
      'user-1'
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        decision_mode: 'llm',
        decision_thresholds: expect.objectContaining({ needs_human: 0.2 }),
      }),
      { onConflict: 'tenant_id' }
    );
    expect(result?.decisionMode).toBe('llm');
    expect(result?.decisionThresholds.needs_human).toBe(0.2);
  });
});
