#!/usr/bin/env node
// Decision calibration report for triage decisions (ASAP-10).
// Strictly read-only: every query is a select.
//
// Usage:
//   node --env-file=.env.local scripts/decision-report.mjs --tenant <slug|uuid> \
//     [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]
//
// Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from '@supabase/supabase-js';
import {
  THRESHOLDS,
  accuracy,
  confusionMatrix,
  goNoGo,
  latestPerEngine,
  pickLabelThreshold,
  pickSpamThreshold,
  precisionRecallF1,
  sweepThresholds,
} from './lib/decision-metrics.mjs';

const PRIORITY_LABELS = ['low', 'medium', 'high', 'urgent'];
const TRIAGE_TYPES = ['bug', 'feature_request', 'question', 'billing', 'account', 'other'];
const EVENT_KINDS = ['priority_changed', 'declined', 'accepted'];
const PAGE_SIZE = 1000;
const NEEDS_HUMAN_THRESHOLD = 0.5;
const USAGE =
  'Usage: node --env-file=.env.local scripts/decision-report.mjs ' +
  '--tenant <slug|uuid> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--tenant' || arg === '--from' || arg === '--to') {
      const value = argv[++i];
      if (!value) fail(`Missing value for ${arg}\n${USAGE}`);
      args[arg.slice(2)] = value;
    } else fail(`Unknown argument: ${arg}\n${USAGE}`);
  }
  return args;
}

