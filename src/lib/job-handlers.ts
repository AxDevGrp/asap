// Job type registry — maps a job's `type` to its handler.
// Handlers throw on failure; the runner records the error and retries with
// backoff (or marks the job dead once attempts are exhausted).

import { getTenantById } from './tenant';
import { processInboundEmail } from './pipeline';

export const JOB_TYPE_INBOUND_EMAIL_PROCESS = 'inbound_email.process' as const;

export type JobType =
  | typeof JOB_TYPE_INBOUND_EMAIL_PROCESS
  | (string & {});

export interface InboundEmailProcessPayload {
  tenantId: string;
  ticketId: string;
  conversationId: string;
  contactEmail: string;
  contactName?: string | null;
  subject: string;
  body: string;
  isFollowUp?: boolean;
}

export interface Job {
  id: string;
  tenant_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export type JobHandler = (job: Job) => Promise<void>;

async function handleInboundEmailProcess(job: Job): Promise<void> {
  const p = job.payload as unknown as InboundEmailProcessPayload;

  const tenant = await getTenantById(p.tenantId);
  if (!tenant) {
    throw new Error(`Tenant ${p.tenantId} not found for inbound_email.process`);
  }

  await processInboundEmail({
    tenant,
    ticketId: p.ticketId,
    conversationId: p.conversationId,
    contactEmail: p.contactEmail,
    contactName: p.contactName ?? null,
    subject: p.subject,
    body: p.body,
    isFollowUp: p.isFollowUp ?? false,
    idempotencyKey: `job:${job.id}`,
  });
}

export const jobHandlers: Record<string, JobHandler> = {
  [JOB_TYPE_INBOUND_EMAIL_PROCESS]: handleInboundEmailProcess,
};
