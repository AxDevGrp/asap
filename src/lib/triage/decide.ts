// Typed triage decisions (ASAP-9): question/state builders over the shared
// decide() client. The pipeline calls decideTriage() in shadow and jev modes;
// suggestions are stored, never applied automatically.

import {
  choice,
  decide,
  noul,
  score,
  truncateForState,
  type Answer,
  type ChoiceAnswer,
  type NoulAnswer,
  type Question,
  type ScoreAnswer,
} from '@/lib/decisions';
import type { TriageResult } from '@/types/triage';

export const TRIAGE_TYPES = [
  'bug',
  'feature_request',
  'question',
  'billing',
  'account',
  'other',
] as const;
export type TriageType = (typeof TRIAGE_TYPES)[number];

export const PRIORITY_LEVELS = ['low', 'medium', 'high', 'urgent'] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

export const MAX_LABEL_QUESTIONS = 12;

export interface TriageLabel {
  id: string;
  name: string;
  description?: string | null;
}

const TYPE_GUIDANCE: Record<TriageType, string> = {
  bug: 'something is broken or not working as expected',
  feature_request: 'asks for new functionality or an improvement',
  question: 'asks how something works or needs information',
  billing: 'payments, invoices, refunds or subscription charges',
  account: 'login, access, settings or account changes',
  other: 'none of the above',
};

const PRIORITY_GUIDANCE =
  'low = general question or no impact; medium = normal issue; high = blocked or significant impact; urgent = outage, security, money loss or a legal deadline';

export interface TriageQuestions {
  questions: Record<string, Question>;
  labelKeys: Record<string, string>;
}

/** Build the typed decision questions for a ticket. Labels are sorted by name and capped. */
export function buildTriageQuestions(
  tenantLabels: TriageLabel[],
  contactTier?: string
): TriageQuestions {
  const tierLine = contactTier ? ` Contact tier: ${contactTier}.` : '';
  const typeCriteria = Object.fromEntries(
    TRIAGE_TYPES.map((t) => [t, TYPE_GUIDANCE[t]])
  ) as Record<TriageType, string>;

  const questions: Record<string, Question> = {
    type: choice(typeCriteria, 'Pick the single best category for the request.'),
    priority: score(PRIORITY_LEVELS, `${PRIORITY_GUIDANCE}.${tierLine}`),
    is_spam: noul(
      'Is this unsolicited marketing, phishing, automated junk, or otherwise not a real support request?'
    ),
    needs_human: noul(
      'Does fulfilling this request require a money movement, legal/safety issue, or account change?'
    ),
  };

  const labelKeys: Record<string, string> = {};
  const labels = [...tenantLabels]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_LABEL_QUESTIONS);

  labels.forEach((label, index) => {
    const key = `label_${index}`;
    const description = label.description ? ` ${label.description}` : '';
    questions[key] = noul(`Does the label "${label.name}" apply?${description}`);
    labelKeys[key] = label.id;
  });

  return { questions, labelKeys };
}

/** Build the ticket state sent to the decision engine. The body is cut to 8 KB. */
export function buildTriageState(
  ticket: { subject: string; body: string; contactEmail?: string },
  contactTier?: string
): string {
  const lines = [`Subject: ${ticket.subject}`];
  if (contactTier) lines.push(`Contact tier: ${contactTier}`);
  lines.push('', truncateForState(ticket.body));
  return lines.join('\n');
}

/** Map a 0..3 score level to a priority. */
export function priorityFromIndex(index: number): PriorityLevel {
  const i = Math.min(Math.max(Math.round(index), 0), PRIORITY_LEVELS.length - 1);
  return PRIORITY_LEVELS[i];
}

/** Triage urgency for a priority: urgent maps to critical, everything else is unchanged. */
export function priorityToUrgency(priority: PriorityLevel): TriageResult['urgency'] {
  return priority === 'urgent' ? 'critical' : priority;
}

export interface TriageDecision {
  type: TriageType;
  priority: PriorityLevel;
  priorityIndex: number;
  spamProbability: number;
  needsHumanProbability: number;
  suggestedLabelIds: string[];
  confidence: number | null;
  engine: 'jev' | 'llm';
  model: string;
  cost: number;
}

export interface DecideTriageOptions {
  tenantId: string;
  ticketId: string;
  engine?: 'jev' | 'llm';
  labelThreshold: number;
  /** Test seam; defaults to the shared decide(). */
  decideImpl?: typeof decide;
}

type TriageAnswers = {
  type: ChoiceAnswer;
  priority: ScoreAnswer;
  is_spam: NoulAnswer;
  needs_human: NoulAnswer;
} & Record<string, Answer>;

export async function decideTriage(
  ticket: { subject: string; body: string; contactEmail?: string },
  tenantLabels: TriageLabel[],
  contactTier: string | undefined,
  opts: DecideTriageOptions
): Promise<TriageDecision> {
  const { questions, labelKeys } = buildTriageQuestions(tenantLabels, contactTier);
  const state = buildTriageState(ticket, contactTier);
  const decideImpl = opts.decideImpl ?? decide;

  const result = await decideImpl(state, questions, {
    tenantId: opts.tenantId,
    ticketId: opts.ticketId,
    purpose: 'triage',
    ...(opts.engine ? { engine: opts.engine } : {}),
  });

  const answers = result.answers as TriageAnswers;
  const priorityIndex = Math.min(
    Math.max(Math.round(answers.priority.level), 0),
    PRIORITY_LEVELS.length - 1
  );

  const rawType = answers.type.choice;
  const type = (TRIAGE_TYPES as readonly string[]).includes(rawType)
    ? (rawType as TriageType)
    : 'other';

  const suggestedLabelIds = Object.entries(labelKeys)
    .filter(([key]) => {
      const answer = answers[key];
      return answer?.type === 'noul' && answer.probability >= opts.labelThreshold;
    })
    .map(([, id]) => id);

  return {
    type,
    priority: priorityFromIndex(priorityIndex),
    priorityIndex,
    spamProbability: answers.is_spam.probability,
    needsHumanProbability: answers.needs_human.probability,
    suggestedLabelIds,
    confidence: result.confidence,
    engine: result.engine,
    model: result.model,
    cost: result.cost,
  };
}
