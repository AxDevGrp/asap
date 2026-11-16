import type { TicketStatus } from '@/lib/db';

export type { TicketStatus };

export const TICKET_STATUSES = [
  'triage',
  'todo',
  'in_progress',
  'waiting_on_customer',
  'waiting_on_approval',
  'resolved',
  'canceled',
  'duplicate',
] as const satisfies readonly TicketStatus[];

export type TicketCategory = 'triage' | 'active' | 'closed';

export const STATUS_CATEGORY: Record<TicketStatus, TicketCategory> = {
  triage: 'triage',
  todo: 'active',
  in_progress: 'active',
  waiting_on_customer: 'active',
  waiting_on_approval: 'active',
  resolved: 'closed',
  canceled: 'closed',
  duplicate: 'closed',
};

export function categoryOf(status: TicketStatus): TicketCategory {
  return STATUS_CATEGORY[status];
}

export const ACTIVE_STATUSES: readonly TicketStatus[] = [
  'todo',
  'in_progress',
  'waiting_on_customer',
  'waiting_on_approval',
];

export const CLOSED_STATUSES: readonly TicketStatus[] = [
  'resolved',
  'canceled',
  'duplicate',
];

export const ALLOWED_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
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

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  if (from === to) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTicketStatus(value: unknown): value is TicketStatus {
  return (
    typeof value === 'string' &&
    (TICKET_STATUSES as readonly string[]).includes(value)
  );
}
