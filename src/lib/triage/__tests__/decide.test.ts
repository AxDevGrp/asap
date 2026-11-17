import { describe, expect, it, vi } from 'vitest';
import {
  decide,
  type Answer,
  type ChoiceQuestion,
  type NoulQuestion,
  type Question,
  type ScoreQuestion,
} from '@/lib/decisions';
import {
  buildTriageQuestions,
  buildTriageState,
  decideTriage,
  MAX_LABEL_QUESTIONS,
  PRIORITY_LEVELS,
  priorityFromIndex,
  priorityToUrgency,
  TRIAGE_TYPES,
  type TriageLabel,
} from '@/lib/triage/decide';

/* eslint-disable @typescript-eslint/no-explicit-any */

vi.mock('@/lib/decisions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/decisions')>();
  return { ...actual, decide: vi.fn() };
});

const mockedDecide = vi.mocked(decide);

function label(index: number, name = `Label ${index}`, description: string | null = null): TriageLabel {
  return { id: `label-id-${index}`, name, description };
}

function makeAnswers(overrides: Partial<Record<string, Answer>> = {}): Record<string, Answer> {
  return {
    type: {
      type: 'choice',
      choice: 'billing',
      probabilities: {
        bug: 0,
        feature_request: 0,
        question: 0,
        billing: 1,
        account: 0,
        other: 0,
      },
      confidence: 0.9,
    },
    priority: {
      type: 'score',
      score: 2,
      level: 2,
      label: 'high',
      probabilities: [0, 0, 1, 0],
      confidence: 0.8,
    },
    is_spam: { type: 'noul', probability: 0.1 },
    needs_human: { type: 'noul', probability: 0.4 },
    ...overrides,
  };
}

function fakeDecide(answers: Record<string, Answer>, confidence: number | null = 0.8) {
  return {
    answers,
    confidence,
    cost: 0.00002,
    latencyMs: 12,
    engine: 'jev' as const,
    model: 'typesafe/jev-test',
  };
}

describe('buildTriageQuestions', () => {
  it('builds the type choice, 4-level priority score and the two flags', () => {
    const { questions, labelKeys } = buildTriageQuestions([]);

    const type = questions.type as ChoiceQuestion;
    expect(type.type).toBe('choice');
    expect(Object.keys(type.criteria)).toEqual([...TRIAGE_TYPES]);

    const priority = questions.priority as ScoreQuestion;
    expect(priority.type).toBe('score');
    expect(priority.levels).toEqual([...PRIORITY_LEVELS]);
    expect(priority.instructions).toContain('low = general question');
    expect(priority.instructions).toContain('urgent = outage');

    expect(questions.is_spam.type).toBe('noul');
    expect((questions.is_spam as NoulQuestion).instructions).toMatch(/marketing/);
    expect((questions.needs_human as NoulQuestion).instructions).toContain('money movement');

    expect(labelKeys).toEqual({});
  });

  it('sorts labels by name, caps at 12 and maps label keys to ids', () => {
    const labels = Array.from({ length: 15 }, (_, i) =>
      label(i, `Label ${String(14 - i).padStart(2, '0')}`, 'described')
    );

    const { questions, labelKeys } = buildTriageQuestions(labels);

    const keys = Object.keys(labelKeys);
    expect(keys).toHaveLength(MAX_LABEL_QUESTIONS);
    expect(keys).toEqual(Array.from({ length: 12 }, (_, i) => `label_${i}`));

    expect(labelKeys.label_0).toBe('label-id-14');
    expect(labelKeys.label_11).toBe('label-id-3');

    const first = questions.label_0 as NoulQuestion;
    expect(first.instructions).toContain('Label 00');
    expect(first.instructions).toContain('described');
  });
});

