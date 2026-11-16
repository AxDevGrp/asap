import { describe, expect, it } from 'vitest';
import {
  buildKeysetOr,
  buildSearchOr,
  buildTicketFilters,
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  parseTicketKey,
  SORT_COLUMNS,
  ticketListQuerySchema,
} from '../query';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' };

function parse(query: string) {
  return ticketListQuerySchema.safeParse(new URLSearchParams(query));
}

function filtersFor(query: string) {
  const parsed = parse(query);
  if (!parsed.success) throw new Error('expected valid params');
  return buildTicketFilters(parsed.data, ctx);
}

describe('ticketListQuerySchema', () => {
  it('parses repeated and comma-separated multi values', () => {
    const parsed = parse(
      'status=triage,todo&status=in_progress&priority=high,urgent&label=bug&label=billing'
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.statuses).toEqual([
      'triage',
      'todo',
      'in_progress',
    ]);
    expect(parsed.data.priorities).toEqual(['high', 'urgent']);
    expect(parsed.data.labels).toEqual(['bug', 'billing']);
  });

  it('rejects an invalid status', () => {
    const parsed = parse('status=not_a_status');
    expect(parsed.success).toBe(false);
  });

  it('defaults sort to updated and limit to 50', () => {
    const parsed = parse('');
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.sort).toBe('updated');
    expect(parsed.data.limit).toBe(50);
  });

  it('enforces limit bounds', () => {
    expect(parse('limit=0').success).toBe(false);
    expect(parse('limit=101').success).toBe(false);
    expect(parse('limit=abc').success).toBe(false);
    expect(parse('limit=100').success).toBe(true);
    expect(parse('limit=1').success).toBe(true);
  });

  it('enforces q length bounds', () => {
    expect(parse('q=').success).toBe(false);
    expect(parse(`q=${'a'.repeat(201)}`).success).toBe(false);
    expect(parse(`q=${'a'.repeat(200)}`).success).toBe(true);
  });

  it('parses boolean agent and rejects other values', () => {
    expect(parse('agent=true').success).toBe(true);
    expect(parse('agent=false').success).toBe(true);
    expect(parse('agent=maybe').success).toBe(false);
  });
});

describe('buildTicketFilters', () => {
  it('expands category to its statuses', () => {
    expect(filtersFor('category=active').statuses).toEqual([
      'todo',
      'in_progress',
      'waiting_on_customer',
      'waiting_on_approval',
    ]);
    expect(filtersFor('category=triage').statuses).toEqual(['triage']);
    expect(filtersFor('category=closed').statuses).toEqual([
      'resolved',
      'canceled',
      'duplicate',
    ]);
  });

  it('intersects category and status', () => {
    expect(
      filtersFor('category=closed&status=todo,resolved').statuses
    ).toEqual(['resolved']);
    expect(
      filtersFor('category=triage&status=todo').statuses
    ).toEqual([]);
  });

  it('dedupes and combines multiple categories', () => {
    expect(filtersFor('category=triage,active&status=todo,triage').statuses).toEqual([
      'todo',
      'triage',
    ]);
  });

  it('maps owner me, unassigned and uuid', () => {
    expect(filtersFor('owner=me').owner).toEqual({
      kind: 'id',
      id: 'user-1',
    });
    expect(filtersFor('owner=unassigned').owner).toEqual({
      kind: 'unassigned',
    });
    const id = '00000000-0000-4000-8000-000000000001';
    expect(filtersFor(`owner=${id}`).owner).toEqual({ kind: 'id', id });
  });

  it('rejects an owner that is neither me, unassigned nor a uuid', () => {
    expect(parse('owner=someone').success).toBe(false);
  });

  it('maps priorities, agent and q', () => {
    const filters = filtersFor('priority=low,urgent&agent=false&q=refund');
    expect(filters.priorities).toEqual(['low', 'urgent']);
    expect(filters.agentDelegated).toBe(false);
    expect(filters.q).toBe('refund');
  });

  it('splits label uuids from names', () => {
    const id = '00000000-0000-4000-8000-000000000002';
    const filters = filtersFor(`label=${id},Bug&label=billing`);
    expect(filters.labelIds).toEqual([id]);
    expect(filters.labelNames).toEqual(['Bug', 'billing']);
  });

  it('maps every sort key to its column, descending', () => {
    expect(filtersFor('sort=created').sort).toEqual({
      key: 'created',
      column: 'created_at',
      ascending: false,
    });
    expect(filtersFor('sort=updated').sort.column).toBe('updated_at');
    expect(filtersFor('sort=priority').sort.column).toBe('priority_rank');
    expect(filtersFor('sort=number').sort.column).toBe('number');
    expect(SORT_COLUMNS).toEqual({
      created: 'created_at',
      updated: 'updated_at',
      priority: 'priority_rank',
      number: 'number',
    });
  });

  it('decodes a cursor that matches the sort', () => {
    const cursor = encodeCursor('priority', 3, 'ticket-9');
    expect(filtersFor(`sort=priority&cursor=${cursor}`).cursor).toEqual({
      s: 'priority',
      v: 3,
      id: 'ticket-9',
    });
  });
});

