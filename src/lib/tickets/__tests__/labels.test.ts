import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  addLabel,
  createLabel,
  DuplicateLabelError,
  LabelNotFoundError,
  removeLabel,
} from '../labels';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

interface FakeResult {
  data: any;
  error: { message: string; code?: string } | null;
}

interface FakeSeed {
  tickets?: Row[];
  labels?: Row[];
  ticket_labels?: Row[];
  ticket_events?: Row[];
}

function createFakeDb(seed: FakeSeed = {}) {
  const tables: Record<string, Row[]> = {
    tickets: (seed.tickets ?? []).map((row) => ({ ...row })),
    labels: (seed.labels ?? []).map((row) => ({ ...row })),
    ticket_labels: (seed.ticket_labels ?? []).map((row) => ({ ...row })),
    ticket_events: (seed.ticket_events ?? []).map((row) => ({ ...row })),
  };
  const inserts: { table: string; values: Row }[] = [];
  const updates: { table: string; values: Row }[] = [];
  const deletes: { table: string }[] = [];
  let seq = 0;

  class Query {
    private mode: 'read' | 'insert' | 'update' | 'delete' = 'read';
    private pending: Row | null = null;
    private filters: [string, unknown][] = [];

    constructor(private readonly table: string) {}

    select(_columns?: string) {
      return this;
    }

    order(_column: string, _opts?: unknown) {
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

    delete() {
      this.mode = 'delete';
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
        const row: Row = {
          id: `row-${++seq}`,
          created_at: new Date().toISOString(),
          ...this.pending,
        };

        if (this.table === 'labels') {
          const duplicate = (tables.labels ?? []).some(
            (existing) =>
              existing.tenant_id === row.tenant_id &&
              String(existing.name).toLowerCase() === String(row.name).toLowerCase()
          );
          if (duplicate) {
            return {
              data: null,
              error: {
                message: 'duplicate key value violates unique constraint',
                code: '23505',
              },
            };
          }
        }

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

      if (this.mode === 'delete') {
        const rows = this.matching();
        tables[this.table] = (tables[this.table] ?? []).filter(
          (row) => !rows.includes(row)
        );
        deletes.push({ table: this.table });
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
    inserts,
    updates,
    deletes,
  };
}

const TENANT = 'tenant-a';
const actor = { type: 'user' as const, id: 'user-1' };

function ticket(overrides: Row = {}): Row {
  return { id: 'ticket-1', tenant_id: TENANT, ...overrides };
}

function label(overrides: Row = {}): Row {
  return {
    id: 'label-1',
    tenant_id: TENANT,
    name: 'bug',
    color: '#ef4444',
    description: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('label definitions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('createLabel trims the name and returns the created label', async () => {
    const db = createFakeDb();

    const created = await createLabel(
      TENANT,
      { name: '  Bug  ', color: '#ff0000' },
      { client: db.client }
    );

    expect(created).toMatchObject({ tenant_id: TENANT, name: 'Bug', color: '#ff0000' });
    expect(db.tables.labels).toHaveLength(1);
    expect(db.tables.labels[0].name).toBe('Bug');
  });

  it('createLabel maps a 23505 to DuplicateLabelError (case-insensitive)', async () => {
    const db = createFakeDb({ labels: [label()] });

    await expect(
      createLabel(TENANT, { name: ' BUG ' }, { client: db.client })
    ).rejects.toBeInstanceOf(DuplicateLabelError);

    expect(db.tables.labels).toHaveLength(1);
  });
});

describe('ticket labels', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('addLabel writes the association and exactly one label_added event', async () => {
    const db = createFakeDb({ tickets: [ticket()], labels: [label()] });

    const added = await addLabel('ticket-1', 'label-1', actor, {
      client: db.client,
    });

    expect(added.name).toBe('bug');
    expect(db.tables.ticket_labels).toHaveLength(1);
    expect(db.tables.ticket_labels[0]).toMatchObject({
      ticket_id: 'ticket-1',
      label_id: 'label-1',
      added_by_type: 'user',
      added_by_id: 'user-1',
    });

    const events = db.tables.ticket_events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenant_id: TENANT,
      ticket_id: 'ticket-1',
      kind: 'label_added',
      actor_type: 'user',
      actor_id: 'user-1',
      from_value: null,
      to_value: 'bug',
      data: { label_id: 'label-1' },
    });
  });

  it('adding an existing label is a no-op with no event', async () => {
    const db = createFakeDb({
      tickets: [ticket()],
      labels: [label()],
      ticket_labels: [{ ticket_id: 'ticket-1', label_id: 'label-1' }],
    });

    await addLabel('ticket-1', 'label-1', actor, { client: db.client });

    expect(db.tables.ticket_labels).toHaveLength(1);
    expect(db.tables.ticket_events).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });

  it('addLabel rejects a label from another tenant without writing', async () => {
    const db = createFakeDb({
      tickets: [ticket()],
      labels: [label({ tenant_id: 'tenant-b' })],
    });

    await expect(
      addLabel('ticket-1', 'label-1', actor, { client: db.client })
    ).rejects.toBeInstanceOf(LabelNotFoundError);

    expect(db.tables.ticket_labels).toHaveLength(0);
    expect(db.tables.ticket_events).toHaveLength(0);
  });

  it('removeLabel deletes the association and writes label_removed', async () => {
    const db = createFakeDb({
      tickets: [ticket()],
      labels: [label()],
      ticket_labels: [{ ticket_id: 'ticket-1', label_id: 'label-1' }],
    });

    await removeLabel('ticket-1', 'label-1', actor, { client: db.client });

    expect(db.tables.ticket_labels).toHaveLength(0);
    expect(db.tables.ticket_events).toHaveLength(1);
    expect(db.tables.ticket_events[0]).toMatchObject({
      kind: 'label_removed',
      from_value: 'bug',
      to_value: null,
      data: { label_id: 'label-1' },
    });
    expect(db.deletes).toHaveLength(1);
  });

  it('removing an absent label is a no-op with no event', async () => {
    const db = createFakeDb({ tickets: [ticket()], labels: [label()] });

    await removeLabel('ticket-1', 'label-1', actor, { client: db.client });

    expect(db.deletes).toHaveLength(0);
    expect(db.tables.ticket_events).toHaveLength(0);
  });
});
