// Live JEV smoke test — skipped unless DECISIONS_LIVE is set.
//
// `npm test` does not load .env.local, so run it with Node's env-file flag:
//   DECISIONS_LIVE=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run src/lib/__tests__/decisions.live.test.ts
// (One call, ~$0.00002. Never prints the API key.)

import { describe, expect, it } from 'vitest';
import { choice, decide, noul, score } from '@/lib/decisions';

const live = Boolean(process.env.DECISIONS_LIVE);

const questions = {
  type: choice({ bug: 'software defect', billing: 'payments', question: 'general question' }),
  priority: score(['low', 'medium', 'high', 'urgent'] as const, 'How urgent is this?'),
  is_spam: noul('Is this message spam?'),
};

describe.skipIf(!live)('decisions (live JEV)', () => {
  it(
    'answers a sample ticket with typed answers on the JEV engine',
    async () => {
      const sample =
        'From: ada@example.com\nSubject: Charged twice\n\nHi, my card was charged twice for invoice #1042. Please refund the duplicate payment.';

      const noopClient = {
        from: () => ({ insert: async () => ({ error: null }) }),
      };

      const result = await decide(sample, questions, { client: noopClient, purpose: 'triage' });

      console.log('[decisions live]', {
        engine: result.engine,
        model: result.model,
        latencyMs: result.latencyMs,
        cost: result.cost,
      });

      expect(result.engine).toBe('jev');
      expect(['bug', 'billing', 'question']).toContain(result.answers.type.choice);
      expect(result.answers.type.probabilities).toBeTypeOf('object');
      expect(result.answers.priority.level).toBeGreaterThanOrEqual(0);
      expect(result.answers.priority.level).toBeLessThanOrEqual(3);
      expect(result.answers.priority.label).toBe(['low', 'medium', 'high', 'urgent'][result.answers.priority.level]);
      expect(result.answers.is_spam.probability).toBeGreaterThanOrEqual(0);
      expect(result.answers.is_spam.probability).toBeLessThanOrEqual(1);
      expect(result.latencyMs).toBeLessThan(1000);
    },
    15000
  );
});
