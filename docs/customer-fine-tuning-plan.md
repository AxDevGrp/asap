# Per-Customer Fine-Tuning — Implementation Plan

Status: draft for founder review. Scope: plan only; no application code ships with this document.

## 1. Summary

ASAP already triages inbound email, retrieves the tenant's knowledge base, drafts a reply and auto-resolves high-confidence tickets (`src/lib/auto-resolve.ts`, `src/lib/rag.ts`). The next step is to make every tenant's AI better *at that tenant's job* without hand-writing prompts per customer. We do this in three connected parts: **specialists** — one small open-weight LoRA adapter per tenant, trained on full agent sessions plus filtered synthetic data generated from the tenant's best real cases; a **referee** — a cheap gate that checks the session log and the draft before anything is sent, so a hallucinated "I've refunded you" never leaves the building; and a **scoreboard** — a private, locked benchmark of real tickets with reference answers where the frontier model sets the target line and a tenant adapter only takes over once it matches that line, hard cases included. The web product stays TypeScript/Next.js on Supabase; a separate Python service does all ML work (data building, training, evaluation). No GPUs are always on: training runs on hourly-rented GPUs and inference starts on hosted per-token multi-LoRA endpoints before moving to scale-to-zero serverless GPUs. Facts (prices, policies) stay in the KB; the adapter only learns behaviour. We pilot on ASAP's own support inbox (the goASAP tenant) before selling the capability.

## 1a. Goals

- Every tenant gets a model that follows its tone, structure, escalation habits and tool use, with no shared-model cross-talk and no per-tenant prompt engineering.
- No unsupported claim ever reaches a customer: referee rejects, or the reply escalates.
- Objective, per-tenant quality and cost measurement (scoreboard score, referee rejection rate, cost per ticket).
- Tenant data is isolated, exportable and deletable, including adapter weights.
- Unit economics work at pilot and at ~50 tenants without owning GPUs early.

## 1b. Non-goals

- Training a base model from scratch, or any pretraining. We only train LoRA/QLoRA adapters.
- Replacing Supabase or the Next.js app with Python. Python is a job runner only.
- Rust services. The bottleneck is model latency and the ML ecosystem is Python.
- Autonomous policy changes: facts change through KB edits, never through retraining.
- Chatwoot integration of any kind (it is being removed).

## 2. Architecture overview

Online path (per inbound email):

```
inbound email (Resend webhook)
        |
        v
  tenant resolve -> agent loop (model router picks adapter / frontier)
        |                |-- tool: search_kb (pgvector, tenant-scoped)
        |                |-- tool: get_account / get_order / refund (connectors)
        |                |-- tool: escalate
        |                v
        |          session_steps (append-only log: action, args, result, status)
        v
    draft reply
        |
        v
  REFEREE  (1) deterministic checks vs session log + retrieved facts
           (2) narrow model: claimed action/fact -> supported / unsupported
        |
   approved? --yes--> send via Resend  --> ticket resolved
        |--no---> reason back to agent --> retry (max 1) --> escalate to frontier/human
```

Offline path (nightly / on trigger):

```
session log (sessions, session_steps, labels)   historical imports
        |                                              |
        v                                              v
  dataset builder (filter, PII scrub, dedupe) <--------+
        |
        v
  synthetic generation (teacher model from best cases, docs, rules) --> quality filter --> human spot-check
        |
        v
  training (Unsloth / Axolotl+TRL, LoRA) --> eval on scoreboard --> adapter registry
        |
        v
  benchmark run (frontier vs base vs tenant adapter) --> scorecard --> model_router cutover decision
```

Key invariant: the session log is the single source of truth for both the referee (online) and training data (offline). If a step is not logged, it cannot be claimed, trained on, or audited.

## 3. Data model additions

All tables carry `tenant_id uuid not null references tenants(id) on delete cascade` and follow the existing RLS pattern seen in `supabase/migrations/008_conversations_and_engine.sql`: RLS enabled, `service_role` full access, members read-only via `tenant_memberships`.

