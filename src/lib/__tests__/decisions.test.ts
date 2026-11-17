import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatCompletion } from '@/lib/llm';
import {
  choice,
  decide,
  DecisionError,
  noul,
  score,
  truncateForState,
  type DecisionLogRow,
} from '@/lib/decisions';

vi.mock('@/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/llm')>();
  return { ...actual, chatCompletion: vi.fn() };
});

const mockedChatCompletion = vi.mocked(chatCompletion);

const questions = {
  type: choice({ bug: 'software defect', billing: 'payments' }),
  priority: score(['low', 'medium', 'high', 'urgent'] as const, 'How urgent?'),
  is_spam: noul('Is this spam?'),
};

function jevBody(overrides: { answers?: Record<string, unknown>; model?: string } = {}) {
  const answers = {
    type: {
      type: 'choice',
      choice: 'billing',
      probabilities: { bug: 0, billing: 1 },
      confidence: 1,
    },
    priority: {
      type: 'score',
      score: 1.14,
      legend: { 0: 'low', 1: 'medium', 2: 'high', 3: 'urgent' },
      probabilities: { 0: 0.06, 1: 0.74, 2: 0.19, 3: 0.01 },
      confidence: 0.73,
    },
    is_spam: { type: 'noul', noul: 0.05 },
    ...(overrides.answers ?? {}),
  };
  return {
    model: overrides.model ?? 'typesafe/jev-1.14-20261014',
    answers,
    usage: { input_tokens: 391, output_tokens: 70, cost: 0.000016422 },
    id: 'gen-dec-test',
    provider: 'TypeSafe',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
}

type FetchMock = ReturnType<typeof mockFetch>;

function asFetch(mock: FetchMock): typeof fetch {
  return mock as unknown as typeof fetch;
}

function sentBody(mock: FetchMock, index = 0): Record<string, unknown> {
  return JSON.parse(String((mock.mock.calls[index][1] as RequestInit | undefined)?.body));
}

function fakeClient() {
  const rows: DecisionLogRow[] = [];
  const client = {
    from(table: string) {
      return {
        insert: async (row: DecisionLogRow) => {
          if (table !== 'decision_log') throw new Error(`unexpected table: ${table}`);
          rows.push(row);
          return { error: null };
        },
      };
    },
  };
  return { client, rows };
}

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
  mockedChatCompletion.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('decide — JEV', () => {
  it('normalises choice, score and noul answers', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(jevBody()));
    const { client, rows } = fakeClient();

    const result = await decide('Ticket: please refund my invoice', questions, {
      client,
      fetchImpl: asFetch(fetchImpl),
      tenantId: 'tenant-1',
      ticketId: 'ticket-1',
      purpose: 'triage',
    });

    expect(result.engine).toBe('jev');
    expect(result.model).toBe('typesafe/jev-1.14-20261014');
    expect(result.cost).toBeCloseTo(0.000016422, 12);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    expect(result.answers.type).toEqual({
      type: 'choice',
      choice: 'billing',
      probabilities: { bug: 0, billing: 1 },
      confidence: 1,
    });
    expect(result.answers.priority.score).toBe(1.14);
    expect(result.answers.priority.level).toBe(1);
    expect(result.answers.priority.label).toBe('medium');
    expect(result.answers.priority.probabilities).toEqual([0.06, 0.74, 0.19, 0.01]);
    expect(result.answers.is_spam).toEqual({ type: 'noul', probability: 0.05 });

    expect(result.confidence).toBeCloseTo(0.73, 10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: 'tenant-1',
      ticket_id: 'ticket-1',
      purpose: 'triage',
      engine: 'jev',
      model: 'typesafe/jev-1.14-20261014',
      error: null,
    });
    expect(rows[0].answers).not.toBeNull();
    expect(rows[0].cost_usd).toBeCloseTo(0.000016422, 12);
    expect(rows[0].questions).toEqual({
      type: { type: 'choice', criteria: { bug: 'software defect', billing: 'payments' } },
      priority: {
        type: 'score',
        criteria: ['low', 'medium', 'high', 'urgent'],
        instructions: 'How urgent?',
      },
      is_spam: { type: 'noul', instructions: 'Is this spam?' },
    });
  });

  it('defaults purpose to adhoc and never logs the state text', async () => {
    const marker = 'UNIQUE_SECRET_BODY_MARKER_42';
    const fetchImpl = mockFetch(async () => jsonResponse(jevBody()));
    const { client, rows } = fakeClient();

    await decide(`Please help with ${marker}`, questions, {
      client,
      fetchImpl: asFetch(fetchImpl),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].purpose).toBe('adhoc');
    expect(rows[0].tenant_id).toBeNull();
    expect(rows[0].ticket_id).toBeNull();
    expect(JSON.stringify(rows[0].questions)).not.toContain(marker);
    expect(JSON.stringify(rows[0])).not.toContain(marker);
    expect(JSON.stringify(sentBody(fetchImpl).state)).toContain(marker);
  });

  it('retries once on a 500 and succeeds', async () => {
    let calls = 0;
    const fetchImpl = mockFetch(async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({ error: 'boom' }, 500) : jsonResponse(jevBody());
    });
    const { client, rows } = fakeClient();

    const result = await decide('state', questions, { client, fetchImpl: asFetch(fetchImpl) });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.engine).toBe('jev');
    expect(rows).toHaveLength(1);
    expect(rows[0].error).toBeNull();
  });

  it('falls back after two 500s and records the JEV error', async () => {
    mockedChatCompletion.mockResolvedValueOnce('{"type":"bug","priority":2,"is_spam":0.9}');
    const fetchImpl = mockFetch(async () => jsonResponse({ error: 'boom' }, 500));
    const { client, rows } = fakeClient();

    const result = await decide('state', questions, { client, fetchImpl: asFetch(fetchImpl) });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.engine).toBe('llm');
    expect(result.cost).toBe(0);
    expect(result.answers.type.choice).toBe('bug');
    expect(result.answers.priority).toEqual({
      type: 'score',
      score: 2,
      level: 2,
      label: 'high',
      probabilities: [0, 0, 1, 0],
    });
    expect(result.answers.is_spam).toEqual({ type: 'noul', probability: 0.9 });
    expect(result.confidence).toBeNull();

    expect(rows).toHaveLength(1);
    expect(rows[0].engine).toBe('llm');
    expect(rows[0].error).toMatch(/^jev: 500/);
  });

  it('falls back when the request times out or aborts', async () => {
    mockedChatCompletion.mockResolvedValueOnce('{"type":"billing","priority":0,"is_spam":0.01}');
    const fetchImpl = mockFetch(async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    });
    const { client, rows } = fakeClient();

    const result = await decide('state', questions, { client, fetchImpl: asFetch(fetchImpl) });

    expect(result.engine).toBe('llm');
    expect(rows).toHaveLength(1);
    expect(rows[0].error).toMatch(/^jev: /);
  });

  it('does not retry a 4xx and falls back', async () => {
    mockedChatCompletion.mockResolvedValueOnce('{"type":"billing","priority":1,"is_spam":0.2}');
    const fetchImpl = mockFetch(async () => jsonResponse({ error: 'bad request' }, 400));
    const { client, rows } = fakeClient();

    const result = await decide('state', questions, { client, fetchImpl: asFetch(fetchImpl) });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.engine).toBe('llm');
    expect(rows).toHaveLength(1);
    expect(rows[0].error).toBe('jev: 400');
  });

  it.each([
    ['missing answer', { answers: { is_spam: undefined } }],
    ['choice outside the keys', { answers: { type: { type: 'choice', choice: 'other', probabilities: { bug: 0, billing: 1 } } } }],
    ['non-finite score', { answers: { priority: { type: 'score', score: 'n/a', probabilities: {} } } }],
  ])('treats a malformed response (%s) as a JEV failure', async (_label, overrides) => {
    mockedChatCompletion.mockResolvedValueOnce('{"type":"bug","priority":3,"is_spam":0}');
    const fetchImpl = mockFetch(async () => jsonResponse(jevBody(overrides)));
    const { client, rows } = fakeClient();

    const result = await decide('state', questions, { client, fetchImpl: asFetch(fetchImpl) });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.engine).toBe('llm');
    expect(rows).toHaveLength(1);
    expect(rows[0].error).toBe('jev: malformed response');
  });
});

