// Typed decision client (JEV on OpenRouter) with an LLM fallback.
// Server-only: it uses the service-role Supabase client to write decision_log.
//
//   DECISION_MODEL    default ~typesafe/jev-latest
//   DECISION_ENGINE   jev (default) | llm (force the fallback engine)
//   OPENROUTER_API_KEY / AI_BASE_URL are shared with src/lib/llm.ts.

import { AI_BASE_URL, AI_CHAT_MODEL, chatCompletion, getAiApiKey, parseJsonReply } from '@/lib/llm';
import { supabase } from '@/lib/supabase';

// ── Question builders ───────────────────────────────────────────────────────

export interface ChoiceQuestion<K extends string = string> {
  type: 'choice';
  criteria: Record<K, string>;
  instructions?: string;
}

export interface ScoreQuestion {
  type: 'score';
  levels: readonly string[];
  instructions?: string;
}

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: string;
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export function choice<const K extends string>(
  criteria: Record<K, string>,
  instructions?: string
): ChoiceQuestion<K> {
  return { type: 'choice', criteria, ...(instructions ? { instructions } : {}) };
}

export function score<const L extends readonly string[]>(
  levels: L,
  instructions?: string
): ScoreQuestion {
  return { type: 'score', levels, ...(instructions ? { instructions } : {}) };
}

export function noul(instructions: string, criteria?: string): NoulQuestion {
  return { type: 'noul', instructions, ...(criteria ? { criteria } : {}) };
}

// ── Answers ─────────────────────────────────────────────────────────────────

export interface ChoiceAnswer<K extends string = string> {
  type: 'choice';
  choice: K;
  probabilities: Record<K, number>;
  confidence?: number;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  level: number;
  label: string;
  probabilities: number[];
  confidence?: number;
}

export interface NoulAnswer {
  type: 'noul';
  probability: number;
  confidence?: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type AnswerFor<Q extends Question> = Q extends ChoiceQuestion<infer K>
  ? ChoiceAnswer<K>
  : Q extends ScoreQuestion
    ? ScoreAnswer
    : Q extends NoulQuestion
      ? NoulAnswer
      : never;

export type AnswerMap<Q extends Record<string, Question>> = { [P in keyof Q]: AnswerFor<Q[P]> };

export interface DecisionResult<Q extends Record<string, Question>> {
  answers: AnswerMap<Q>;
  confidence: number | null;
  cost: number;
  latencyMs: number;
  engine: 'jev' | 'llm';
  model: string;
}

export class DecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionError';
  }
}

// ── Logging ─────────────────────────────────────────────────────────────────

export interface DecisionLogRow {
  tenant_id: string | null;
  ticket_id: string | null;
  purpose: string;
  engine: 'jev' | 'llm';
  model: string | null;
  questions: Record<string, unknown>;
  answers: Record<string, unknown> | null;
  latency_ms: number;
  cost_usd: number;
  error: string | null;
}

export interface DecisionLogClient {
  from(table: string): {
    insert(row: DecisionLogRow): PromiseLike<{ error?: unknown }> | { error?: unknown };
  };
}

async function logDecision(client: DecisionLogClient, row: DecisionLogRow): Promise<void> {
  try {
    const result = await client.from('decision_log').insert(row);
    const error = (result as { error?: unknown } | null)?.error;
    if (error) console.error('decision_log insert failed:', error);
  } catch (err) {
    console.error('decision_log insert failed:', err instanceof Error ? err.message : err);
  }
}

// ── Options ─────────────────────────────────────────────────────────────────

export interface DecideOptions {
  tenantId?: string | null;
  ticketId?: string | null;
  purpose?: string;
  engine?: 'jev' | 'llm';
  signal?: AbortSignal;
  client?: DecisionLogClient;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODEL = '~typesafe/jev-latest';
const STATE_LIMIT_BYTES = 30 * 1024;
const JEV_TIMEOUT_MS = 3000;

function decisionModel(): string {
  return process.env.DECISION_MODEL || DEFAULT_MODEL;
}

function jevUrl(): string {
  return `${new URL(AI_BASE_URL).origin}/api/alpha/decisions`;
}

// ── State truncation ────────────────────────────────────────────────────────

function utf8SafeEnd(buf: Buffer, end: number): number {
  let cut = Math.min(end, buf.length);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (cut > 0) {
    try {
      decoder.decode(buf.subarray(0, cut));
      return cut;
    } catch {
      cut--;
    }
  }
  return 0;
}

/**
 * Cut text to at most `maxBytes` UTF-8 bytes and append a marker noting how many
 * bytes were dropped. The marker counts towards the budget.
 */
export function truncateForState(text: string, maxBytes = 8192): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;

