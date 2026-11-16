import { describe, expect, it } from 'vitest';
import { urgencyToPriority } from '@/lib/db';

describe('urgencyToPriority', () => {
  it('maps triage urgency onto the priority scale', () => {
    expect(urgencyToPriority('critical')).toBe('urgent');
    expect(urgencyToPriority('high')).toBe('high');
    expect(urgencyToPriority('medium')).toBe('medium');
    expect(urgencyToPriority('low')).toBe('low');
  });

  it('falls back to none for unknown, null or undefined', () => {
    expect(urgencyToPriority('something-else')).toBe('none');
    expect(urgencyToPriority(null)).toBe('none');
    expect(urgencyToPriority(undefined)).toBe('none');
  });
});