| Table | Purpose | Key columns |
|---|---|---|
| `sessions` | One agent run for one inbound message | `id`, `tenant_id`, `conversation_id`, `inbound_message_id`, `status` (`running`/`drafted`/`referee_rejected`/`sent`/`escalated`), `router_decision jsonb`, `model_version_id`, `final_text`, `label` (`approved`/`edited`/`rejected`/`none`), `label_by`, `labelled_at`, `latency_ms`, `cost_cents` |
| `session_steps` | Ordered log of every agent action | `id`, `session_id`, `seq int`, `kind` (`model_call`/`tool_call`/`tool_result`/`final_reply`), `tool_name`, `args jsonb`, `result jsonb`, `status` (`ok`/`error`), `latency_ms`, `tokens_in/out` |
| `tool_connectors` | Per-tenant tool definitions | `id`, `tenant_id`, `name`, `kind` (`rest`/`rpc`/`webhook`), `spec jsonb`, `enabled`, `secrets_ref` (never inline secrets) |
| `training_examples` | Normalised training rows | `id`, `tenant_id`, `session_id`, `input jsonb` (message + retrieved context), `target jsonb` (steps + reply), `source` (`real`/`synthetic`/`imported`), `teacher_model`, `quality_score`, `label` (`approved`/`edited`/`rejected`), `final_sent_text`, `pii_scrubbed bool`, `dataset_id` |
| `datasets` | Versioned snapshots | `id`, `tenant_id`, `version`, `example_count`, `filters jsonb`, `created_at`, `frozen bool` |
| `model_versions` | Base + adapter registry | `id`, `tenant_id` (null for frontier/base), `kind` (`frontier`/`base`/`adapter`), `base_model`, `adapter_uri`, `training_dataset_id`, `eval_score jsonb`, `state` (`training`/`candidate`/`shadow`/`live`/`retired`), `created_at` |
| `benchmark_suites` | Per-tenant locked benchmark | `id`, `tenant_id`, `version`, `locked_at`, `target_source_model` |
| `benchmark_cases` | Individual eval cases | `id`, `suite_id`, `ticket_ref`, `hard bool`, `reference_answer`, `grader jsonb` (rubric + assertions), `variations_of` |
| `benchmark_runs` / `benchmark_results` | Runs and per-case outcomes | run: `id`, `suite_id`, `model_version_id`, `mode` (`frontier`/`base`/`adapter`), `score`; result: `run_id`, `case_id`, `passed bool`, `referee_passed bool`, `reason` |
| `referee_rules` | Deterministic checks | `id`, `tenant_id` (null = global), `code` (e.g. `claim_requires_tool_ok`), `config jsonb`, `severity` |
| `referee_verdicts` | Every gate decision | `id`, `session_id`, `step1_passed`, `step2_output jsonb` (`approved`, `offending_sentence`), `approved bool`, `model_version`, `latency_ms` |
| `model_routing` | Per-tenant routing config | `id`, `tenant_id` unique, `live_model_version_id`, `shadow_model_version_id`, `min_score_delta`, `escalation_model`, `enabled` |

Sketch:

```sql
create table sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  label text check (label in ('approved','edited','rejected','none')) default 'none',
  final_text text,
  cost_cents numeric(10,4),
  created_at timestamptz default now()
);
alter table sessions enable row level security;
create policy "service_role_full_access_sessions" on sessions
  as permissive for all to service_role using (true);
create policy "tenant members read sessions" on sessions for select
  using (tenant_id in (select tenant_id from tenant_memberships where user_id = auth.uid()));
```

Notes: `session_steps` is append-only (revoke UPDATE/DELETE for non-service roles) so training data cannot be silently rewritten. Adapter weights live in object storage, not Postgres; the row stores the URI. All foreign keys cascade from `tenants`, which gives deletion-on-tenant-delete for free (see Phase 5).

## 4. Phased implementation plan

### Phase 0 — Prerequisite (in progress separately)

Deliverables: Chatwoot removed; the AI pipeline runs from the Resend `email.received` webhook, with the email body fetched from Resend's Received Emails API (the webhook carries metadata only). `src/lib/chatwoot.ts` deleted and its importers migrated.

