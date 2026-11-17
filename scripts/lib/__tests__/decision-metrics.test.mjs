import { describe, expect, it } from 'vitest';
import {
  THRESHOLDS,
  accuracy,
  confusionMatrix,
  goNoGo,
  latestPerEngine,
  pickLabelThreshold,
  pickSpamThreshold,
  precisionRecallF1,
  sweepThresholds,
} from '../decision-metrics.mjs';

describe('accuracy', () => {
  it('is 0 for an empty input instead of NaN', () => {
    expect(accuracy([])).toBe(0);
  });

  it('counts exact matches', () => {
    const pairs = [
      { truth: 'low', predicted: 'low' },
      { truth: 'high', predicted: 'urgent' },
      { truth: 'medium', predicted: 'medium' },
      { truth: 'urgent', predicted: 'urgent' },
    ];
    expect(accuracy(pairs)).toBe(0.75);
  });
});

describe('confusionMatrix', () => {
  it('uses truth as rows and prediction as columns', () => {
    const labels = ['low', 'high'];
    const pairs = [
      { truth: 'low', predicted: 'low' },
      { truth: 'low', predicted: 'high' },
      { truth: 'high', predicted: 'high' },
      { truth: 'high', predicted: 'high' },
    ];
    expect(confusionMatrix(pairs, labels)).toEqual({
      labels,
      matrix: [
        [1, 1],
        [0, 2],
      ],
      total: 4,
    });
  });

  it('ignores pairs outside the label set', () => {
    const pairs = [
      { truth: 'low', predicted: 'none' },
      { truth: 'low', predicted: 'low' },
    ];
    expect(confusionMatrix(pairs, ['low']).total).toBe(1);
  });
});

describe('precisionRecallF1', () => {
  it('returns 0 everywhere with no pairs', () => {
    const score = precisionRecallF1([], 0.5);
    expect(score).toMatchObject({ precision: 0, recall: 0, f1: 0, tp: 0, fp: 0, fn: 0 });
  });

  it('returns precision 0 when nothing is predicted positive', () => {
    const score = precisionRecallF1([{ probability: 0.2, positive: true }], 0.5);
    expect(score.precision).toBe(0);
    expect(score.recall).toBe(0);
    expect(score.f1).toBe(0);
  });

  it('returns recall 0 with no positive examples', () => {
    const score = precisionRecallF1(
      [
        { probability: 0.9, positive: false },
        { probability: 0.1, positive: false },
      ],
      0.5
    );
    expect(score.precision).toBe(0);
    expect(score.recall).toBe(0);
    expect(score.f1).toBe(0);
    expect(score.fp).toBe(1);
  });

  it('computes precision, recall and F1', () => {
    const pairs = [
      { probability: 0.9, positive: true },
      { probability: 0.8, positive: true },
      { probability: 0.7, positive: false },
      { probability: 0.2, positive: true },
    ];
    const score = precisionRecallF1(pairs, 0.5);
    expect(score.tp).toBe(2);
    expect(score.fp).toBe(1);
    expect(score.fn).toBe(1);
    expect(score.precision).toBeCloseTo(2 / 3);
    expect(score.recall).toBeCloseTo(2 / 3);
    expect(score.f1).toBeCloseTo(2 / 3);
  });

  it('uses >= for the threshold', () => {
    const score = precisionRecallF1([{ probability: 0.5, positive: true }], 0.5);
    expect(score.tp).toBe(1);
  });
});

describe('sweepThresholds', () => {
  it('sweeps the default grid in ascending order', () => {
    const pairs = [{ probability: 0.9, positive: true }];
    const sweep = sweepThresholds(pairs);
    expect(sweep.map((row) => row.threshold)).toEqual([...THRESHOLDS]);
    expect(sweep[0].threshold).toBe(0.5);
    expect(sweep.at(-1).threshold).toBe(0.95);
    expect(sweep.find((row) => row.threshold === 0.9).tp).toBe(1);
    expect(sweep.find((row) => row.threshold === 0.95).tp).toBe(0);
  });
});

