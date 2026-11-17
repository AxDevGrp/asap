// Pure metric helpers for scripts/decision-report.mjs.
// No I/O and no Supabase: every function is deterministic and unit-tested.

/**
 * @typedef {{ truth: string, predicted: string }} ClassificationPair
 * @typedef {{ probability: number, positive: boolean }} ProbabilityPair
 * @typedef {{
 *   precision: number, recall: number, f1: number,
 *   tp: number, fp: number, fn: number, tn: number,
 *   support: number, predictedPositive: number
 * }} ThresholdScore
 */

/** Sweep thresholds 0.50, 0.55, …, 0.95. */
export const THRESHOLDS = Object.freeze(
  Array.from({ length: 10 }, (_, i) => (50 + i * 5) / 100)
);

export const DEFAULT_SPAM_THRESHOLD = 0.95;
export const DEFAULT_LABEL_THRESHOLD = 0.7;

/**
 * Fraction of pairs whose predicted value equals the truth.
 * An empty input scores 0 (not NaN).
 * @param {ClassificationPair[]} pairs
 * @returns {number}
 */
export function accuracy(pairs) {
  if (pairs.length === 0) return 0;
  let correct = 0;
  for (const pair of pairs) if (pair.truth === pair.predicted) correct++;
  return correct / pairs.length;
}

/**
 * Confusion matrix with rows = truth and columns = predicted.
 * Pairs whose truth or prediction is not in `labels` are ignored.
 * @param {ClassificationPair[]} pairs
 * @param {string[]} labels ordered labels for rows and columns
 * @returns {{ labels: string[], matrix: number[][], total: number }}
 */
export function confusionMatrix(pairs, labels) {
  const index = new Map(labels.map((label, i) => [label, i]));
  const matrix = labels.map(() => labels.map(() => 0));
  let total = 0;
  for (const pair of pairs) {
    const row = index.get(pair.truth);
    const column = index.get(pair.predicted);
    if (row === undefined || column === undefined) continue;
    matrix[row][column]++;
    total++;
  }
  return { labels: [...labels], matrix, total };
}

/**
 * Precision/recall/F1 for a binary score at one threshold.
 * A pair is predicted positive when `probability >= threshold`.
 * Edge cases: no predictions scores precision 0, no positives scores recall 0,
 * and both empty score F1 0 — never NaN.
 * @param {ProbabilityPair[]} pairs
 * @param {number} threshold
 * @returns {ThresholdScore}
 */
export function precisionRecallF1(pairs, threshold) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const pair of pairs) {
    const predicted = pair.probability >= threshold;
    if (predicted && pair.positive) tp++;
    else if (predicted) fp++;
    else if (pair.positive) fn++;
    else tn++;
  }

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    precision,
    recall,
    f1,
    tp,
    fp,
    fn,
    tn,
    support: tp + fn,
    predictedPositive: tp + fp,
  };
}

/**
 * Precision/recall/F1 at every threshold.
 * @param {ProbabilityPair[]} pairs
 * @param {number[]} [thresholds]
 * @returns {(ThresholdScore & { threshold: number })[]}
 */
export function sweepThresholds(pairs, thresholds = THRESHOLDS) {
  return thresholds.map((threshold) => ({
    threshold,
    ...precisionRecallF1(pairs, threshold),
  }));
}

/**
 * Smallest threshold whose precision reaches `minPrecision`.
 * With too few positive examples the default (0.95) is returned instead.
 * @param {ProbabilityPair[]} pairs
 * @param {{
 *   thresholds?: number[], minPrecision?: number, minPositives?: number,
 *   fallback?: number
 * }} [options]
 * @returns {{
 *   threshold: number, fallback: boolean,
 *   precision: number | null, recall: number | null, f1: number | null,
 *   positives: number, reason: string
 * }}
 */
export function pickSpamThreshold(pairs, options = {}) {
  const {
    thresholds = THRESHOLDS,
    minPrecision = 0.98,
    minPositives = 10,
    fallback = DEFAULT_SPAM_THRESHOLD,
  } = options;

  const positives = pairs.filter((pair) => pair.positive).length;
  if (positives < minPositives) {
    return {
      threshold: fallback,
      fallback: true,
      precision: null,
      recall: null,
      f1: null,
      positives,
      reason: `only ${positives} positive spam example(s); need ${minPositives}`,
    };
  }

  for (const threshold of thresholds) {
    const score = precisionRecallF1(pairs, threshold);
    if (score.precision >= minPrecision) {
      return {
        threshold,
        fallback: false,
        precision: score.precision,
        recall: score.recall,
        f1: score.f1,
        positives,
        reason: `precision ${score.precision.toFixed(3)} at ${threshold}`,
      };
    }
  }

  return {
    threshold: fallback,
    fallback: true,
    precision: null,
    recall: null,
    f1: null,
    positives,
    reason: `no threshold reached precision ${minPrecision}`,
  };
}