Tasks: finish the existing Chatwoot removal; handle `email.received` in `src/app/api/webhook/resend/route.ts` — fetch the body from Resend's Received Emails API, produce a ticket message row with tenant id, and store the AI draft in `tickets.auto_reply_text`; auto-send off by default per tenant, gated by `settings.autoSendEnabled`.

Repo areas: `src/app/api/webhook/resend/`, `src/lib/auto-resolve.ts`, `src/lib/config.ts` (stay untouched until Chatwoot work lands).

Exit criteria: no Chatwoot webhook route or `chatwoot_*` column reads on the live path; a test email in staging produces one inbound ticket → one draft → one outbound row.
Effort: S (already underway).

### Phase 1 — Agent loop, tools, session logging, human labels

Deliverables: a real agent loop with tool calls; connectors table; complete session log; approve/edit/reject capture in the dashboard.

Tasks:
- Replace the single-shot draft in `src/lib/rag.ts` caller with a loop: model → tool call → result → model (max N steps).
- Implement `search_kb` as a tool wrapping the existing `match_knowledge_base` RPC; add tenant-scoped connectors (`tool_connectors`) with a thin `callTool()` dispatcher in a new `src/lib/agent/tools.ts`.
- Write `sessions` + `session_steps` per run; log token counts and latency.
- Dashboard ticket view (`src/app/dashboard/tickets/`) gets Approve / Edit / Reject on each draft; write `label` and `final_sent_text` back to `sessions`.
- Migration `supabase/migrations/013_agent_sessions.sql`.

Repo areas: `src/lib/agent/`, `src/lib/rag.ts`, `src/app/api/tickets/[id]/`, `src/app/dashboard/tickets/`, `supabase/migrations/`.

Exit criteria: 100% of sent AI replies have a session with ≥1 step and full tool results; ≥80% of pilot-week drafts receive a label (approved/edited/rejected); step log reproduces any reply deterministically. Effort: L.

### Phase 2 — Referee

Deliverables: deterministic gate + narrow model gate before send; labelled broken-session test set; permanent regression suite.

Tasks:
- Implement `referee_rules` checks in `src/lib/referee/deterministic.ts`: every action the reply claims maps to a `tool_call` with `status=ok`; every quoted number/price appears verbatim in retrieved KB text; no claim of a refund/send without a matching successful tool result.
- Narrow model gate in `services/referee/` (small open model, fixed JSON output `{approved, offending_sentence, claimed_items[]}`), called from the TS pipeline over HTTP.
- Wire into the send path: rejected → reason appended to the session → one retry → escalate to frontier, then human.
- Build the labelled eval set: deliberately broken sessions (invented actions, wrong prices, wrong tone) plus look-wrong-but-fine cases; every real mistake becomes a case in `referee_verdicts`-backed regression suite.

Repo areas: `src/lib/referee/`, `src/app/api/webhook/resend/route.ts`, new `services/referee/`, `supabase/migrations/014_referee.sql`.

Exit criteria: referee catches ≥98% of the labelled broken set; false-reject rate <2% on the tricky set; p95 added latency <700 ms; every escaped mistake within one week becomes a test case. Effort: M.

### Phase 3 — Scoreboard

Deliverables: locked per-tenant benchmark with reference answers and graders; runs for frontier/base/adapter; scorecard in dashboard.

Tasks:
- Build suites from real labelled tickets (a handful → a few hundred variations per tenant); frontier drafts reference answers, tenant corrects them; store as `benchmark_suites`/`benchmark_cases` with `hard` flag.
- Graders: rubric-based LLM judge + deterministic assertions (e.g. cites correct price, calls correct tool). Store grader config per case.
- Python job runner `services/trainer/bench/` runs any `model_versions.id` against a suite and writes `benchmark_runs`/`benchmark_results`.
- Drop cases all models trivially pass; keep hard and permanent cases forever.
- Dashboard page showing score, referee pass rate and cost per ticket per model.

Repo areas: `services/trainer/bench/`, `src/app/dashboard/monitoring/`, `src/lib/analytics.ts`, migration `015_benchmarks.sql`.