  let keep = Math.max(0, maxBytes);
  for (let i = 0; i < 8; i++) {
    const end = utf8SafeEnd(buf, keep);
    const marker = `\n[…truncated ${buf.length - end} bytes]`;
    const nextKeep = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
    if (nextKeep === keep) return buf.subarray(0, end).toString('utf8') + marker;
    keep = nextKeep;
  }

  const end = utf8SafeEnd(buf, keep);
  return buf.subarray(0, end).toString('utf8') + `\n[…truncated ${buf.length - end} bytes]`;
}

// ── Wire questions ──────────────────────────────────────────────────────────

function wireQuestion(q: Question): Record<string, unknown> {
  if (q.type === 'choice') {
    return { type: 'choice', criteria: q.criteria, ...(q.instructions ? { instructions: q.instructions } : {}) };
  }
  if (q.type === 'score') {
    return {
      type: 'score',
      criteria: q.levels,
      ...(q.instructions ? { instructions: q.instructions } : {}),
    };
  }
  return {
    type: 'noul',
    instructions: q.instructions,
    ...(q.criteria ? { criteria: q.criteria } : {}),
  };
}

function wireQuestions(questions: Record<string, Question>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, wireQuestion(q)]));
}

// ── JEV ─────────────────────────────────────────────────────────────────────

class JevFailure extends Error {
  constructor(
    readonly reason: string,
    readonly retryable: boolean
  ) {
    super(reason);
    this.name = 'JevFailure';
  }
}

interface JevResult {
  answers: Record<string, Answer>;
  model: string;
  cost: number;
}

function malformed(): JevFailure {
  return new JevFailure('malformed response', false);
}

function readConfidence(raw: Record<string, unknown>): number | undefined {
  return typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
    ? raw.confidence
    : undefined;
}

function parseJevAnswer(q: Question, raw: unknown): Answer {
  if (!raw || typeof raw !== 'object') throw malformed();
  const a = raw as Record<string, unknown>;

  if (q.type === 'choice') {
    if (a.type !== 'choice') throw malformed();
    const keys = Object.keys(q.criteria);
    if (typeof a.choice !== 'string' || !keys.includes(a.choice)) throw malformed();
    if (!a.probabilities || typeof a.probabilities !== 'object') throw malformed();
    const rec = a.probabilities as Record<string, unknown>;
    const probabilities: Record<string, number> = {};
    for (const key of keys) {
      const value = rec[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) throw malformed();
      probabilities[key] = value;
    }
    return {
      type: 'choice',
      choice: a.choice,
      probabilities,
      ...(readConfidence(a) !== undefined ? { confidence: readConfidence(a) } : {}),
    };
  }

  if (q.type === 'score') {
    if (a.type !== 'score') throw malformed();
    if (typeof a.score !== 'number' || !Number.isFinite(a.score)) throw malformed();
    const n = q.levels.length;
    const probabilities: number[] = [];
    for (let i = 0; i < n; i++) {
      let value: unknown;
      if (Array.isArray(a.probabilities)) value = a.probabilities[i];
      else if (a.probabilities && typeof a.probabilities === 'object')
        value = (a.probabilities as Record<string, unknown>)[String(i)];
      if (typeof value !== 'number' || !Number.isFinite(value)) throw malformed();
      probabilities.push(value);
    }
    const level = Math.min(Math.max(Math.round(a.score), 0), Math.max(n - 1, 0));
    return {
      type: 'score',
      score: a.score,
      level,
      label: q.levels[level] ?? String(level),
      probabilities,
      ...(readConfidence(a) !== undefined ? { confidence: readConfidence(a) } : {}),
    };
  }

  if (a.type !== 'noul') throw malformed();
  if (typeof a.noul !== 'number' || !Number.isFinite(a.noul)) throw malformed();
  return {
    type: 'noul',
    probability: Math.min(Math.max(a.noul, 0), 1),
    ...(readConfidence(a) !== undefined ? { confidence: readConfidence(a) } : {}),
  };
}