describe('decide — LLM engine', () => {
  it('skips JEV when DECISION_ENGINE=llm', async () => {
    vi.stubEnv('DECISION_ENGINE', 'llm');
    mockedChatCompletion.mockResolvedValueOnce('{"type":"bug","priority":1,"is_spam":0.4}');
    const fetchImpl = mockFetch(async () => {
      throw new Error('JEV must not be called');
    });
    const { client, rows } = fakeClient();

    const result = await decide('state', questions, { client, fetchImpl: asFetch(fetchImpl) });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.engine).toBe('llm');
    expect(result.model).toBe('google/gemma-4-26b-a4b-it');
    expect(rows).toHaveLength(1);
    expect(rows[0].error).toBeNull();
    expect(rows[0].engine).toBe('llm');
  });

  it('allows opts.engine=llm to force the fallback', async () => {
    mockedChatCompletion.mockResolvedValueOnce('{"type":"bug","priority":1,"is_spam":0.4}');
    const fetchImpl = mockFetch(async () => jsonResponse(jevBody()));
    const { client } = fakeClient();

    const result = await decide('state', questions, {
      client,
      fetchImpl: asFetch(fetchImpl),
      engine: 'llm',
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.engine).toBe('llm');
  });

  it('throws DecisionError and logs one failed row when the fallback is malformed too', async () => {
    mockedChatCompletion.mockResolvedValueOnce('{"type":"not-a-key","priority":1,"is_spam":0.4}');
    const fetchImpl = mockFetch(async () => jsonResponse({ error: 'boom' }, 500));
    const { client, rows } = fakeClient();

    await expect(
      decide('state', questions, { client, fetchImpl: asFetch(fetchImpl) })
    ).rejects.toBeInstanceOf(DecisionError);

    expect(rows).toHaveLength(1);
    expect(rows[0].engine).toBe('llm');
    expect(rows[0].answers).toBeNull();
    expect(rows[0].error).toContain('jev: 500');
    expect(rows[0].error).toContain('llm: ');
  });
});