Exit criteria: each pilot tenant has ≥30 cases (≥10 hard); frontier baseline recorded and versioned; monthly re-runs reproducible (same seed + same suite → same score ±2%). Effort: M.

### Phase 4 — Specialists

Deliverables: synthetic data pipeline, training job, adapter registry, serving + router with shadow mode and gated cutover.

Tasks:
- Dataset builder in `services/trainer/data/`: pull labelled sessions + imports, filter by quality, scrub PII, dedupe, emit JSONL; version as `datasets`.
- Synthetic generation `services/trainer/synth/`: teacher model (open-weight preferred, see risks) generates sessions from best cases/docs/rules; auto quality filter (referee + scoreboard subset) then human spot-check of a sample.
- Training `services/trainer/train/`: Unsloth (or Axolotl/TRL) LoRA/QLoRA on rented GPUs; register result in `model_versions` as `candidate`.
- Serving: start with hosted per-token multi-LoRA (Together/Fireworks-style); later vLLM multi-LoRA on serverless GPUs. Adapter load/unload by `model_versions.id`.
- Router `src/lib/agent/router.ts`: reads `model_routing`; shadow mode runs candidate in parallel without sending; gated cutover per §7.

Repo areas: new `services/trainer/`, `src/lib/agent/router.ts`, `services/inference/`, migrations `016_model_versions.sql`.

Exit criteria: first tenant adapter beats base model on the scoreboard by ≥15 points; shadow mode shows no uplift in referee rejections vs live; cutover decision is recorded and reversible in <5 minutes. Effort: L.

### Phase 5 — Productization

Deliverables: self-serve tenant onboarding (incl. historical ticket import), retrain automation, score/cost dashboard, pricing tiers, data export/delete.

Tasks:
- Importers for Zendesk, Help Scout, Gmail, Intercom: `services/trainer/import/`; map to `training_examples` with `source='imported'`.
- Retrain automation: scheduled check of triggers (§6), enqueue jobs, notify owner.
- Dashboard: scores, referee rejection trend, cost per ticket, model state per tenant (`src/app/dashboard/settings/`).
- Pricing tiers: e.g. Standard (shared/frontier only), Pro (tenant adapter), Scale (dedicated capacity).
- Export/delete: full tenant export including adapter weights; delete removes all rows via cascade plus object-storage weights.

Repo areas: `services/trainer/import/`, `src/app/onboarding/`, `src/app/dashboard/`, `src/app/api/tenants/[id]/`.

Exit criteria: a new tenant can import history, get a first adapter and see a scorecard within 2 weeks of onboarding; export+delete verified end-to-end in staging with zero residual rows or weights. Effort: L.

## 5. Infrastructure and cost

All costs are **order-of-magnitude estimates to verify**, at current rental/API prices.

| Component | When it runs | Where | Rough cost (est.) |
|---|---|---|---|
| Live inference (per-token, multi-LoRA) | always | hosted provider (Together/Fireworks-style) | ~$0.20–$0.80 per 1M output tokens; small model much cheaper than frontier |
| Referee model inference | per draft | same hosted endpoint or tiny dedicated | ~$0.05–$0.15 per 1M tokens |
| Frontier model | escalations, ref answers, teacher (if allowed) | API | ~$2–$10 per 1M tokens |
| Training run | few hours per run | hourly GPU (Vast.ai/RunPod) | ~$1–$3/hr A100/H100 class; ~$5–$20 per run for LoRA on tens of thousands of examples |
| Synthetic generation | per retrain cycle | API / open-weight teacher | ~$10–$100 per tenant cycle, depending on volume |
| Benchmark runs | daily/weekly + on demand | hosted endpoints or short GPU rental | ~$1–$10 per full suite run |
| Serverless GPU inference (later) | scale-to-zero, cold starts | Vast serverless / RunPod serverless / Modal | ~$0.10–$0.50 per 1M tokens at low volume; cheaper than per-token above a threshold |
| Dedicated GPU (last) | always | rented or reserved | ~$700–$2,000/month per GPU; only when volume justifies |

