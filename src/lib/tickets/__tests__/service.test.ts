import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  InvalidTransitionError,
  onTicketEvent,
  setAgentDelegated,
  setOwner,
  setPriority,
  TicketNotFoundError,
  transitionTicket,
  type TicketEvent,
} from '../service';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

interface FakeResult {
  data: any;
  error: { message: string; code?: string } | null;
}

function createFakeDb(seed: { tickets?: Row[]; ticket_events?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    tickets: (seed.tickets ?? []).map((row) => ({ ...row })),
    ticket_events: (seed.ticket_events ?? []).map((row) => ({ ...row })),
  };
  const updates: { table: string; values: Row }[] = [];
  const inserts: { table: string; values: Row }[] = [];
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
      const rows = tables[this.table] ?? [];
      return rows.filter((row) =>
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
        inserts.push({ table: this.table, values: row });
        return { data: [row], error: null };
      }

      if (this.mode === 'update') {
        const rows = this.matching();
        for (const row of rows) Object.assign(row, this.pending);
        for (const _row of rows) {
          updates.push({ table: this.table, values: this.pending as Row });
        }
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
    updates,
    inserts,
  };
}

const TENANT = 'tenant-a';

function ticket(overrides: Row = {}): Row {
  return {
    id: 'ticket-1',
    tenant_id: TENANT,
    status: 'todo',
    accepted_at: '2026-01-01T00:00:00.000Z',
    resolved_at: null,
    closed_at: null,
    priority: 'none',
    owner_id: null,
    agent_delegated: false,
    ...overrides,
  };
}

const actor = { type: 'user' as const, id: 'user-1' };

describe('ticket service transitions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('throws InvalidTransitionError and writes nothing for an illegal transition', async () => {
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
      transitionTicket('ticket-1', 'in_progress', actor, { client: db.client })
    ).rejects.toBeInstanceOf(InvalidTransitionError);

    expect(db.updates).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
    expect(db.tables.ticket_events).toHaveLength(0);
    expect(db.tables.tickets[0].status).toBe('resolved');
  });

  it('writes exactly one event with actor, from and to on success', async () => {
    const db = createFakeDb({ tickets: [ticket()] });

    await transitionTicket('ticket-1', 'in_progress', actor, {
      client: db.client,
      data: { reason: 'picked up' },
    });

    expect(db.tables.tickets[0].status).toBe('in_progress');
    const events = db.tables.ticket_events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenant_id: TENANT,
      ticket_id: 'ticket-1',
      kind: 'status_changed',
      actor_type: 'user',
      actor_id: 'user-1',
      from_value: 'todo',
      to_value: 'in_progress',
      data: { reason: 'picked up' },
    });
  });

  it('sets accepted_at when leaving triage for an active status', async () => {
    const db = createFakeDb({
      tickets: [ticket({ status: 'triage', accepted_at: null })],
    });

    await transitionTicket('ticket-1', 'todo', actor, { client: db.client });

    expect(db.tables.tickets[0].accepted_at).toBeTruthy();
    expect(db.tables.ticket_events[0]).toMatchObject({
      kind: 'accepted',
      from_value: 'triage',
      to_value: 'todo',
    });
  });

  it('sets resolved_at and closed_at on resolve', async () => {
    const db = createFakeDb({ tickets: [ticket({ status: 'in_progress' })] });

    await transitionTicket('ticket-1', 'resolved', actor, { client: db.client });

    expect(db.tables.tickets[0].resolved_at).toBeTruthy();
    expect(db.tables.tickets[0].closed_at).toBeTruthy();
  });

  it('sets closed_at only when canceled', async () => {
    const db = createFakeDb({ tickets: [ticket()] });

    await transitionTicket('ticket-1', 'canceled', actor, { client: db.client });

    expect(db.tables.tickets[0].closed_at).toBeTruthy();
    expect(db.tables.tickets[0].resolved_at).toBeNull();
  });

  it('clears resolved_at and closed_at and emits reopened on reopen', async () => {
    const db = createFakeDb({
      tickets: [
        ticket({
          status: 'resolved',
          resolved_at: '2026-01-02T00:00:00.000Z',
          closed_at: '2026-01-02T00:00:00.000Z',
        }),
      ],
    });

    await transitionTicket('ticket-1', 'todo', actor, { client: db.client });

    expect(db.tables.tickets[0].status).toBe('todo');
    expect(db.tables.tickets[0].resolved_at).toBeNull();
    expect(db.tables.tickets[0].closed_at).toBeNull();
    expect(db.tables.ticket_events).toHaveLength(1);
    expect(db.tables.ticket_events[0]).toMatchObject({
      kind: 'reopened',
      from_value: 'resolved',
      to_value: 'todo',
    });
  });

  it('throws TicketNotFoundError on tenant mismatch without writing', async () => {
    const db = createFakeDb({ tickets: [ticket()] });

    await expect(
      transitionTicket('ticket-1', 'in_progress', actor, {
        client: db.client,
        tenantId: 'tenant-b',
      })
    ).rejects.toBeInstanceOf(TicketNotFoundError);

    expect(db.updates).toHaveLength(0);
    expect(db.tables.ticket_events).toHaveLength(0);
  });

  it('throws TicketNotFoundError when the ticket does not exist', async () => {
    const db = createFakeDb();

    await expect(
      transitionTicket('missing', 'in_progress', actor, { client: db.client })
    ).rejects.toBeInstanceOf(TicketNotFoundError);
  });
});

