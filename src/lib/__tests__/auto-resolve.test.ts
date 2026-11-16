import { describe, expect, it } from 'vitest';
import { shouldAutoResolve } from '@/lib/auto-resolve';
import { SAFE_DEFAULT_POLICY, type TenantPolicy } from '@/lib/policies';

const policy: TenantPolicy = {
  ...SAFE_DEFAULT_POLICY,
  autoSendEnabled: true,
};

describe('shouldAutoResolve', () => {
  it('drafts when auto-send is disabled for the tenant', () => {
    const result = shouldAutoResolve(
      { ...policy, autoSendEnabled: false },
      { confidence: 0.99, type: 'question', urgency: 'low' },
      3,
      0.95
    );
    expect(result.autoSend).toBe(false);
    expect(result.reason).toContain('auto-send disabled');
  });

  it('sends when confidence, type/urgency and KB match policy', () => {
    const result = shouldAutoResolve(
      policy,
      { confidence: 0.95, type: 'question', urgency: 'medium' },
      2,
      0.9
    );
    expect(result.autoSend).toBe(true);
  });

  it('drafts when the top KB similarity is below the threshold', () => {
    const result = shouldAutoResolve(
      policy,
      { confidence: 0.95, type: 'question', urgency: 'low' },
      2,
      0.2
    );
    expect(result.autoSend).toBe(false);
    expect(result.reason).toContain('similarity');
  });

  it('drafts when the triage type is not allowed', () => {
    const result = shouldAutoResolve(
      policy,
      { confidence: 0.95, type: 'spam', urgency: 'low' },
      2,
      0.9
    );
    expect(result.autoSend).toBe(false);
    expect(result.reason).toContain('not in allowed types');
  });

  it('drafts when the urgency is not allowed', () => {
    const result = shouldAutoResolve(
      policy,
      { confidence: 0.95, type: 'billing', urgency: 'urgent' },
      2,
      0.9
    );
    expect(result.autoSend).toBe(false);
    expect(result.reason).toContain('not allowed');
  });

  it('drafts when there are fewer KB hits than required', () => {
    const result = shouldAutoResolve(
      policy,
      { confidence: 0.95, type: 'question', urgency: 'low' },
      0,
      null
    );
    expect(result.autoSend).toBe(false);
    expect(result.reason).toContain('KB hits');
  });
});