describe('pickSpamThreshold', () => {
  it('falls back to 0.95 with fewer than 10 positives', () => {
    const pairs = Array.from({ length: 4 }, () => ({ probability: 0.99, positive: true }));
    const picked = pickSpamThreshold(pairs);
    expect(picked).toMatchObject({ threshold: 0.95, fallback: true, positives: 4 });
    expect(picked.reason).toContain('positive');
  });

  it('picks the smallest threshold reaching 0.98 precision', () => {
    const pairs = [
      ...Array.from({ length: 10 }, () => ({ probability: 0.96, positive: true })),
      { probability: 0.6, positive: false },
      { probability: 0.1, positive: false },
    ];
    const picked = pickSpamThreshold(pairs);
    expect(picked.fallback).toBe(false);
    expect(picked.threshold).toBe(0.65);
    expect(picked.precision).toBe(1);
  });

  it('falls back when no threshold reaches the precision target', () => {
    const pairs = [
      ...Array.from({ length: 10 }, () => ({ probability: 0.96, positive: true })),
      { probability: 0.95, positive: false },
    ];
    const picked = pickSpamThreshold(pairs);
    expect(picked).toMatchObject({ threshold: 0.95, fallback: true });
    expect(picked.reason).toContain('no threshold');
  });
});

describe('pickLabelThreshold', () => {
  const examples = (count, positiveProbability, negativeProbability) => [
    ...Array.from({ length: count }, () => ({
      probability: positiveProbability,
      positive: true,
    })),
    ...Array.from({ length: count }, () => ({
      probability: negativeProbability,
      positive: false,
    })),
  ];

  it('falls back to 0.7 with fewer than 20 examples', () => {
    const picked = pickLabelThreshold(examples(5, 0.9, 0.1));
    expect(picked).toMatchObject({ threshold: 0.7, fallback: true, examples: 10 });
  });

  it('maximises F1 and breaks ties towards the lowest threshold', () => {
    const picked = pickLabelThreshold(examples(10, 0.9, 0.2));
    expect(picked.fallback).toBe(false);
    expect(picked.threshold).toBe(0.5);
    expect(picked.f1).toBe(1);
    expect(picked.examples).toBe(20);
  });

  it('moves above negatives above the lowest thresholds', () => {
    const picked = pickLabelThreshold(examples(10, 0.9, 0.6));
    expect(picked.fallback).toBe(false);
    expect(picked.threshold).toBe(0.65);
    expect(picked.precision).toBe(1);
  });
});

describe('latestPerEngine', () => {
  const row = (id, ticket_id, engine, created_at) => ({ id, ticket_id, engine, created_at });

  it('keeps the newest row per ticket and engine', () => {
    const rows = [
      row('a', 't1', 'jev', '2026-01-01T00:00:00Z'),
      row('b', 't1', 'jev', '2026-01-02T00:00:00Z'),
      row('c', 't1', 'llm', '2026-01-01T00:00:00Z'),
      row('d', 't2', 'jev', '2026-01-03T00:00:00Z'),
    ];
    expect(latestPerEngine(rows)).toEqual([
      row('b', 't1', 'jev', '2026-01-02T00:00:00Z'),
      row('c', 't1', 'llm', '2026-01-01T00:00:00Z'),
      row('d', 't2', 'jev', '2026-01-03T00:00:00Z'),
    ]);
  });

  it('breaks created_at ties by the larger id', () => {
    const rows = [
      row('a', 't1', 'jev', '2026-01-01T00:00:00Z'),
      row('z', 't1', 'jev', '2026-01-01T00:00:00Z'),
    ];
    expect(latestPerEngine(rows).map((r) => r.id)).toEqual(['z']);
  });
});

describe('goNoGo', () => {
  const passing = {
    jevPriorityAccuracy: 0.9,
    llmPriorityAccuracy: 0.8,
    jevSpamF1: 0.9,
    llmSpamF1: 0.85,
    groundTruthTickets: 60,
  };

  it('returns GO when every condition passes', () => {
    expect(goNoGo(passing)).toMatchObject({ decision: 'GO', reasons: [] });
  });

  it('returns NO-GO with reasons below 50 ground-truth tickets', () => {
    const result = goNoGo({ ...passing, groundTruthTickets: 49 });
    expect(result.decision).toBe('NO-GO');
    expect(result.reasons.join(' ')).toContain('need at least 50');
  });

  it('returns NO-GO when JEV priority accuracy trails LLM', () => {
    const result = goNoGo({ ...passing, jevPriorityAccuracy: 0.7 });
    expect(result.decision).toBe('NO-GO');
    expect(result.reasons.join(' ')).toContain('priority accuracy');
  });

  it('returns NO-GO when JEV spam F1 trails LLM', () => {
    const result = goNoGo({ ...passing, jevSpamF1: 0.5 });
    expect(result.decision).toBe('NO-GO');
    expect(result.reasons.join(' ')).toContain('spam F1');
  });

  it('returns NO-GO when a metric is unavailable', () => {
    const result = goNoGo({ ...passing, llmSpamF1: null });
    expect(result.decision).toBe('NO-GO');
    expect(result.reasons.join(' ')).toContain('unavailable');
  });
});
