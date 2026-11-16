import { describe, expect, it } from 'vitest';
import type { TicketStatus } from '@/lib/db';
import {
  ACTIVE_STATUSES,
  ALLOWED_TRANSITIONS,
  categoryOf,
  canTransition,
  CLOSED_STATUSES,
  isTicketStatus,
  STATUS_CATEGORY,
  TICKET_STATUSES,
} from '../status';

const EXPECTED_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  triage: ['todo', 'in_progress', 'canceled', 'duplicate', 'resolved'],
  todo: [
    'in_progress',
    'waiting_on_customer',
    'waiting_on_approval',
    'resolved',
    'canceled',
    'duplicate',
    'triage',
  ],
  in_progress: [
    'todo',
    'waiting_on_customer',
    'waiting_on_approval',
    'resolved',
    'canceled',
    'duplicate',
  ],
  waiting_on_customer: ['todo', 'in_progress', 'resolved', 'canceled'],
  waiting_on_approval: ['in_progress', 'todo', 'resolved', 'canceled'],
  resolved: ['todo'],
  canceled: ['todo'],
  duplicate: ['todo'],
};

const ALL_STATUSES: TicketStatus[] = [
  'triage',
  'todo',
  'in_progress',
  'waiting_on_customer',
  'waiting_on_approval',
  'resolved',
  'canceled',
  'duplicate',
];

describe('ticket status model', () => {
  it('exports exactly the fixed status set', () => {
    expect([...TICKET_STATUSES]).toEqual(ALL_STATUSES);
  });

  it('asserts every allowed pair and rejects every other pair, including self', () => {
    for (const from of ALL_STATUSES) {
      const allowed = new Set(EXPECTED_TRANSITIONS[from]);
      for (const to of ALL_STATUSES) {
        const expected = from !== to && allowed.has(to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('matches ALLOWED_TRANSITIONS exactly', () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual(
      [...ALL_STATUSES].sort()
    );
    for (const from of ALL_STATUSES) {
      expect(ALLOWED_TRANSITIONS[from], `from ${from}`).toEqual(
        EXPECTED_TRANSITIONS[from]
      );
    }
  });

  it('maps each status to its category', () => {
    expect(STATUS_CATEGORY).toEqual({
      triage: 'triage',
      todo: 'active',
      in_progress: 'active',
      waiting_on_customer: 'active',
      waiting_on_approval: 'active',
      resolved: 'closed',
      canceled: 'closed',
      duplicate: 'closed',
    });

    for (const status of ALL_STATUSES) {
      expect(categoryOf(status)).toBe(STATUS_CATEGORY[status]);
    }
  });

  it('derives active and closed status lists from the categories', () => {
    expect([...ACTIVE_STATUSES].sort()).toEqual(
      ALL_STATUSES.filter((s) => STATUS_CATEGORY[s] === 'active').sort()
    );
    expect([...CLOSED_STATUSES].sort()).toEqual(
      ALL_STATUSES.filter((s) => STATUS_CATEGORY[s] === 'closed').sort()
    );
    expect([...ACTIVE_STATUSES]).not.toContain('triage');
    expect([...CLOSED_STATUSES]).not.toContain('todo');
  });

  it('recognises only known status strings', () => {
    for (const status of ALL_STATUSES) {
      expect(isTicketStatus(status)).toBe(true);
    }
    expect(isTicketStatus('open')).toBe(false);
    expect(isTicketStatus('')).toBe(false);
    expect(isTicketStatus(undefined)).toBe(false);
    expect(isTicketStatus(null)).toBe(false);
    expect(isTicketStatus(42)).toBe(false);
  });
});
