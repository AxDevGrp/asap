import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { applyAutoSendStatus } from '@/lib/pipeline';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

interface FakeResult {
  data: any;
  error: { message: string; code?: string } | null;
}

function createFakeDb(seed: { tickets?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    tickets: (seed.tickets ?? []).map((row) => ({ ...row })),
    ticket_events: [],
  };
  let seq = 0;

  class Query {
    private mode: 'read' | 'insert' | 'update' = 'read';
    private pending: Row | null = null;
    private filters: [string, unknown][] = [];

    constructor(private readonly table: string) {}

    select(_columns?: string) {
      return this;
    }

    insert(values: Row) {
      this.mode = 'insert';
      this.pending = values;
      return this;
    }

    update(values: Row) {
      this.mode = 'update';
      this.pending = values;
      return this;
    }

    eq(column: string, value: unknown) {
      this.filters.push([column, value]);
      return this;
    }

    private matching(): Row[] {
      return (tables[this.table] ?? []).filter((row) =>
        this.filters.every(([column, value]) => row[column] === value)
      );
    }

    private execute(): FakeResult {
      if (this.mode === 'insert') {
        const row = {
          id: `row-${++seq}`,
          created_at: new Date().toISOString(),
          ...this.pending,
        };
        tables[this.table] = [...(tables[this.table] ?? []), row];
        return { data: [row], error: null };
      }

      if (this.mode === 'update') {
        const rows = this.matching();
        for (const row of rows) Object.assign(row, this.pending);
        return { data: rows.map((row) => ({ ...row })), error: null };
      }

      return { data: this.matching().map((row) => ({ ...row })), error: null };
    }

    single(): Promise<FakeResult> {
      const result = this.execute();
      if (result.error) return Promise.resolve(result);
      if (!result.data || result.data.length !== 1) {
        return Promise.resolve({
          data: null,
          error: { message: 'no rows returned', code: 'PGRST116' },
        });
      }
      return Promise.resolve({ data: result.data[0], error: null });
    }

    maybeSingle(): Promise<FakeResult> {
      const result = this.execute();
      return Promise.resolve({
        data: result.data && result.data.length > 0 ? result.data[0] : null,
        error: result.error,
      });
    }

    then(
      onFulfilled: (value: FakeResult) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) {
      return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
    }
  }

  return {
    client: { from: (table: string) => new Query(table) } as unknown as SupabaseClient<any>,
    tables,
  };
}

const TENANT = 'tenant-a';

function ticket(overrides: Row = {}): Row {
  return {
    id: 'ticket-1',
    tenant_id: TENANT,
    status: 'triage',
    accepted_at: null,
    resolved_at: null,
    closed_at: null,
    ...overrides,
  };
}

describe('applyAutoSendStatus', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves a triage ticket when resolveOnAutoSend is true', async () => {
    const db = createFakeDb({ tickets: [ticket()] });

    await applyAutoSendStatus('ticket-1', true, db.client);

    expect(db.tables.tickets[0].status).toBe('resolved');
    expect(db.tables.tickets[0].resolved_at).toBeTruthy();
    expect(db.tables.ticket_events).toHaveLength(1);
    expect(db.tables.ticket_events[0]).toMatchObject({
      kind: 'status_changed',
      actor_type: 'system',
      from_value: 'triage',
      to_value: 'resolved',
    });
  });

  it('walks triage -> todo -> waiting_on_customer when not resolving', async () => {
    const db = createFakeDb({ tickets: [ticket()] });

    await applyAutoSendStatus('ticket-1', false, db.client);

    expect(db.tables.tickets[0].status).toBe('waiting_on_customer');
    expect(db.tables.tickets[0].accepted_at).toBeTruthy();
    expect(db.tables.ticket_events).toHaveLength(2);
    expect(db.tables.ticket_events[0]).toMatchObject({
      kind: 'accepted',
      actor_type: 'system',
      from_value: 'triage',
      to_value: 'todo',
    });
    expect(db.tables.ticket_events[1]).toMatchObject({
      kind: 'status_changed',
      actor_type: 'system',
      from_value: 'todo',
      to_value: 'waiting_on_customer',
    });
  });

  it('moves todo to waiting_on_customer when not resolving', async () => {
    const db = createFakeDb({ tickets: [ticket({ status: 'todo' })] });

    await applyAutoSendStatus('ticket-1', false, db.client);

    expect(db.tables.tickets[0].status).toBe('waiting_on_customer');
    expect(db.tables.ticket_events).toHaveLength(1);
  });

  it('is a no-op retry on an already-resolved ticket without throwing', async () => {
    const db = createFakeDb({
      tickets: [
        ticket({
          status: 'resolved',
          resolved_at: '2026-01-02T00:00:00.000Z',
          closed_at: '2026-01-02T00:00:00.000Z',
        }),
      ],
    });

    await expect(
      applyAutoSendStatus('ticket-1', true, db.client)
    ).resolves.toBeUndefined();
    expect(db.tables.tickets[0].status).toBe('resolved');
    expect(db.tables.ticket_events).toHaveLength(0);
  });

  it('is a no-op retry on an already-waiting ticket without throwing', async () => {
    const db = createFakeDb({
      tickets: [ticket({ status: 'waiting_on_customer' })],
    });

    await expect(
      applyAutoSendStatus('ticket-1', false, db.client)
    ).resolves.toBeUndefined();
    expect(db.tables.tickets[0].status).toBe('waiting_on_customer');
    expect(db.tables.ticket_events).toHaveLength(0);
  });
});
