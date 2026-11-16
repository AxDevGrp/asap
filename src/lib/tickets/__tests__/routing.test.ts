import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  decideRoute,
  REOPEN_WINDOW_MS,
  routeInbound,
  type RoutingTicket,
} from '../routing';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

interface FakeResult {
  data: any;
  error: { message: string; code?: string } | null;
}

function createFakeDb(seed: { tickets?: Row[]; conversations?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    tickets: (seed.tickets ?? []).map((row) => ({ ...row })),
    conversations: (seed.conversations ?? []).map((row) => ({ ...row })),
    ticket_events: [],
  };
  let seq = 0;

  class Query {
    private mode: 'read' | 'insert' | 'update' = 'read';
    private pending: Row | null = null;
    private filters: [string, unknown][] = [];
    private orderBy: { column: string; ascending: boolean } | null = null;
    private max: number | null = null;

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

    order(column: string, opts?: { ascending?: boolean }) {
      this.orderBy = { column, ascending: opts?.ascending !== false };
      return this;
    }

    limit(n: number) {
      this.max = n;
      return this;
    }

    private matching(): Row[] {
      const rows = (tables[this.table] ?? []).filter((row) =>
        this.filters.every(([column, value]) => row[column] === value)
      );
      if (this.orderBy) {
        const { column, ascending } = this.orderBy;
        rows.sort((a, b) => {
          const av = a[column] ?? '';
          const bv = b[column] ?? '';
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
        });
      }
      return this.max === null ? rows : rows.slice(0, this.max);
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
const CONV = 'conv-1';
const NOW = new Date('2026-06-01T00:00:00.000Z');

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function ticket(overrides: Row = {}): Row {
  return {
    id: 'ticket-1',
    tenant_id: TENANT,
    conversation_id: CONV,
    status: 'todo',
    duplicate_of: null,
    snoozed_until: null,
    snooze_until_reply: false,
    resolved_at: null,
    closed_at: null,
    updated_at: daysAgo(1),
    created_at: daysAgo(1),
    ...overrides,
  };
}

function routeTicket(overrides: Partial<RoutingTicket> = {}): RoutingTicket {
  return { id: 'ticket-1', status: 'todo', ...overrides } as RoutingTicket;
}

describe('decideRoute', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('routes a brand new email to a new ticket', () => {
    expect(
      decideRoute({ ticket: null, conversationStatus: 'open', now: NOW })
    ).toEqual({ action: 'new_ticket' });
  });

  it('appends to a triage ticket with no effects', () => {
    expect(
      decideRoute({ ticket: routeTicket({ status: 'triage' }), conversationStatus: 'open', now: NOW })
    ).toEqual({ action: 'append', ticketId: 'ticket-1', effects: [] });
  });

  it.each(['todo', 'in_progress', 'waiting_on_approval'] as const)(
    'appends to an active %s ticket with no effects',
    (status) => {
      expect(
        decideRoute({ ticket: routeTicket({ status }), conversationStatus: 'open', now: NOW })
      ).toEqual({ action: 'append', ticketId: 'ticket-1', effects: [] });
    }
  );

  it('moves waiting_on_customer back to todo', () => {
    expect(
      decideRoute({
        ticket: routeTicket({ status: 'waiting_on_customer' }),
        conversationStatus: 'open',
        now: NOW,
      })
    ).toEqual({
      action: 'append',
      ticketId: 'ticket-1',
      effects: ['move_to_todo'],
    });
  });

  it('unsnoozes a ticket waiting on a reply', () => {
    expect(
      decideRoute({
        ticket: routeTicket({ status: 'todo', snooze_until_reply: true }),
        conversationStatus: 'open',
        now: NOW,
      })
    ).toEqual({
      action: 'append',
      ticketId: 'ticket-1',
      effects: ['unsnooze'],
    });
  });

  it('unsnoozes when snoozed_until is set', () => {
    expect(
      decideRoute({
        ticket: routeTicket({ status: 'todo', snoozed_until: daysAgo(0) }),
        conversationStatus: 'open',
        now: NOW,
      })
    ).toEqual({
      action: 'append',
      ticketId: 'ticket-1',
      effects: ['unsnooze'],
    });
  });

  it('reopens a ticket resolved 3 days ago', () => {
    expect(
      decideRoute({
        ticket: routeTicket({ status: 'resolved', resolved_at: daysAgo(3) }),
        conversationStatus: 'open',
        now: NOW,
      })
    ).toEqual({ action: 'append', ticketId: 'ticket-1', effects: ['reopen'] });
  });

  it('reopens exactly at the 7 day boundary', () => {
    expect(
      decideRoute({
        ticket: routeTicket({ status: 'resolved', resolved_at: daysAgo(7) }),
        conversationStatus: 'open',
        now: NOW,
      })
    ).toEqual({ action: 'append', ticketId: 'ticket-1', effects: ['reopen'] });
    expect(REOPEN_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('starts a new ticket when the last one was resolved 10 days ago', () => {
    expect(
      decideRoute({
        ticket: routeTicket({ status: 'resolved', resolved_at: daysAgo(10) }),
        conversationStatus: 'open',
        now: NOW,
      })
    ).toEqual({ action: 'new_ticket' });
  });

  it('starts a new ticket when the last one was canceled', () => {
    expect(
      decideRoute({
        ticket: routeTicket({ status: 'canceled' }),
        conversationStatus: 'open',
        now: NOW,
      })
    ).toEqual({ action: 'new_ticket' });
  });

  it('starts a new ticket for a duplicate with no canonical', () => {
    expect(
      decideRoute({
        ticket: routeTicket({ status: 'duplicate' }),
        conversationStatus: 'open',
        now: NOW,
      })
    ).toEqual({ action: 'new_ticket' });
  });

  it('drops email on a spam conversation', () => {
    expect(
      decideRoute({ ticket: null, conversationStatus: 'spam', now: NOW })
    ).toEqual({ action: 'drop', reason: 'spam' });
    expect(
      decideRoute({
        ticket: routeTicket({ status: 'todo' }),
        conversationStatus: 'spam',
        now: NOW,
      })
    ).toEqual({ action: 'drop', reason: 'spam' });
  });
});

describe('routeInbound', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('follows duplicate_of to the canonical ticket', async () => {
    const db = createFakeDb({
      conversations: [{ id: CONV, tenant_id: TENANT, status: 'open' }],
      tickets: [
        ticket({
          id: 'canonical-1',
          status: 'todo',
          created_at: daysAgo(10),
        }),
        ticket({
          id: 'dup-1',
          status: 'duplicate',
          duplicate_of: 'canonical-1',
          created_at: daysAgo(1),
        }),
      ],
    });

    const decision = await routeInbound(
      { tenantId: TENANT, conversationId: CONV, receivedAt: NOW },
      { client: db.client }
    );

    expect(decision).toEqual({
      action: 'append',
      ticketId: 'canonical-1',
      effects: [],
    });
    expect(db.tables.ticket_events).toHaveLength(0);
  });

  it('applies move_to_todo through the transition service', async () => {
    const db = createFakeDb({
      conversations: [{ id: CONV, tenant_id: TENANT, status: 'open' }],
      tickets: [ticket({ status: 'waiting_on_customer' })],
    });

    const decision = await routeInbound(
      { tenantId: TENANT, conversationId: CONV, receivedAt: NOW },
      { client: db.client }
    );

    expect(decision).toEqual({
      action: 'append',
      ticketId: 'ticket-1',
      effects: ['move_to_todo'],
    });
    expect(db.tables.tickets[0].status).toBe('todo');
    expect(db.tables.ticket_events).toHaveLength(1);
    expect(db.tables.ticket_events[0]).toMatchObject({
      ticket_id: 'ticket-1',
      kind: 'status_changed',
      actor_type: 'system',
      from_value: 'waiting_on_customer',
      to_value: 'todo',
    });
  });

  it('clears snooze fields and writes an unsnoozed event', async () => {
    const db = createFakeDb({
      conversations: [{ id: CONV, tenant_id: TENANT, status: 'open' }],
      tickets: [
        ticket({
          snoozed_until: '2026-06-05T00:00:00.000Z',
          snooze_until_reply: true,
        }),
      ],
    });

    const decision = await routeInbound(
      { tenantId: TENANT, conversationId: CONV, receivedAt: NOW },
      { client: db.client }
    );

    expect(decision).toEqual({
      action: 'append',
      ticketId: 'ticket-1',
      effects: ['unsnooze'],
    });
    expect(db.tables.tickets[0].snoozed_until).toBeNull();
    expect(db.tables.tickets[0].snooze_until_reply).toBe(false);
    expect(db.tables.ticket_events).toHaveLength(1);
    expect(db.tables.ticket_events[0]).toMatchObject({
      ticket_id: 'ticket-1',
      kind: 'unsnoozed',
      actor_type: 'system',
    });
  });

  it('reopens a recently resolved ticket and writes a reopened event', async () => {
    const db = createFakeDb({
      conversations: [{ id: CONV, tenant_id: TENANT, status: 'open' }],
      tickets: [
        ticket({
          status: 'resolved',
          resolved_at: daysAgo(3),
          closed_at: daysAgo(3),
        }),
      ],
    });

    const decision = await routeInbound(
      { tenantId: TENANT, conversationId: CONV, receivedAt: NOW },
      { client: db.client }
    );

    expect(decision).toEqual({
      action: 'append',
      ticketId: 'ticket-1',
      effects: ['reopen'],
    });
    expect(db.tables.tickets[0].status).toBe('todo');
    expect(db.tables.ticket_events).toHaveLength(1);
    expect(db.tables.ticket_events[0]).toMatchObject({
      kind: 'reopened',
      actor_type: 'system',
      from_value: 'resolved',
      to_value: 'todo',
    });
  });

  it('drops spam without writing anything', async () => {
    const db = createFakeDb({
      conversations: [{ id: CONV, tenant_id: TENANT, status: 'spam' }],
      tickets: [ticket()],
    });

    const decision = await routeInbound(
      { tenantId: TENANT, conversationId: CONV, receivedAt: NOW },
      { client: db.client }
    );

    expect(decision).toEqual({ action: 'drop', reason: 'spam' });
    expect(db.tables.ticket_events).toHaveLength(0);
    expect(db.tables.tickets[0].status).toBe('todo');
  });

  it('is retry-safe when the ticket already moved', async () => {
    const db = createFakeDb({
      conversations: [{ id: CONV, tenant_id: TENANT, status: 'open' }],
      tickets: [ticket({ status: 'waiting_on_customer' })],
    });

    await routeInbound(
      { tenantId: TENANT, conversationId: CONV, receivedAt: NOW },
      { client: db.client }
    );
    // Force a stale decision by re-running against an already moved ticket.
    const again = await routeInbound(
      { tenantId: TENANT, conversationId: CONV, receivedAt: NOW },
      { client: db.client }
    );

    expect(again).toEqual({
      action: 'append',
      ticketId: 'ticket-1',
      effects: [],
    });
    expect(db.tables.tickets[0].status).toBe('todo');
    expect(db.tables.ticket_events).toHaveLength(1);
  });
});
