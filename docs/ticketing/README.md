# Ticketing & Agents — conventions

Versioned copy of the conventions for the **ASAP — Ticketing & Agents** project (Linear team "ASAP"). If this file and the code disagree, fix whichever is wrong in the same PR.

## What this project builds

ASAP (repo `AxDevGrp/asap`, branch `main`) is a multi-tenant AI customer-support platform. Businesses (tenants) route their support email to ASAP; ASAP triages, drafts and (within policy) sends replies. This project adds Linear-inspired work management: a **Triage inbox**, actionable **Tickets** with statuses/priority/owners/labels, **Contacts**, **duplicate merging**, **delegation to an AI agent** with a visible session log, **approvals**, **triage rules**, **SLAs**, and **notifying every affected contact when a ticket is resolved**. We borrow Linear's *ideas* only — no Linear integration, no copying of Linear's UI or branding.

## Glossary (use these words in code and UI)

* **Tenant / Workspace** — an ASAP customer business (`tenants`). Members are its staff (`tenant_memberships`, roles `owner|admin|agent`).
* **Contact** — an end user of a tenant who writes in (identified by email). NOT an ASAP customer.
* **Organization** — optional grouping of contacts by *business* email domain (never gmail/outlook/etc.).
* **Conversation** — one email thread with one contact (`conversations`, messages in `messages`/`inbound_messages`/`outbound_messages`).
* **Ticket** — the actionable work item. Many conversations can link to one ticket through **Requests** (`customer_requests`).
* **Owner** — the accountable human on a ticket. **Agent** — the ASAP AI agent, which can be *delegated* a ticket; the owner stays accountable.
* **Session** — one agent run on a ticket, logged as **activities**: `thought`, `action`, `elicitation` (asks a human), `response`, `error`, `prompt` (human message to the agent).

## Ticket statuses (fixed set, all tenants)

`triage` → `todo` → `in_progress` → `waiting_on_customer` | `waiting_on_approval` → `resolved`; terminal side exits `canceled`, `duplicate`.
Categories: **triage** = {triage}; **active** = {todo, in_progress, waiting_on_customer, waiting_on_approval}; **closed** = {resolved, canceled, duplicate}.
Priority: `none | low | medium | high | urgent`. Ticket IDs: `<PREFIX>-<n>` per tenant (e.g. `GOA-123`).

## How a ticket flows

1. **Inbound email** — a contact emails the tenant support address. Resend fires `email.received` at `POST /api/webhook/resend`, which verifies the Svix signature, resolves the tenant by recipient domain, dedupes by `message_id`, threads the message into a **conversation** and enqueues an `inbound_email.process` job.
2. **Triage** — the job runs `processInboundEmail` (`src/lib/pipeline.ts`): AI triage (type, urgency, sentiment) and a knowledge-base grounded draft reply. New tickets start in status `triage`; follow-ups on an active ticket are appended to it instead.
3. **Accepted** — a human accepts the ticket out of Triage (status moves to an **active** status) and gives it an **owner** and/or delegates it to the **agent**. The owner stays accountable either way.
4. **Work** — the owner and/or agent work the ticket: replies, internal notes, labels, priority changes and waiting states (`waiting_on_customer`, `waiting_on_approval`). Every change is recorded on the ticket timeline.
5. **Resolved** — the ticket moves to `resolved` (or exits as `canceled` / `duplicate`). A reply on a recently resolved ticket reopens it.
6. **Contacts notified** — every contact linked to the ticket through a request gets a personal update. These messages are human-confirmed unless the tenant has opted in to auto-send (off by default).

## Stack & where things live

* Next.js 14 App Router + TypeScript (`src/app`), Tailwind, Supabase Postgres + pgvector, Resend email, Vercel hosting.
* **DB access (server):** service-role client — `supabase` from `src/lib/supabase.ts` or `createSupabaseAdminClient()` (`src/lib/supabase-server.ts`). Never use the anon key server-side. Session-scoped reads use `createSupabaseServerClient()`.
* **Auth in API routes:** `requireTenantMember(tenantId, roles?)` from `src/lib/auth.ts`; return its `.error` response. Apply `checkApiReadLimit/checkApiWriteLimit` (`src/lib/rate-limit.ts`).
* **Background work:** durable jobs — `enqueueJob()` in `src/lib/jobs.ts`, handlers registered in `src/lib/job-handlers.ts`, drained by `POST /api/jobs/run` (called every minute by Supabase pg_cron and kicked by the webhook). Handlers must be **idempotent** (they can retry).
* **AI:** all model calls go through `src/lib/llm.ts` (OpenRouter; models are env settings). Decisions go through the decisions client added in milestone 1. Never call a provider directly.
* **Inbound email:** `src/app/api/webhook/resend/route.ts` (Svix-verified, `email.received`) → enqueues `inbound_email.process` → `processInboundEmail` in `src/lib/pipeline.ts`.
* **Policies:** `tenant_policies` via `getTenantPolicy()` (`src/lib/policies.ts`). **Auto-send is off by default** and must stay opt-in.