function parseJevResponse(data: unknown, questions: Record<string, Question>): JevResult {
  if (!data || typeof data !== 'object') throw malformed();
  const obj = data as Record<string, unknown>;
  if (!obj.answers || typeof obj.answers !== 'object') throw malformed();
  const rawAnswers = obj.answers as Record<string, unknown>;

  const answers: Record<string, Answer> = {};
  for (const [name, q] of Object.entries(questions)) {
    answers[name] = parseJevAnswer(q, rawAnswers[name]);
  }

  const usage = obj.usage as Record<string, unknown> | undefined;
  const cost =
    usage && typeof usage.cost === 'number' && Number.isFinite(usage.cost) ? usage.cost : 0;
  const model = typeof obj.model === 'string' && obj.model ? obj.model : decisionModel();

  return { answers, model, cost };
}

async function jevAttempt(
  state: string,
  questions: Record<string, Question>,
  fetchImpl: typeof fetch,
  outerSignal: AbortSignal | undefined
): Promise<JevResult> {
  const apiKey = getAiApiKey();
  if (!apiKey) throw new JevFailure('missing api key', false);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, JEV_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  if (outerSignal?.aborted) controller.abort();
  else outerSignal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await fetchImpl(jevUrl(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: decisionModel(), state, questions: wireQuestions(questions) }),
        signal: controller.signal,
      });
    } catch {
      if (timedOut) throw new JevFailure('timeout', true);
      throw new JevFailure('network', true);
    }

    if (!response.ok) {
      throw new JevFailure(String(response.status), response.status >= 500);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw malformed();
    }
    return parseJevResponse(data, questions);
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }
}

async function callJev(
  state: string,
  questions: Record<string, Question>,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined
): Promise<JevResult> {
  try {
    return await jevAttempt(state, questions, fetchImpl, signal);
  } catch (err) {
    if (err instanceof JevFailure && err.retryable) {
      return jevAttempt(state, questions, fetchImpl, signal);
    }
    throw err;
  }
}

// ── LLM fallback ────────────────────────────────────────────────────────────

function buildLlmPrompt(questions: Record<string, Question>): string {
  const lines: string[] = [
    'You are a strict decision engine for a customer-support platform.',
    'Read the ticket state and answer every question. Reply with a single JSON object, no prose.',
    'The object must have exactly these keys:',
  ];

  for (const [name, q] of Object.entries(questions)) {
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      const described = keys.map((k) => `${k} = ${q.criteria[k]}`).join('; ');
      lines.push(
        `- "${name}" (choice): exactly one of ${keys.map((k) => JSON.stringify(k)).join(', ')}. ${described}.`
      );
    } else if (q.type === 'score') {
      const levels = q.levels.map((label, i) => `${i} = ${label}`).join(', ');
      lines.push(
        `- "${name}" (score): an integer level index from 0 to ${Math.max(0, q.levels.length - 1)}, where ${levels}.`
      );
    } else {
      const criteria = q.criteria ? ` ${q.criteria}` : '';
      lines.push(`- "${name}" (noul): a number from 0 to 1, the probability that yes.${criteria}`);
    }
    if (q.instructions) lines.push(`  Instructions: ${q.instructions}`);
  }

  lines.push('Output shape: { "<name>": <value>, ... }');
  return lines.join('\n');
}