describe('ticket service field setters', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('setPriority no-op writes no update and no event', async () => {
    const db = createFakeDb({ tickets: [ticket({ priority: 'high' })] });

    const result = await setPriority('ticket-1', 'high', actor, {
      client: db.client,
    });

    expect(result.priority).toBe('high');
    expect(db.updates).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });

  it('setPriority writes one priority_changed event when the value changes', async () => {
    const db = createFakeDb({ tickets: [ticket({ priority: 'low' })] });

    await setPriority('ticket-1', 'urgent', actor, { client: db.client });

    expect(db.tables.tickets[0].priority).toBe('urgent');
    expect(db.tables.ticket_events).toHaveLength(1);
    expect(db.tables.ticket_events[0]).toMatchObject({
      kind: 'priority_changed',
      from_value: 'low',
      to_value: 'urgent',
    });
  });

  it('setOwner writes owner_changed with null when clearing', async () => {
    const db = createFakeDb({ tickets: [ticket({ owner_id: 'user-2' })] });

    await setOwner('ticket-1', null, actor, { client: db.client });

    expect(db.tables.tickets[0].owner_id).toBeNull();
    expect(db.tables.ticket_events[0]).toMatchObject({
      kind: 'owner_changed',
      from_value: 'user-2',
      to_value: null,
    });
  });

  it('setAgentDelegated toggles kind and skips unchanged values', async () => {
    const db = createFakeDb({ tickets: [ticket()] });

    await setAgentDelegated('ticket-1', false, actor, { client: db.client });
    expect(db.tables.ticket_events).toHaveLength(0);

    await setAgentDelegated('ticket-1', true, actor, { client: db.client });
    expect(db.tables.ticket_events).toHaveLength(1);
    expect(db.tables.ticket_events[0]).toMatchObject({
      kind: 'agent_delegated',
      from_value: 'false',
      to_value: 'true',
    });
  });
});

describe('ticket event listeners', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('notifies listeners and survives a throwing listener', async () => {
    const db = createFakeDb({ tickets: [ticket()] });
    const received: TicketEvent[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const offGood = onTicketEvent((event) => received.push(event));
    const offBad = onTicketEvent(() => {
      throw new Error('listener exploded');
    });

    try {
      await transitionTicket('ticket-1', 'in_progress', actor, {
        client: db.client,
      });
    } finally {
      offGood();
      offBad();
    }

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      kind: 'status_changed',
      from_value: 'todo',
      to_value: 'in_progress',
    });
    expect(db.tables.ticket_events).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', async () => {
    const db = createFakeDb({ tickets: [ticket()] });
    const received: TicketEvent[] = [];
    const off = onTicketEvent((event) => received.push(event));

    off();
    await transitionTicket('ticket-1', 'in_progress', actor, {
      client: db.client,
    });

    expect(received).toHaveLength(0);
  });
});