describe('cursor encoding', () => {
  it('round-trips through encode/decode', () => {
    const encoded = encodeCursor('updated', '2026-01-01T00:00:00.000Z', 't-1');
    expect(encoded).not.toMatch(/[+/=]/);
    expect(decodeCursor(encoded, 'updated')).toEqual({
      s: 'updated',
      v: '2026-01-01T00:00:00.000Z',
      id: 't-1',
    });
  });

  it('rejects a cursor from a different sort', () => {
    const encoded = encodeCursor('created', '2026-01-01T00:00:00.000Z', 't-1');
    expect(() => decodeCursor(encoded, 'updated')).toThrow(InvalidCursorError);
  });

  it('rejects malformed cursors', () => {
    expect(() => decodeCursor('not-base64-json', 'updated')).toThrow(
      InvalidCursorError
    );
  });

  it('rejects a mismatched value type', () => {
    const encoded = encodeCursor('created', '2026-01-01T00:00:00.000Z', 't-1');
    // Sort matches but priority cursors expect a number.
    expect(() => decodeCursor(encoded, 'created')).not.toThrow();
    const wrongType = Buffer.from(
      JSON.stringify({ s: 'priority', v: 'high', id: 't-1' })
    ).toString('base64url');
    expect(() => decodeCursor(wrongType, 'priority')).toThrow(
      InvalidCursorError
    );
  });
});

describe('search escaping', () => {
  it('escapes LIKE wildcards and wraps the value in quotes', () => {
    expect(buildSearchOr('50% off_')).toContain('subject.ilike."%50\\% off\\_%"');
    expect(buildSearchOr('50% off_')).toContain('body.ilike."%50\\% off\\_%"');
    expect(buildSearchOr('50% off_')).toContain('title.ilike."%50\\% off\\_%"');
  });

  it('escapes backslashes', () => {
    expect(buildSearchOr('a\\b')).toContain('"%a\\\\b%"');
  });

  it('double-quotes PostgREST specials instead of splitting the filter', () => {
    expect(buildSearchOr('a,b(c)*')).toContain('"%a,b(c)*%"');
  });

  it('escapes quotes in the value', () => {
    expect(buildSearchOr('say "hi"')).toContain('\\"hi\\"');
  });
});

describe('keyset filter', () => {
  it('builds a descending keyset with an id tiebreaker', () => {
    expect(buildKeysetOr('updated_at', '2026-01-01T00:00:00.000Z', 't-1')).toBe(
      'updated_at.lt."2026-01-01T00:00:00.000Z",and(updated_at.eq."2026-01-01T00:00:00.000Z",id.lt."t-1")'
    );
  });

  it('quotes numeric values', () => {
    expect(buildKeysetOr('priority_rank', 3, 't-1')).toContain(
      'priority_rank.lt."3"'
    );
  });
});

describe('parseTicketKey', () => {
  it('parses a valid key case-insensitively', () => {
    expect(parseTicketKey('GOA-123')).toEqual({ prefix: 'GOA', number: 123 });
    expect(parseTicketKey('goa-7')).toEqual({ prefix: 'GOA', number: 7 });
  });

  it('rejects invalid keys', () => {
    expect(parseTicketKey('GOA')).toBeNull();
    expect(parseTicketKey('GOA-0')).toBeNull();
    expect(parseTicketKey('GOA-abc')).toBeNull();
    expect(parseTicketKey('TOOLONG-1')).toBeNull();
    expect(parseTicketKey('GOA-1x')).toBeNull();
    expect(parseTicketKey('')).toBeNull();
  });
});