function parseDay(value, flag) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${flag} must be YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) fail(`${flag} is not a valid date`);
  return date;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function money(value) {
  if (value === null) return 'n/a';
  if (value === 0) return '$0';
  return `$${value.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}`;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function selectAll(makeQuery, pageSize = PAGE_SIZE) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await makeQuery().range(offset, offset + pageSize - 1);
    if (error) throw new Error(`Supabase select failed: ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
    offset += pageSize;
  }
}

async function selectInChunks(ids, makeQuery, chunkSize = 200) {
  const rows = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    rows.push(...(await selectAll(() => makeQuery(chunk))));
  }
  return rows;
}

async function loadTenant(db, tenantArg) {
  const query = db.from('tenants').select('id, slug, name');
  const { data, error } = isUuid(tenantArg)
    ? await query.eq('id', tenantArg).maybeSingle()
    : await query.eq('slug', tenantArg).maybeSingle();
  if (error) throw new Error(`Tenant lookup failed: ${error.message}`);
  if (!data) fail(`Tenant not found: ${tenantArg}`);
  return data;
}

function answerFor(row, name) {
  return row.answers && typeof row.answers === 'object' ? row.answers[name] : undefined;
}

function priorityOfAnswer(row) {
  const answer = answerFor(row, 'priority');
  if (!answer) return null;
  if (typeof answer.label === 'string' && PRIORITY_LABELS.includes(answer.label)) {
    return answer.label;
  }
  const raw = Number.isFinite(answer.level) ? answer.level : answer.score;
  if (!Number.isFinite(raw)) return null;
  const index = Math.min(Math.max(Math.round(raw), 0), PRIORITY_LABELS.length - 1);
  return PRIORITY_LABELS[index];
}

function typeOfAnswer(row) {
  const answer = answerFor(row, 'type');
  return answer && typeof answer.choice === 'string' ? answer.choice : null;
}

function probabilityOfAnswer(row, name) {
  const answer = answerFor(row, name);
  return answer && Number.isFinite(answer.probability) ? answer.probability : null;
}

function labelNameFromQuestion(question) {
  const instructions = question && question.instructions;
  if (typeof instructions !== 'string') return null;
  const match = /Does the label "([^"]+)" apply\?/.exec(instructions);
  return match ? match[1] : null;
}

function groundTruthFor(ticket, labelNames) {
  const acted = ticket.status !== 'triage' || ticket.decline_kind != null;
  if (!acted) return null;

  let spam = null;
  if (ticket.decline_kind === 'spam') spam = true;
  else if (ticket.decline_kind === 'not_actionable') spam = false;
  else if (ticket.status !== 'triage') spam = false;

  return {
    priority: ticket.priority && ticket.priority !== 'none' ? ticket.priority : null,
    spam,
    labelNames,
    accepted: ticket.decline_kind == null && ticket.status !== 'triage',
    declined: ticket.decline_kind != null,
  };
}

function typeLabelOrder(observed) {
  const present = new Set(observed);
  const known = TRIAGE_TYPES.filter((type) => present.has(type));
  const extra = [...present].filter((type) => !TRIAGE_TYPES.includes(type)).sort();
  return [...known, ...extra];
}

function buildEngineStats(rows, tickets, truthByTicket) {
  const priorityPairs = [];
  const spamPairs = [];
  const labelPairs = [];
  const needsHuman = [];
  const latencies = [];
  const costs = [];

  for (const row of rows) {
    const ticket = tickets.get(row.ticket_id);
    if (!ticket) continue;

    const latency = Number(row.latency_ms);
    if (Number.isFinite(latency)) latencies.push(latency);
    const cost = Number(row.cost_usd);
    costs.push(Number.isFinite(cost) ? cost : 0);

    const needsHumanProbability = probabilityOfAnswer(row, 'needs_human');
    if (needsHumanProbability !== null) needsHuman.push(needsHumanProbability);

    const truth = truthByTicket.get(row.ticket_id);
    if (!truth) continue;

    if (truth.priority) {
      const predicted = priorityOfAnswer(row);
      if (predicted) priorityPairs.push({ truth: truth.priority, predicted });
    }

    if (truth.spam !== null) {
      const probability = probabilityOfAnswer(row, 'is_spam');
      if (probability !== null) spamPairs.push({ probability, positive: truth.spam });
    }

    const questions = row.questions && typeof row.questions === 'object' ? row.questions : {};
    for (const [name, question] of Object.entries(questions)) {
      if (!name.startsWith('label_')) continue;
      const labelName = labelNameFromQuestion(question);
      if (!labelName) continue;
      const probability = probabilityOfAnswer(row, name);
      if (probability === null) continue;
      labelPairs.push({
        probability,
        positive: truth.labelNames.has(labelName),
      });
    }
  }

  const priorityData = {
    evaluated: priorityPairs.length,
    correct: priorityPairs.filter((pair) => pair.truth === pair.predicted).length,
    pairs: priorityPairs,
  };

  return {
    rows,
    priorityPairs,
    spamPairs,
    labelPairs,
    needsHuman,
    latencies,
    costs,
    priority: priorityData,
  };
}

function serialiseEngine(stats, spamThreshold) {
  const confusion = confusionMatrix(stats.priorityPairs, PRIORITY_LABELS);
  const spamSweep = sweepThresholds(stats.spamPairs);
  const labelSweep = sweepThresholds(stats.labelPairs);
  const totalCost = stats.costs.reduce((sum, value) => sum + value, 0);

  return {
    latest_rows: stats.rows.length,
    priority: {
      evaluated: stats.priority.evaluated,
      correct: stats.priority.correct,
      accuracy: stats.priority.evaluated ? accuracy(stats.priorityPairs) : null,
      confusion,
    },
    spam: {
      positives: stats.spamPairs.filter((pair) => pair.positive).length,
      negatives: stats.spamPairs.filter((pair) => !pair.positive).length,
      at_recommended_threshold:
        spamThreshold === null
          ? null
          : precisionRecallF1(stats.spamPairs, spamThreshold),
      sweep: spamSweep.map(({ threshold, precision, recall, f1, tp, fp, fn }) => ({
        threshold,
        precision,
        recall,
        f1,
        tp,
        fp,
        fn,
      })),
    },
    labels: {
      examples: stats.labelPairs.length,
      positives: stats.labelPairs.filter((pair) => pair.positive).length,
      sweep: labelSweep.map(({ threshold, precision, recall, f1, tp, fp, fn }) => ({
        threshold,
        precision,
        recall,
        f1,
        tp,
        fp,
        fn,
      })),
    },
    latency_ms: { mean: mean(stats.latencies) },
    cost_usd: {
      total: totalCost,
      mean_per_ticket: stats.rows.length ? totalCost / stats.rows.length : null,
    },
  };
}

function printConfusion(confusion, indent = '  ', corner = 'truth') {
  if (confusion.labels.length === 0) return [`${indent}(no evaluated rows)`];
  const width = Math.max(...confusion.labels.map((label) => label.length), 5);
  const lines = [
    `${indent}${corner.padEnd(width)}  ${confusion.labels.map((label) => label.padStart(width)).join('  ')}`,
  ];
  confusion.labels.forEach((label, row) => {
    const cells = confusion.matrix[row].map((count) => String(count).padStart(width));
    lines.push(`${indent}${label.padEnd(width)}  ${cells.join('  ')}`);
  });
  return lines;
}

function printSweep(title, jevSweep, llmSweep, recommended) {
  const lines = [title];
  lines.push('  threshold    JEV P/R/F1              LLM P/R/F1');
  for (let i = 0; i < jevSweep.length; i++) {
    const jev = jevSweep[i];
    const llm = llmSweep[i];
    const marker = jev.threshold === recommended ? ' *' : '';
    lines.push(
      `  ${jev.threshold.toFixed(2).padEnd(8)}${marker.padEnd(2)}  ` +
        `${(percent(jev.precision) + ' / ' + percent(jev.recall) + ' / ' + percent(jev.f1)).padEnd(25)}` +
        `${percent(llm.precision)} / ${percent(llm.recall)} / ${percent(llm.f1)}`
    );
  }
  return lines;
}

function printReport(report) {
  const { engines } = report;
  const lines = [];
  lines.push(`Decision calibration report — ${report.tenant.slug} (${report.tenant.name})`);
  lines.push(`Tenant: ${report.tenant.id}`);
  lines.push(
    `Range: ${report.range.from ?? 'start'} .. ${report.range.to ?? 'now'} (UTC, decision_log.created_at)`
  );
  if (report.current_policy) {
    lines.push(
      `Current decision_mode: ${report.current_policy.decision_mode} ` +
        `(thresholds ${JSON.stringify(report.current_policy.decision_thresholds)})`
    );
  }
  lines.push('');
  lines.push('Counts');
  lines.push(
    `  decision rows: ${report.counts.decision_rows} (${report.counts.latest_rows} latest, ` +
      `${report.counts.tickets_with_decisions} tickets)`
  );
  lines.push(
    `  ground truth: ${report.counts.tickets_with_ground_truth} tickets ` +
      `(${report.counts.accepted_tickets} accepted, ${report.counts.declined_tickets} declined: ` +
      `${report.counts.spam_tickets} spam, ${report.counts.not_actionable_tickets} not_actionable)`
  );
  lines.push(`  both engines: ${report.counts.tickets_with_both_engines} tickets`);
  lines.push('');
  lines.push("Priority accuracy (truth = human-set ticket priority, 'none' excluded)");
  for (const engine of ['jev', 'llm']) {
    const priority = engines[engine].priority;
    lines.push(
      `  ${engine.toUpperCase().padEnd(3)} ${priority.correct}/${priority.evaluated} ` +
        `${percent(priority.accuracy)}`
    );
    lines.push(...printConfusion(priority.confusion, '    '));
  }
  lines.push('');
  lines.push(
    ...printSweep(
      'Spam precision/recall/F1 (truth = spam decline vs accepted/not_actionable)',
      engines.jev.spam.sweep,
      engines.llm.spam.sweep,
      report.recommended_thresholds.spam_auto_decline
    )
  );
  lines.push(
    `  recommended spam_auto_decline: ${report.recommended_thresholds.spam_auto_decline.toFixed(2)} ` +
      `(${report.recommendation_details.spam_auto_decline.reason})`
  );
  lines.push('');
  lines.push(
    ...printSweep(
      'Label precision/recall/F1 (pooled label_<i> questions; truth = label on ticket)',
      engines.jev.labels.sweep,
      engines.llm.labels.sweep,
      report.recommended_thresholds.label_suggest
    )
  );
  lines.push(
    `  recommended label_suggest: ${report.recommended_thresholds.label_suggest.toFixed(2)} ` +
      `(${report.recommendation_details.label_suggest.reason})`
  );
  lines.push('');
  lines.push('Type (JEV vs LLM agreement; there is no human-set type ground truth yet)');
  lines.push(
    `  agreement: ${report.type_agreement.agreed}/${report.type_agreement.tickets} ` +
      `${percent(report.type_agreement.rate)}`
  );
  lines.push(...printConfusion(report.type_agreement.confusion, '  ', 'JEV'));
  lines.push('');
  lines.push(`Needs human (no ground truth; threshold ${report.needs_human.threshold.toFixed(2)})`);
  for (const engine of ['jev', 'llm']) {
    const needsHuman = report.needs_human[engine];
    lines.push(
      `  ${engine.toUpperCase().padEnd(3)} mean ${needsHuman.mean_probability === null ? 'n/a' : needsHuman.mean_probability.toFixed(3)}, ` +
        `${needsHuman.above_threshold}/${needsHuman.tickets} above threshold`
    );
  }
  lines.push('');
  lines.push('Latency / cost (latest row per ticket and engine)');
  for (const engine of ['jev', 'llm']) {
    const stats = engines[engine];
    lines.push(
      `  ${engine.toUpperCase().padEnd(3)} mean ${stats.latency_ms.mean === null ? 'n/a' : Math.round(stats.latency_ms.mean)} ms, ` +
        `total ${money(stats.cost_usd.total)}, mean ${money(stats.cost_usd.mean_per_ticket)} per ticket`
    );
  }
  lines.push('');
  lines.push('Recommended decision_thresholds');
  lines.push(
    JSON.stringify(report.recommended_thresholds, null, 2)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')
  );
  lines.push('');
  lines.push(`Go/no-go: ${report.go_no_go.decision}`);
  if (report.go_no_go.reasons.length) {
    for (const reason of report.go_no_go.reasons) lines.push(`  - ${reason}`);
  } else {
    lines.push('  JEV meets the priority accuracy and spam F1 bars with enough ground truth.');
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.tenant) fail(`Missing --tenant\n${USAGE}`);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    fail(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
        'Run with: node --env-file=.env.local scripts/decision-report.mjs --tenant <slug|uuid>'
    );
  }

  const fromIso = args.from ? parseDay(args.from, '--from').toISOString() : null;
  let toExclusiveIso = null;
  if (args.to) {
    const to = parseDay(args.to, '--to');
    to.setUTCDate(to.getUTCDate() + 1);
    toExclusiveIso = to.toISOString();
  }
  if (fromIso && toExclusiveIso && fromIso >= toExclusiveIso) {
    fail('--from must be on or before --to');
  }

  const db = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const tenant = await loadTenant(db, args.tenant);

  const rows = await selectAll(() => {
    let query = db
      .from('decision_log')
      .select('id, ticket_id, engine, model, questions, answers, latency_ms, cost_usd, created_at')
      .eq('tenant_id', tenant.id)
      .eq('purpose', 'triage')
      .in('engine', ['jev', 'llm'])
      .not('answers', 'is', null)
      .not('ticket_id', 'is', null)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (fromIso) query = query.gte('created_at', fromIso);
    if (toExclusiveIso) query = query.lt('created_at', toExclusiveIso);
    return query;
  });

  const ticketIds = [...new Set(rows.map((row) => row.ticket_id))];
  const tickets = new Map();
  const labelsByTicket = new Map();

  if (ticketIds.length) {
    const ticketRows = await selectInChunks(ticketIds, (chunk) =>
      db
        .from('tickets')
        .select('id, number, subject, title, status, priority, decline_kind, accepted_at')
        .in('id', chunk)
        .order('id', { ascending: true })
    );
    for (const ticket of ticketRows) tickets.set(ticket.id, ticket);

    const labelRows = await selectInChunks(ticketIds, (chunk) =>
      db
        .from('ticket_labels')
        .select('ticket_id, label_id')
        .in('ticket_id', chunk)
        .order('ticket_id', { ascending: true })
        .order('label_id', { ascending: true })
    );
    for (const row of labelRows) {
      const set = labelsByTicket.get(row.ticket_id) ?? new Set();
      set.add(row.label_id);
      labelsByTicket.set(row.ticket_id, set);
    }

    const { data: labelDefs, error: labelError } = await db
      .from('labels')
      .select('id, name')
      .eq('tenant_id', tenant.id);
    if (labelError) throw new Error(`Supabase select failed: ${labelError.message}`);
    const labelNames = new Map((labelDefs ?? []).map((label) => [label.id, label.name]));
    for (const [ticketId, ids] of labelsByTicket) {
      labelsByTicket.set(
        ticketId,
        new Set([...ids].map((id) => labelNames.get(id)).filter((name) => typeof name === 'string'))
      );
    }
  }

  const events = ticketIds.length
    ? await selectInChunks(ticketIds, (chunk) =>
        db
          .from('ticket_events')
          .select('ticket_id, kind, actor_type, created_at')
          .in('ticket_id', chunk)
          .in('kind', EVENT_KINDS)
          .order('created_at', { ascending: true })
      )
    : [];

  const truthByTicket = new Map();
  for (const ticket of tickets.values()) {
    const truth = groundTruthFor(ticket, labelsByTicket.get(ticket.id) ?? new Set());
    if (truth) truthByTicket.set(ticket.id, truth);
  }

  const latest = latestPerEngine(rows);
  const engines = { jev: [], llm: [] };
  for (const row of latest) if (engines[row.engine]) engines[row.engine].push(row);

  const stats = {
    jev: buildEngineStats(engines.jev, tickets, truthByTicket),
    llm: buildEngineStats(engines.llm, tickets, truthByTicket),
  };

  const spamRecommendation = pickSpamThreshold(stats.jev.spamPairs);
  const labelRecommendation = pickLabelThreshold(stats.jev.labelPairs);
  const recommendedThresholds = {
    spam_auto_decline: spamRecommendation.threshold,
    label_suggest: labelRecommendation.threshold,
    needs_human: NEEDS_HUMAN_THRESHOLD,
  };

  const jevTypeByTicket = new Map();
  const llmTypeByTicket = new Map();
  for (const row of engines.jev) {
    const type = typeOfAnswer(row);
    if (type) jevTypeByTicket.set(row.ticket_id, type);
  }
  for (const row of engines.llm) {
    const type = typeOfAnswer(row);
    if (type) llmTypeByTicket.set(row.ticket_id, type);
  }
  const typePairs = [];
  for (const [ticketId, jevType] of jevTypeByTicket) {
    const llmType = llmTypeByTicket.get(ticketId);
    if (llmType) typePairs.push({ truth: jevType, predicted: llmType });
  }
  const typeLabels = typeLabelOrder(typePairs.flatMap((pair) => [pair.truth, pair.predicted]));

  const spamAtThreshold = {
    jev: precisionRecallF1(stats.jev.spamPairs, recommendedThresholds.spam_auto_decline),
    llm: precisionRecallF1(stats.llm.spamPairs, recommendedThresholds.spam_auto_decline),
  };

  const counts = {
    decision_rows: rows.length,
    latest_rows: latest.length,
    tickets_with_decisions: ticketIds.length,
    tickets_with_ground_truth: [...truthByTicket.keys()].length,
    tickets_with_both_engines: typePairs.length,
    accepted_tickets: [...truthByTicket.values()].filter((truth) => truth.accepted).length,
    declined_tickets: [...truthByTicket.values()].filter((truth) => truth.declined).length,
    spam_tickets: [...truthByTicket.values()].filter((truth) => truth.spam === true).length,
    not_actionable_tickets: [...truthByTicket.values()].filter(
      (truth) => truth.spam === false && truth.declined
    ).length,
    tickets_with_events: new Set(events.map((event) => event.ticket_id)).size,
  };

  const goNoGoFacts = {
    jevPriorityAccuracy: stats.jev.priority.evaluated ? accuracy(stats.jev.priorityPairs) : null,
    llmPriorityAccuracy: stats.llm.priority.evaluated ? accuracy(stats.llm.priorityPairs) : null,
    jevSpamF1: stats.jev.spamPairs.length ? spamAtThreshold.jev.f1 : null,
    llmSpamF1: stats.llm.spamPairs.length ? spamAtThreshold.llm.f1 : null,
    groundTruthTickets: counts.tickets_with_ground_truth,
  };

  const { data: policy } = await db
    .from('tenant_policies')
    .select('decision_mode, decision_thresholds')
    .eq('tenant_id', tenant.id)
    .maybeSingle();

  const report = {
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
    range: { from: args.from ?? null, to: args.to ?? null },
    current_policy: policy ?? null,
    counts,
    engines: {
      jev: serialiseEngine(stats.jev, recommendedThresholds.spam_auto_decline),
      llm: serialiseEngine(stats.llm, recommendedThresholds.spam_auto_decline),
    },
    type_agreement: {
      tickets: typePairs.length,
      agreed: typePairs.filter((pair) => pair.truth === pair.predicted).length,
      rate: typePairs.length ? accuracy(typePairs) : 0,
      confusion: confusionMatrix(typePairs, typeLabels),
    },
    needs_human: {
      threshold: NEEDS_HUMAN_THRESHOLD,
      jev: {
        tickets: stats.jev.needsHuman.length,
        mean_probability: mean(stats.jev.needsHuman),
        above_threshold: stats.jev.needsHuman.filter((p) => p >= NEEDS_HUMAN_THRESHOLD).length,
      },
      llm: {
        tickets: stats.llm.needsHuman.length,
        mean_probability: mean(stats.llm.needsHuman),
        above_threshold: stats.llm.needsHuman.filter((p) => p >= NEEDS_HUMAN_THRESHOLD).length,
      },
    },
    recommended_thresholds: recommendedThresholds,
    recommendation_details: {
      spam_auto_decline: spamRecommendation,
      label_suggest: labelRecommendation,
      needs_human: {
        threshold: NEEDS_HUMAN_THRESHOLD,
        reason: 'no ground truth yet; unchanged default',
      },
    },
    go_no_go: goNoGo(goNoGoFacts),
  };

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(printReport(report));
}

main().catch((error) => {
  console.error('Decision report failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