Stage budgets (estimates):
- **Pilot (goASAP tenant, then the first 1–2 design-partner customers):** ~$100–$400/month total — mostly frontier API for reference answers plus a few training runs.
- **~50 tenants:** ~$1,500–$6,000/month — hosted per-token inference dominates; training still episodic; consider serverless GPU if per-token cost climbs.
- **High volume:** dedicated/serverless GPUs with vLLM multi-LoRA; cost keyed to tickets/month; aim for cost per ticket below frontier-only baseline.

Email tolerates cold starts: a 3–10 s scale-to-zero spin-up is acceptable for inbound email (not chat), which is why serverless GPUs are viable.

## 6. Retraining lifecycle and triggers

Most gain comes from the first few thousand quality examples; further examples plateau. Retraining is **trigger-based, not continuous** — typically monthly or less.

Lifecycle per tenant:
1. Accumulate labelled sessions + imports; nightly dataset builder refreshes a *draft* dataset (not trained yet).
2. A trigger fires a retrain cycle: likely causes — benchmark score dropped >X points; referee rejection rate rose >Y% over 2 weeks; new product/tool added; new stronger base model available; N accumulated real failures (referee escapes or human rejections) since last run.
3. Cycle: build dataset → synthetic round from current hard failures → train candidate → benchmark → shadow → gated cutover (§7).
4. Failures on the scoreboard feed the *next* synthetic-data round; hard cases are never dropped.

Adapters are immutable and versioned; a retrain always produces a new `model_versions` row, never mutates one in place.

## 7. Model routing and cutover

Router reads `model_routing` per tenant. Order of preference: tenant adapter (live) → frontier (escalation) → human.

- **Shadow mode:** candidate adapter runs alongside live on every ticket; output is stored, never sent. Compare against live and frontier on the scoreboard and on live referee pass rate.
- **Gated cutover:** candidate becomes `live` only when it matches frontier's scoreboard target *including hard and permanent cases* and does not increase referee rejections. A minimum observation window (e.g. 2 weeks shadow) is required.
- **Rollback:** one-row update in `model_routing` points `live_model_version_id` back to the previous version; effective within one request (<5 minutes). Adapters are served concurrently, so rollback needs no redeploy.
- **Escalation path:** referee rejection → 1 retry → frontier → human queue. Low confidence / low KB similarity → human directly (reusing existing `auto_resolve` gates). Frontier remains for escalations, generating new training data and setting benchmark targets.

## 8. Risks and open questions

| Risk | Mitigation |
|---|---|
| Provider ToS may restrict training on frontier-model outputs | Legal review before enabling; **prefer an open-weight teacher model** for synthetic data; keep frontier only for reference answers/targets where permitted |
| Tenant data consent for training | Explicit ToS clause; opt-in per tenant; training only on approved/edited sessions by default |
| Cross-tenant leakage | Hard `tenant_id` isolation in RLS, per-tenant datasets and adapters, separate storage prefixes; no shared adapter |
| Hallucinated actions | Referee deterministic + model gate; every claimed action must map to a logged successful tool call |
| Model drift | Versioned adapters, benchmark re-runs, trigger-based retraining |
| PII in training sets | Scrub before dataset build; store `pii_scrubbed` flag; spot-check |
| Data deletion/export requests | Cascade delete via `tenants`, plus object-storage adapter weights; export tooling in Phase 5 |
| Cost overrun | Per-ticket cost tracking; serverless GPU before dedicated; per-token inference measured against budget |
| Referee false rejects blocking real tickets | Tricky-case set; one retry then escalate; <2% false-reject target |

Open questions for the founder:
1. Which open-weight teacher model do we standardise on, and does its licence permit commercial use for training?
2. Is training on customer data opt-in per tenant, or bundled in ToS with a toggle?
3. Pricing: per-tenant adapter premium vs included in a higher tier?
4. Minimum ticket volume per tenant before an adapter is worth training (proposed: ~500 labelled sessions)?
5. Who owns the adversarial "broken session" red-team set long-term — a standing internal role or per-tenant spot-checks?
6. Hosted per-token provider choice: Together vs Fireworks vs direct vLLM — decide at Phase 4 based on measured latency.