describe('truncateForState', () => {
  it('leaves short text untouched', () => {
    expect(truncateForState('hello world', 64)).toBe('hello world');
  });

  it('cuts multibyte text at a UTF-8 boundary and appends a byte marker', () => {
    const text = '😀'.repeat(100);
    const out = truncateForState(text, 50);

    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(50);
    expect(out).toContain('[…truncated');

    const kept = out.split('\n[…truncated')[0];
    expect(() =>
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(kept, 'utf8'))
    ).not.toThrow();
    expect(kept).not.toContain('\uFFFD');

    const claimed = Number(out.match(/truncated (\d+) bytes/)?.[1]);
    expect(claimed).toBe(Buffer.byteLength(text, 'utf8') - Buffer.byteLength(kept, 'utf8'));
  });

  it('defaults to 8 KB', () => {
    const out = truncateForState('a'.repeat(9000));
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(8192);
    expect(out).toContain('[…truncated');
  });

  it('hard-caps the state sent to the engine at 30 KB', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(jevBody()));
    const { client } = fakeClient();

    await decide('x'.repeat(40 * 1024), questions, { client, fetchImpl: asFetch(fetchImpl) });

    const state = sentBody(fetchImpl).state as string;
    expect(Buffer.byteLength(state, 'utf8')).toBeLessThanOrEqual(30 * 1024);
    expect(state).toContain('[…truncated');
  });
});