## Database rules

* New migration per issue: `supabase migration new <name>` → `supabase/migrations/<timestamp>_<name>.sql`. Never edit an applied migration. Idempotent DDL (`if not exists`).
* Every table has `tenant_id` (or a parent that does), RLS **enabled**, a `for all to service_role using (true)` policy, and a read-only `for select to authenticated` policy scoped to `tenant_id in (select tenant_id from tenant_memberships where user_id = auth.uid())`. No anon policies. Copy the pattern from `supabase/migrations/20261109000000_baseline.sql`.
* Verify locally with Docker: `supabase start && supabase db reset` (applies all migrations + `supabase/seed.sql`). Applying to the hosted project is done with `supabase db push --db-url "$DATABASE_URL"` **only after the PR is merged** — say so in the PR, don't push migrations from a branch.

## Definition of done (every issue)

1. Work on a branch `asap-<issue-number>-<slug>`; one PR per issue, title `ASAP-<n>: <title>`, link the issue.
2. `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` all pass (the Vitest/ESLint/CI harness is added in ASAP-2).
3. New logic has unit tests (Vitest); new tables have an RLS test (anon sees nothing, members see only their tenant).
4. No secrets in code or logs; no customer email bodies in logs.
5. UI follows the existing dashboard style (`src/app/dashboard/*`, `src/components/DashboardNav.tsx`).
6. Update the issue with what was done and anything deferred.

## Milestones (build in order)

* **0 · Foundation: ticket model v2** — Test harness, ticket statuses/priority/numbering/owner, activity timeline, labels, inbound routing on the new model, tickets API v2.
* **1 · Decisions layer (JEV)** — Fast, cheap typed decisions (type, priority, spam, approval-needed) via TypeSafe JEV on OpenRouter, with LLM fallback, shadow mode and calibration.
* **2 · Triage inbox** — Every new email lands in Triage; accept / decline / duplicate / snooze / request-info; keyboard-driven Triage UI; list + board views; realtime.
* **3 · Contacts & organizations** — Tenants' end users as Contacts (by email), optional Organizations (business domains only), and Requests linking conversations to tickets.
* **4 · Duplicates & merge** — Ticket embeddings, duplicate suggestions (vector + JEV), merge into a canonical ticket.
* **5 · Comments & notifications** — Internal notes with @mentions (incl. @agent), separate from customer replies; in-app + email notifications with preferences.
* **6 · Agent delegation & sessions** — Delegate tickets to the ASAP agent: logged sessions (thought/action/elicitation/response/error/prompt), tool registry with connector plug-in point, budgets, referee gate, steering, stop, handoff.
* **7 · Approvals** — Human approval for risky agent actions and replies: queue, inline approve/deny, execution, 24h expiry.
* **8 · Triage rules, assignment & procedures** — Per-tenant if/then rules (top-down), rule builder, round-robin owners with out-of-office, workspace guidance and procedures for the agent.
* **9 · SLAs** — First-response and resolution targets by priority and contact tier, business hours, at-risk/breach detection, escalation, SLA UI.
* **10 · Closing the loop** — When a ticket is resolved, every linked contact gets a personal AI-written update (human-confirmed unless auto-send).
* **11 · Hardening** — Metrics, end-to-end simulation, security and tenant-isolation suite, docs and runbook.

## Tests

* `npm test` — Vitest unit tests (`src/**/*.test.ts`). `npm run test:watch` for watch mode.
* `npm run lint` — ESLint (`next/core-web-vitals`), non-interactive.
* `scripts/test-db.sh` — resets the **local** Supabase DB (`supabase db reset`) and runs every `scripts/sql-tests/*.sql` file with `psql`, printing PASS/FAIL per file. Needs Docker/colima running and `supabase start` first; it refuses arguments and non-local `TEST_DB_URL`.
* CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests and build on push/PR to `main`.