describe('buildTriageState', () => {
  it('includes the subject, tier line and a body truncated to 8 KB', () => {
    const state = buildTriageState({ subject: 'Charged twice', body: 'x'.repeat(9000) }, 'enterprise');

    expect(state).toContain('Subject: Charged twice');
    expect(state).toContain('Contact tier: enterprise');
    expect(state).toContain('[…truncated');

    const bodyPart = state.split('\n\n')[1];
    expect(Buffer.byteLength(bodyPart, 'utf8')).toBeLessThanOrEqual(8192);
  });
});

describe('priority helpers', () => {
  it.each([
    [0, 'low'],
    [1, 'medium'],
    [2, 'high'],
    [3, 'urgent'],
    [9, 'urgent'],
    [-1, 'low'],
  ])('maps index %i to %s', (index, expected) => {
    expect(priorityFromIndex(index)).toBe(expected);
  });

  it('maps urgent to critical and leaves the rest unchanged', () => {
    expect(priorityToUrgency('urgent')).toBe('critical');
    expect(priorityToUrgency('high')).toBe('high');
    expect(priorityToUrgency('medium')).toBe('medium');
    expect(priorityToUrgency('low')).toBe('low');
  });
});

describe('decideTriage', () => {
  it('maps answers, filters labels by threshold and forwards options', async () => {
    const labels = [label(1, 'Billing'), label(2, 'Urgent')];
    const { questions } = buildTriageQuestions(labels);
    expect(questions.label_0).toBeDefined();

    const answers = makeAnswers({
      priority: { type: 'score', score: 2.4, level: 2, label: 'high', probabilities: [0.1, 0.1, 0.7, 0.1] },
      label_0: { type: 'noul', probability: 0.8 },
      label_1: { type: 'noul', probability: 0.69 },
    });
    const decideImpl = vi.fn(async () => fakeDecide(answers, 0.77));

    const decision = await decideTriage({ subject: 'Invoice', body: 'refund please' }, labels, undefined, {
      tenantId: 'tenant-1',
      ticketId: 'ticket-1',
      engine: 'jev',
      labelThreshold: 0.7,
      decideImpl: decideImpl as unknown as typeof decide,
    });

    expect(decision).toMatchObject({
      type: 'billing',
      priority: 'high',
      priorityIndex: 2,
      spamProbability: 0.1,
      needsHumanProbability: 0.4,
      suggestedLabelIds: ['label-id-1'],
      confidence: 0.77,
      engine: 'jev',
      model: 'typesafe/jev-test',
      cost: 0.00002,
    });

    const [state, sentQuestions, sentOpts] = decideImpl.mock.calls[0] as any;
    expect(state).toContain('Subject: Invoice');
    expect(state).toContain('refund please');
    expect(Object.keys(sentQuestions)).toContain('label_0');
    expect(sentOpts).toMatchObject({
      tenantId: 'tenant-1',
      ticketId: 'ticket-1',
      purpose: 'triage',
      engine: 'jev',
    });
  });

  it('falls back to "other" for an unknown type and keeps a null confidence', async () => {
    const answers = makeAnswers({
      type: { type: 'choice', choice: 'unknown', probabilities: {} },
    });

    const decision = await decideTriage({ subject: 's', body: 'b' }, [], undefined, {
      tenantId: 't',
      ticketId: 'tk',
      labelThreshold: 0.7,
      decideImpl: (async () => fakeDecide(answers, null)) as any,
    });

    expect(decision.type).toBe('other');
    expect(decision.confidence).toBeNull();
  });

  it('uses the shared decide() with purpose triage by default', async () => {
    mockedDecide.mockResolvedValueOnce(fakeDecide(makeAnswers()) as any);

    await decideTriage({ subject: 's', body: 'b' }, [], undefined, {
      tenantId: 'tenant-x',
      ticketId: 'ticket-x',
      labelThreshold: 0.7,
    });

    expect(mockedDecide).toHaveBeenCalledTimes(1);
    const [, , sentOpts] = mockedDecide.mock.calls[0];
    expect(sentOpts).toMatchObject({
      tenantId: 'tenant-x',
      ticketId: 'ticket-x',
      purpose: 'triage',
    });
  });
});