/**
 * Threshold with the best F1, ties resolved to the lowest threshold.
 * With too few examples the default (0.7) is returned instead.
 * @param {ProbabilityPair[]} pairs
 * @param {{
 *   thresholds?: number[], minExamples?: number, fallback?: number
 * }} [options]
 * @returns {{
 *   threshold: number, fallback: boolean,
 *   precision: number | null, recall: number | null, f1: number | null,
 *   examples: number, reason: string
 * }}
 */
export function pickLabelThreshold(pairs, options = {}) {
  const {
    thresholds = THRESHOLDS,
    minExamples = 20,
    fallback = DEFAULT_LABEL_THRESHOLD,
  } = options;

  if (pairs.length < minExamples) {
    return {
      threshold: fallback,
      fallback: true,
      precision: null,
      recall: null,
      f1: null,
      examples: pairs.length,
      reason: `only ${pairs.length} label example(s); need ${minExamples}`,
    };
  }

  let best = null;
  for (const threshold of thresholds) {
    const score = precisionRecallF1(pairs, threshold);
    if (best === null || score.f1 > best.f1) {
      best = { threshold, ...score };
    }
  }

  return {
    threshold: best.threshold,
    fallback: false,
    precision: best.precision,
    recall: best.recall,
    f1: best.f1,
    examples: pairs.length,
    reason: `best F1 ${best.f1.toFixed(3)} at ${best.threshold}`,
  };
}

/**
 * Keep the newest row per (ticket_id, engine), which covers job retries.
 * Ties on created_at fall back to the lexicographically largest id.
 * @template {{ id: string, ticket_id: string | null, engine: string, created_at: string }} T
 * @param {T[]} rows
 * @returns {T[]} latest rows, sorted by ticket_id then engine
 */
export function latestPerEngine(rows) {
  const latest = new Map();
  for (const row of rows) {
    const key = `${row.ticket_id}\u0000${row.engine}`;
    const current = latest.get(key);
    if (current === undefined) {
      latest.set(key, row);
      continue;
    }
    const rowTime = Date.parse(row.created_at);
    const currentTime = Date.parse(current.created_at);
    if (rowTime > currentTime || (rowTime === currentTime && row.id > current.id)) {
      latest.set(key, row);
    }
  }
  return [...latest.values()].sort((a, b) =>
    String(a.ticket_id).localeCompare(String(b.ticket_id)) || a.engine.localeCompare(b.engine)
  );
}

/**
 * Go/no-go for switching decision_mode from 'llm' to 'jev'.
 * GO only when JEV matches or beats LLM on priority accuracy and spam F1 at the
 * recommended threshold, with at least `minTickets` tickets of ground truth.
 * @param {{
 *   jevPriorityAccuracy: number | null, llmPriorityAccuracy: number | null,
 *   jevSpamF1: number | null, llmSpamF1: number | null,
 *   groundTruthTickets: number, minTickets?: number
 * }} facts
 * @returns {{ decision: 'GO' | 'NO-GO', reasons: string[], checks: object }}
 */
export function goNoGo(facts) {
  const { minTickets = 50 } = facts;
  const reasons = [];

  if (facts.groundTruthTickets < minTickets) {
    reasons.push(
      `only ${facts.groundTruthTickets} ticket(s) with ground truth; need at least ${minTickets}`
    );
  }

  if (facts.jevPriorityAccuracy === null || facts.llmPriorityAccuracy === null) {
    reasons.push('priority accuracy is unavailable for one or both engines');
  } else if (facts.jevPriorityAccuracy < facts.llmPriorityAccuracy) {
    reasons.push(
      `JEV priority accuracy ${facts.jevPriorityAccuracy.toFixed(3)} < LLM ${facts.llmPriorityAccuracy.toFixed(3)}`
    );
  }

  if (facts.jevSpamF1 === null || facts.llmSpamF1 === null) {
    reasons.push('spam F1 at the recommended threshold is unavailable for one or both engines');
  } else if (facts.jevSpamF1 < facts.llmSpamF1) {
    reasons.push(
      `JEV spam F1 ${facts.jevSpamF1.toFixed(3)} < LLM ${facts.llmSpamF1.toFixed(3)} at the recommended threshold`
    );
  }

  return {
    decision: reasons.length === 0 ? 'GO' : 'NO-GO',
    reasons,
    checks: {
      ground_truth_tickets: facts.groundTruthTickets,
      min_ground_truth_tickets: minTickets,
      jev_priority_accuracy: facts.jevPriorityAccuracy,
      llm_priority_accuracy: facts.llmPriorityAccuracy,
      jev_spam_f1: facts.jevSpamF1,
      llm_spam_f1: facts.llmSpamF1,
    },
  };
}