function normaliseLlm(raw: unknown, questions: Record<string, Question>): Record<string, Answer> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('reply was not a JSON object');
  }
  const rec = raw as Record<string, unknown>;
  const answers: Record<string, Answer> = {};

  for (const [name, q] of Object.entries(questions)) {
    const value = rec[name];
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      if (typeof value !== 'string' || !keys.includes(value)) {
        throw new Error(`invalid choice for "${name}"`);
      }
      const probabilities = Object.fromEntries(keys.map((k) => [k, k === value ? 1 : 0]));
      answers[name] = { type: 'choice', choice: value, probabilities };
    } else if (q.type === 'score') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`invalid score for "${name}"`);
      }
      const n = q.levels.length;
      const level = Math.min(Math.max(Math.round(value), 0), Math.max(n - 1, 0));
      answers[name] = {
        type: 'score',
        score: level,
        level,
        label: q.levels[level] ?? String(level),
        probabilities: q.levels.map((_, i) => (i === level ? 1 : 0)),
      };
    } else {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`invalid probability for "${name}"`);
      }
      answers[name] = { type: 'noul', probability: Math.min(Math.max(value, 0), 1) };
    }
  }

  return answers;
}

async function callLlm(
  state: string,
  questions: Record<string, Question>
): Promise<{ answers: Record<string, Answer>; model: string }> {
  const reply = await chatCompletion(
    [
      { role: 'system', content: buildLlmPrompt(questions) },
      { role: 'user', content: state },
    ],
    { json: true, temperature: 0 }
  );

  let parsed: unknown;
  try {
    parsed = parseJsonReply(reply);
  } catch {
    throw new Error('invalid JSON reply');
  }

  return { answers: normaliseLlm(parsed, questions), model: AI_CHAT_MODEL };
}

// ── decide() ────────────────────────────────────────────────────────────────

function overallConfidence(answers: Record<string, Answer>): number | null {
  const values = Object.values(answers)
    .map((a) => a.confidence)
    .filter((v): v is number => typeof v === 'number');
  return values.length ? Math.min(...values) : null;
}

/**
 * Answer typed questions about a piece of state. Tries JEV first (unless the
 * engine is forced to `llm`), falls back to a JSON-mode chat completion, and
 * writes exactly one decision_log row per call.
 */
export async function decide<Q extends Record<string, Question>>(
  state: string,
  questions: Q,
  opts: DecideOptions = {}
): Promise<DecisionResult<Q>> {
  const started = Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const client = opts.client ?? (supabase as unknown as DecisionLogClient);
  const requestedEngine =
    opts.engine ?? (process.env.DECISION_ENGINE === 'llm' ? 'llm' : 'jev');
  const stateText = truncateForState(state, STATE_LIMIT_BYTES);
  const wire = wireQuestions(questions);

  const base = {
    tenant_id: opts.tenantId ?? null,
    ticket_id: opts.ticketId ?? null,
    purpose: opts.purpose ?? 'adhoc',
    questions: wire,
  };

  let jevError: string | null = null;

  if (requestedEngine === 'jev') {
    try {
      const jev = await callJev(stateText, questions, fetchImpl, opts.signal);
      const latencyMs = Date.now() - started;
      await logDecision(client, {
        ...base,
        engine: 'jev',
        model: jev.model,
        answers: jev.answers,
        latency_ms: latencyMs,
        cost_usd: jev.cost,
        error: null,
      });
      return {
        answers: jev.answers as AnswerMap<Q>,
        confidence: overallConfidence(jev.answers),
        cost: jev.cost,
        latencyMs,
        engine: 'jev',
        model: jev.model,
      };
    } catch (err) {
      const reason = err instanceof JevFailure ? err.reason : (err as Error)?.message || 'error';
      jevError = `jev: ${reason}`;
    }
  }

  try {
    const llm = await callLlm(stateText, questions);
    const latencyMs = Date.now() - started;
    await logDecision(client, {
      ...base,
      engine: 'llm',
      model: llm.model,
      answers: llm.answers,
      latency_ms: latencyMs,
      cost_usd: 0,
      error: jevError,
    });
    return {
      answers: llm.answers as AnswerMap<Q>,
      confidence: overallConfidence(llm.answers),
      cost: 0,
      latencyMs,
      engine: 'llm',
      model: llm.model,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const llmError = `llm: ${err instanceof Error ? err.message : String(err)}`;
    const error = jevError ? `${jevError}; ${llmError}` : llmError;
    await logDecision(client, {
      ...base,
      engine: 'llm',
      model: AI_CHAT_MODEL,
      answers: null,
      latency_ms: latencyMs,
      cost_usd: 0,
      error,
    });
    throw new DecisionError(error);
  }
}
