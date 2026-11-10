# ASAP Resolution Platform: Scoped Technical Plan

**Status:** Draft for review · **Date:** 2026-11-09 · **Scope:** Planning only, no code

> **Goal:** Turn ASAP from an AI that *drafts replies* into an AI that *resolves issues* by taking real actions in the systems a business already uses. Each of those systems plugs in through a connector, and Shopify is the first one and the first place we sell. Over time the connector catalog, and third parties building on it, is what makes ASAP the "Shopify of AI support."

> **Constraint:** Chatwoot is being removed from the codebase completely and is out of scope everywhere in this plan. ASAP owns its own inbox, conversation model and agent UI.

---

## 1. What "resolve" means

A ticket is **resolved** when all of the following are true:

1. The customer's underlying problem is handled: an action was carried out in a system of record (refund issued, order cancelled, address changed, subscription paused, tracking found and explained, appointment rescheduled), **or** the question was fully answered from verified data.
2. The customer was told the outcome on their channel.
3. The customer either confirmed or didn't reopen the ticket within the **reopen window** (default 72h).

That definition is also what we bill on (see §11). "Deflected" or "replied" doesn't count.

**Resolution tiers** (how much autonomy the AI has):

| Tier | Example | Who acts |
|------|---------|----------|
| T0 Inform | "Where is my order?" answered from live order and tracking data | AI, auto |
| T1 Low-risk write | Update the shipping address before fulfillment, resend a confirmation, apply a ≤$10 discount | AI, auto, within policy |
| T2 Money and irreversible actions | Refund, cancel, replacement order | AI proposes, human approves one-click (auto once trust is built and caps allow) |
| T3 Judgment | Disputes, legal, abuse, VIP escalations | Human, AI assists |

---

## 2. Where we are (post-Chatwoot baseline)

The working tree already removes Chatwoot. The pipeline now looks like this:

```
Resend inbound webhook ──► src/app/api/webhook/resend/route.ts
                              │  tenant lookup by domain (src/lib/tenant.ts)
                              ▼
                        src/lib/pipeline.ts  processInboundEmail()
                              │  1. triage (src/lib/gemini.ts, Gemma 4 26B)
                              │  2. KB RAG (src/lib/rag.ts, pgvector, text-embedding-004)
                              │  3. draft reply
                              │  4. auto-send gate (src/lib/auto-resolve.ts + tenant.settings.autoSendEnabled)
                              ▼
                        Resend outbound (src/lib/resend.ts) / draft on ticket for dashboard
```

**Assets to keep:** multi-tenant schema with RLS (tenants, tenant_memberships), conversations / tickets / messages / outbound_messages, the tenant-scoped KB with pgvector, Resend domain provisioning plus DNS records, the auto-resolve audit table, the dashboard shell (tickets, KB, monitoring, settings), and confidence-gated auto-send.

**Gaps that block "resolve":**

| Gap | Where it shows up |
|-----|-------------------|
| No tools or actions; the model can only produce text | `rag.ts`, `pipeline.ts` |
| Policies are hardcoded per product slug (`strk`/`cashpile`/`dailypost`) | `auto-resolve.ts` `DEFAULT_POLICIES`, `getPolicy(slug)` |
| Runs synchronously inside a webhook request (timeouts, no retries) | `webhook/resend/route.ts` → `pipeline.ts` |
| Only one channel (email) | — |
| No customer identity or verification | — |
| No connector or credential model | — |
| Billing doesn't exist | — |

---

## 3. Target architecture

```
           ┌──────────────── CHANNELS (inbound/outbound) ────────────────┐
           │ Email (Resend) · Web chat widget · Shopify storefront widget │
           │ later: SMS/WhatsApp (Twilio), Instagram/Messenger, voice      │
           └───────────────┬──────────────────────────────────────────────┘
                           │ normalized ChannelMessage
                           ▼
 ┌───────────────────── EVENT BUS / DURABLE JOBS ─────────────────────┐
 │ inbound.message · connector.event · action.approved · sla.timer    │
 └───────────────┬────────────────────────────────────────────────────┘
                 ▼
 ┌──────────────────────── RESOLUTION ENGINE ─────────────────────────┐
 │ Identify customer → Triage → Select Procedure → Agent loop          │
 │   (plan → call tools → observe → decide) → Policy gate →            │
 │   Execute / Request approval → Reply → Confirm → Close + meter      │
 └──────┬───────────────────────────┬──────────────────────┬─────────┘
        │ read/write tools          │ knowledge            │ approvals
        ▼                           ▼                      ▼
 ┌──────────────┐          ┌────────────────┐     ┌──────────────────┐
 │ CONNECTORS   │          │ KNOWLEDGE      │     │ ASAP INBOX (UI)  │
 │ Shopify,     │          │ KB articles,   │     │ queue, approvals,│
 │ Stripe, Woo, │          │ synced docs,   │     │ action cards,    │
 │ shipping,    │          │ policies/SOPs  │     │ takeover, audit  │
 │ Calendly…    │          └────────────────┘     └──────────────────┘
 └──────────────┘
        ▲  connector webhooks (order updated, refund created…)
```

**Principles**

1. **Connectors are the product.** Each one ships typed tools, event subscriptions, a knowledge sync and default procedures. The engine stays the same whatever platforms are plugged in.
2. **Deterministic guardrails around a probabilistic model.** The LLM *proposes* tool calls. Code-level policy checks (amount caps, order state, identity verified) *authorize* them. The model never holds credentials and never decides its own permissions.
3. **Every action is auditable and idempotent,** with a recorded compensation (reversal) where one exists.
4. **Durable, async processing.** Webhooks only enqueue work. The engine runs in retryable jobs.

---

## 4. Core abstractions

### 4.1 Connector contract

Each connector is a module under `src/connectors/<name>/` that exports a manifest plus handlers. The interface is described here as a contract. Implementation comes later.

| Part | Purpose |
|------|---------|
| `manifest` | id, display name, category (commerce, payments, shipping, scheduling, CRM), auth type (OAuth2, API key), required scopes, version |
| `auth` | install/OAuth flow, token refresh, uninstall handling |
| `tools[]` | typed tools: `name`, description for the LLM, JSON-schema input/output, `kind: read \| write`, `riskTier`, `idempotencyKey(input)`, optional `compensate` tool |
| `identity` | how to find a customer from email, phone or order number, and what counts as verification |
| `events[]` | webhook topics to subscribe to, plus a normalizer into `connector_events` |
| `knowledgeSync` | optional: pull policies, FAQs, product catalog and shipping/return policies into the KB |
| `procedures[]` | default playbooks the connector enables (e.g. "WISMO", "Cancel unfulfilled order") |
| `limits` | rate limits and backoff rules for the external API |

### 4.2 Channel contract

`src/channels/<name>/` covers inbound normalization into a `ChannelMessage` (tenant, channel, external thread id, sender identity, text/html, attachments), outbound send, delivery-status webhooks, and threading rules. The current Resend code moves behind this contract unchanged in behaviour.

### 4.3 Procedures (SOPs)

A **procedure** is a tenant-editable playbook: trigger intents, required facts, allowed tools, policy limits, and reply style. Example:

> **Cancel order:** Trigger intents `cancel_order`. Require a verified customer and an order in an `UNFULFILLED` state, placed less than 12h ago. Tools: `shopify.get_order`, `shopify.cancel_order` (refund to original payment). Auto-execute if total ≤ $150, else require approval. Reply template: confirmation with refund ETA.

Procedures give merchants control in plain language, give the model structure, and give policy code something deterministic to enforce. Each connector ships defaults, and the merchant can edit them in the UI.

### 4.4 Policy engine

This replaces the hardcoded `DEFAULT_POLICIES` in `auto-resolve.ts` with per-tenant, DB-stored rules evaluated in code *before* any write tool runs:

- Global switches: autonomy on/off per tier, business hours, channels.
- Per tool: max amount per action, max per customer per 30 days, daily tenant cap, allowed order states.
- Preconditions: identity verified, triage confidence ≥ X, no open dispute or chargeback, customer not flagged.
- Outcome: `allow` / `require_approval(reason)` / `deny(reason)`. Every decision is written to the audit log.

---

## 5. Data model (new and changed tables)

Everything is tenant-scoped with RLS through `tenant_memberships`, matching the existing pattern.

| Table | Key columns | Notes |
|-------|-------------|-------|
| `integrations` | tenant_id, connector_id, status (`active`/`error`/`revoked`), external_account_id (e.g. shop domain), scopes, config jsonb, installed_at | One row per connected platform |
| `integration_secrets` | integration_id, encrypted access/refresh tokens, expires_at | Encrypted with Supabase Vault or app-level envelope encryption. Never readable by the browser |
| `channels` | tenant_id, type (`email`/`webchat`/`shopify_widget`/`sms`), address/config, status | Replaces the old inbox mapping |
| `customers` | tenant_id, display name, primary email/phone, metadata | ASAP's unified customer record |
| `customer_identities` | customer_id, source (`email`/`shopify`/`stripe`…), external_id, verified_at, verification_method | Links one person across platforms |
| `connector_events` | tenant_id, integration_id, topic, external_id, payload, processed_at | Raw inbound events, deduplicated on (integration, topic, external_id) |
| `procedures` | tenant_id, connector_id nullable, name, trigger_intents[], spec jsonb, enabled, version | Seeded from connector defaults |
| `policies` | tenant_id, scope (global/tool/procedure), rules jsonb, version | Versioned. The audit log references the version used |
| `agent_runs` | ticket_id, procedure_id, model, prompt/response token counts, status, trace jsonb, started/finished | One row per engine run, for debugging and evals |
| `actions` | tenant_id, ticket_id, agent_run_id, integration_id, tool, input jsonb, risk_tier, policy_decision, status (`proposed`/`awaiting_approval`/`approved`/`executing`/`succeeded`/`failed`/`compensated`/`rejected`), idempotency_key UNIQUE, result jsonb, approved_by, executed_at | The core ledger |
| `resolutions` | ticket_id, outcome (`resolved_auto`/`resolved_assisted`/`escalated`/`reopened`), resolved_at, billable bool, reopen_deadline | Billing and metrics source |
| `usage_events` | tenant_id, type (`resolution`/`ai_message`/`action`), quantity, ref_id, billed_at | Feeds billing |
| `kb_sources` | tenant_id, type (manual/url/shopify_policies/help_center), sync status | Knowledge ingestion beyond manual articles |

Changes to existing tables:
- `tickets`: add `customer_id`, `channel_id`, `procedure_id`, `status` lifecycle (`new` → `in_progress` → `awaiting_customer` / `awaiting_approval` → `resolved` / `escalated` → `closed`), and `intent`.
- `messages`: add `channel_id`, `external_message_id`, `author_type` (`customer`/`ai`/`agent`/`system`). Keep the existing `incoming`/`outgoing` direction values. (Note: migration 008 tried to add `inbound`/`outbound`, but it's a no-op because the column already exists, so `incoming`/`outgoing` is what's actually enforced.)
- `tenants.settings`: move policy-like keys (`autoSendEnabled`, tone) into `policies`, and keep only branding there.

---

## 6. Resolution engine

### 6.1 Flow per inbound message

1. **Ingest:** the channel webhook verifies its signature, deduplicates on `external_message_id`, writes the message, enqueues `inbound.message`, and returns 200 immediately.
2. **Identify:** match the sender to a `customer` through `customer_identities`. If commerce connectors exist, look the customer up there (by email, or by an order number pulled from the text).
3. **Triage:** intent, urgency, sentiment, language, and the entities mentioned (order #, amount, product). This extends the existing `triageTicket`.
4. **Route:** pick a procedure by intent. If none matches, fall back to knowledge-only answering (today's RAG). On safety triggers (legal threat, chargeback, abuse, self-harm), escalate to a human right away.
5. **Agent loop** (bounded, e.g. ≤ 8 tool calls and a wall-clock limit):
   - Context: procedure spec, customer profile, recent conversation, relevant KB, and **only the tools allowed by the procedure**.
   - The model calls read tools freely. Write tools go through `proposeAction`, which runs the policy engine and returns `allow` / `require_approval` / `deny`.
   - `allow`: execute with the idempotency key and record the result. `require_approval`: park the ticket in `awaiting_approval` and notify. `deny`: the model must reply without the action, or escalate.
6. **Reply:** compose the customer message from **actual tool results** (never from what the model expected to happen) and send it on the originating channel.
7. **Confirm and close:** set the ticket to `awaiting_customer` and start the reopen timer. If the customer replies, re-enter the loop with history. If the timer expires, mark it `resolved` and emit a billable `usage_event`.

### 6.2 Safety and correctness

- **Identity verification before any write:** the sender's email matches the order email, or a one-time code or magic link is sent to the address on file for chat and SMS. Verification status is stored on `customer_identities`.
- **Prompt-injection containment:** customer text is untrusted. Tool permissions come only from the procedure and policy, never from message content. Tool inputs are validated against JSON schema and cross-checked (e.g. the order belongs to the verified customer) in code.
- **Idempotency:** `actions.idempotency_key` is unique. Retries never double-refund.
- **Compensation:** write tools declare their reversal (`cancel_refund` where the platform supports it, or `restock`). An admin "undo" goes through the same ledger.
- **Kill switch:** a per-tenant and global "pause autonomy" flag, checked on every action.
- **Grounding rule:** replies that state facts (dates, amounts, tracking status) must come from tool output in the same run. Enforced by a verification pass before sending.

### 6.3 Models

- Keep a small **model router**: a cheap model (current Gemma 4 26B) for triage and classification, and a stronger model with reliable function calling for the agent loop and any T1/T2 action. Choosing the model is an open decision (§14), and the router keeps it swappable per tenant or tier.
- Log every run to `agent_runs` so we can build an **eval set**: replay historical tickets against new prompts or models before shipping changes.

### 6.4 Job infrastructure

Next.js route handlers aren't suitable for multi-step agent loops with approvals and timers. **Recommendation:** a durable workflow runner (Inngest or Trigger.dev), because it gives steps, retries, `sleep`/`waitForEvent` (approval and reopen windows) and observability out of the box. Alternative: Supabase Queues (pgmq) plus a separate worker, which means fewer vendors but more code. Decision needed (§14).

---

## 7. Connectors roadmap

### 7.1 Shopify (first; also a distribution channel)

**Tools**

| Tool | Kind | Tier | Notes |
|------|------|------|-------|
| `find_customer` (email/phone) | read | T0 | |
| `list_orders` / `get_order` (incl. line items, financial and fulfillment status) | read | T0 | |
| `get_fulfillment_tracking` | read | T0 | Tracking numbers and carrier links, enriched by a shipping connector |
| `update_shipping_address` | write | T1 | Only if unfulfilled |
| `resend_order_confirmation` | write | T1 | |
| `create_discount_code` (single-use, capped) | write | T1 | Goodwill credit |
| `cancel_order` (+ refund, restock) | write | T2 | Only if unfulfilled |
| `create_refund` (full/partial, line items, shipping) | write | T2 | Capped by policy |
| `create_return` / `approve_return` | write | T2 | Shopify returns API |
| `create_draft_order` (replacement) | write | T2 | |
| `add_order_note` / `tag_order` | write | T1 | Writes ASAP context back to the merchant's admin |

**Events:** orders/create, orders/updated, orders/cancelled, fulfillments/create and update, refunds/create, customers/update, app/uninstalled. Plus the mandatory privacy webhooks: `customers/data_request`, `customers/redact`, `shop/redact`.

**Knowledge sync:** shop policies (refund, shipping, privacy, terms), product catalog (titles, descriptions, variants, inventory status), and pages/FAQ.

**Default procedures:** WISMO (where is my order), cancel unfulfilled order, change address, return/exchange request, damaged/missing item (photo request, then replacement or refund), discount/price-match question, product question (catalog RAG).

**App requirements:** embedded admin app (App Bridge plus Polaris-style UI) inside Shopify admin, OAuth with minimal scopes, Shopify Billing API for subscriptions and per-resolution usage charges, a theme app extension for the storefront chat widget, uninstall cleanup, and work toward the "Built for Shopify" standard (performance, UX, review).

### 7.2 Next connectors, in order

| # | Connector | Why | Key tools |
|---|-----------|-----|-----------|
| 2 | **Shipping tracking** (AfterShip or EasyPost/Shippo) | WISMO is the biggest e-commerce ticket type. Real-time carrier status and exception detection | `get_tracking`, `detect_delay` |
| 3 | **Stripe** | Opens ASAP to SaaS and subscription businesses outside Shopify | `find_customer`, `list_invoices`, `refund_charge`, `cancel/pause_subscription`, `update_payment_method_link`, `apply_coupon` |
| 4 | **WooCommerce** | Second commerce platform, proves connector portability | Mirrors the Shopify tool set |
| 5 | **Subscription apps** (Recharge, Skio) | Subscription changes are a large share of DTC support tickets | `skip`, `swap`, `pause`, `cancel_with_retention_offer` |
| 6 | **Scheduling** (Calendly, Cal.com) | Service businesses | `find_booking`, `reschedule`, `cancel` |
| 7 | **Help center / docs import** (URL crawler, Notion, Google Docs) | Knowledge for every vertical | sync only |
| 8 | **Returns platforms** (Loop, ReturnLogic) | Larger merchants | `create_return`, `get_return_status` |

**Rule for adding a connector:** each new one should be "manifest + tools + default procedures" with **no engine changes**. If a connector needs engine changes, the abstraction is wrong. Fix the abstraction first.

### 7.3 Becoming the platform (the "Shopify" layer)

- **Phase A (internal SDK):** all first-party connectors use the same contract, with a test harness (recorded fixtures, sandbox accounts, contract tests).
- **Phase B (custom actions):** tenants define their own HTTP tools (endpoint, auth, schema, risk tier) without code, for in-house systems.
- **Phase C (partner marketplace):** third parties publish connectors and procedures, with a review process, sandboxing (connector code runs isolated with scoped tokens), versioning and revenue share. This is the actual "Shopify" move, and it only comes after real merchant demand.

---

## 8. Channels

| Order | Channel | Notes |
|-------|---------|-------|
| 1 | Email (Resend) | Exists. Move it behind the channel contract, add threading via `In-Reply-To`/`References` headers, and support attachments |
| 2 | Web chat widget | Embeddable JS snippet. Real-time over Supabase Realtime. Verify identity by OTP before writes |
| 3 | Shopify storefront widget | The web widget packaged as a theme app extension. Logged-in Shopify customers are auto-identified |
| 4 | SMS / WhatsApp (Twilio) | After the core is stable |
| 5 | Social DMs and voice | Later, as demand shows |

---

## 9. ASAP Inbox (native agent UI, replacing Chatwoot)

Built on the existing `src/app/dashboard/*` shell:

- **Queue views:** Needs approval · Escalated · Awaiting customer · Resolved (filters by channel, intent, connector).
- **Conversation view:** a single timeline of messages, AI reasoning summary, tool calls and **action cards** (e.g. "Refund $42.10 on #1042: Approve / Edit / Reject"), plus customer sidebar data pulled live from connectors.
- **Takeover:** a human can pause the AI on a ticket, reply manually, or execute any tool with the same policy checks and audit trail.
- **Approvals everywhere:** in-app, email digest, and in the Shopify admin embed. Slack/mobile notifications later.
- **Configuration:** connectors marketplace page, procedure editor (plain-language plus structured limits), policy editor with "simulate on last 50 tickets", KB sources.
- **Monitoring:** extend the existing page with resolution rate, auto-resolution rate, approval latency, reopen rate, $ refunded by AI, and CSAT.

The same UI is rendered standalone (goASAP.ai) and embedded in Shopify admin. Shopify session auth is mapped to an ASAP tenant on install.

---

## 10. Onboarding: "support department in 10 minutes"

1. Sign up (standalone) or install the Shopify app (the tenant is auto-created from the shop).
2. Connect channels: forward `support@` email to an ASAP address, or verify the domain via the existing DNS flow. Turn on the chat widget.
3. Connect platforms: Shopify, Stripe, etc. Knowledge sync starts automatically.
4. Review default procedures and policies. **All write actions start in "require approval" mode.**
5. **Shadow mode:** for the first N tickets, ASAP proposes but doesn't send. The merchant sees "would have resolved X%".
6. A "trust dial" moves procedures to auto as approval accuracy proves out (e.g. suggest auto after 20 consecutive approvals without edits).

---

## 11. Pricing and metering

- **Primary metric:** billable resolution, as defined in §1 (not reopened in the window, and not handled entirely by a human).
- Plans: free tier (e.g. 25 resolutions/month), then per-resolution pricing below incumbents, plus an optional base fee for seats or advanced connectors. Shopify merchants are billed through the Shopify Billing API (usage charges), and standalone tenants through Stripe.
- `usage_events` → nightly aggregation → billing provider. Merchants see a resolution ledger (every billed item links to its ticket).
- Exact prices are a business decision (§14). This plan only makes sure the metering exists.

---

## 12. Security, privacy, compliance

- Encrypted OAuth tokens. Minimal scopes per connector. Tokens only used server-side inside job workers.
- RLS on every new table. Service-role use limited to workers.
- PII: redact payment details from LLM context, set retention policies per tenant, and implement the Shopify privacy webhooks plus a general "delete customer" flow.
- Audit log is append-only (actions, policy decisions, approvals, config changes).
- Abuse controls: per-customer action caps, refund velocity alarms, global kill switch.
- Later, for larger customers: SOC 2 readiness (access reviews, change management, vendor list).

---

## 13. Phased delivery

Sizes assume 1–2 engineers. **S** ≈ under 1 week, **M** ≈ 1–3 weeks, **L** ≈ 3–6 weeks.

### Phase 0: Foundation cleanup (M)
- Finish Chatwoot removal (in progress in the working tree), and drop remaining columns and env vars.
- Move processing to durable jobs. The Resend webhook only enqueues work.
- Replace slug-based `DEFAULT_POLICIES` with DB `policies` (keep current values as the seeded defaults).
- Put the email channel behind the channel contract.
- **Done when:** an email arrives, the job runs, a draft or auto-send happens exactly as today, retries are safe, and nothing references Chatwoot or hardcoded product slugs.

### Phase 1: Engine and connector framework (L)
- Connector contract, `integrations`, `integration_secrets`, `actions`, `agent_runs`, `customers`, `customer_identities`, `procedures`.
- Agent loop with tool calling, policy engine, approval flow, idempotency.
- Inbox: action cards and approval queue.
- A built-in "mock commerce" connector for tests and demos.
- **Done when:** with the mock connector, a "cancel my order" email produces a proposed action, a human approves it, it executes exactly once even if retried, the customer gets a reply grounded in the result, and the audit trail is complete.

### Phase 2: Shopify connector and app (L)
- OAuth install, embedded admin, Shopify tools (T0/T1 first, then T2), events, privacy webhooks, knowledge sync, default procedures, shadow mode.
- **Done when:** on a dev store, WISMO, address change and cancel-unfulfilled are handled end-to-end. Refunds work with approval. Uninstall cleans up. The app passes Shopify's review checklist.

### Phase 3: Resolution loop and billing (M)
- Reopen window, `resolutions`, `usage_events`, Shopify Billing usage charges plus Stripe billing for standalone tenants, metrics dashboard.
- **Done when:** a resolved ticket bills once, a reopened ticket doesn't bill, and the merchant ledger matches the invoices.

### Phase 4: Chat widget and storefront (M)
- Web widget, Shopify theme extension, OTP identity verification.
- **Done when:** a logged-out storefront visitor verifies by email code and the AI cancels their unfulfilled order inside the chat.

### Phase 5: Second and third connectors (M each)
- Shipping tracking, then Stripe. **Done when:** each ships with zero engine changes and its default procedures pass the eval set.

### Phase 6: Platform (L+)
- Custom HTTP actions, then a public connector SDK, then a partner marketplace.

**Launch gate (end of Phase 3):** public listing on the Shopify App Store with 5–10 design-partner merchants already in shadow or auto mode.

---

## 14. Success metrics

| Metric | Target at launch gate |
|--------|----------------------|
| Auto-resolution rate (T0/T1, no human) | ≥ 40% of e-commerce tickets |
| Assisted resolution (approved T2) approval-without-edit rate | ≥ 85% |
| Wrong-action rate (actions later reverted or flagged) | < 0.5% |
| Reopen rate on AI-resolved tickets | < 8% |
| Median time-to-resolution (auto) | < 2 min |
| Onboarding to first resolved ticket | < 15 min |

---

## 15. Decisions (2026-11-09)

1. **Models: split by risk, behind the model router.**
   - Triage, classification and language detection: keep **Gemma 4 26B** (cheap and fast; already wired).
   - Agent loop for read-only (T0) answers: **Claude Haiku 5.5**.
   - Any run that may call a write tool (T1/T2: refunds, cancels, address changes): **Claude Sonnet 5.5**. Strong, reliable tool calling matters more than token cost here, because a wrong refund costs more than a whole month of tokens.
   - Optional escalation path for hard multi-step cases: Claude Opus 5.5, off by default.
   - The model never authorizes. The policy engine does (§4.4), so swapping models can't loosen guardrails.
   - Gate: before launch, run an eval bake-off on replayed historical tickets (tool-call accuracy, wrong-action rate, cost per resolution), and switch models if results disagree.
2. **Job runner: keep the in-house Postgres queue (already built), no vendor for now.** It costs $0 extra, already has retries/backoff/dedupe, and covers the plan's needs:
   - approval → enqueue an `action.execute` job
   - reopen window → a job with `run_at = now() + 72h`
   - SLA timers → delayed jobs

   Revisit **Inngest** (preferred over Trigger.dev: it calls our own endpoints, so compute stays on our host, and it bills per step rather than per compute-second while an LLM call waits) only if we need fan-out, a step-level replay UI, or volume beyond about 50k jobs/day.
3. **Go-to-market: Shopify-first.** The engine and connectors stay platform-neutral. Standalone signup keeps working but isn't marketed until Stripe/WooCommerce connectors ship (Phase 5).
4. **Pricing: Shopify-first via the Shopify Billing API** (recurring plan plus usage charges with a capped amount).
   - Free install and a 14-day shadow-mode trial.
   - Starter: small monthly base plus a resolution allowance.
   - Then per billable resolution (§1), priced below incumbents' per-resolution AI pricing.
   - T0/T1 and T2 resolutions cost the same at launch, to keep it simple.

   Exact numbers get set after checking current competitor pricing and design-partner cost-per-resolution data.
5. **Identity verification: best-practice tiers** (enforced in code, never taken from message content):
   - **T0 (read order info):** the email sender matches the order's customer email, **and** inbound SPF/DKIM/DMARC passes. Otherwise require order number plus the email or postcode on the order. In chat: order number plus email, then an OTP. Mask PII in replies (no full address or phone).
   - **T1 (low-risk writes):** a verified identity is required:
     - email channel: sender matches and authentication passes
     - chat: a 6-digit OTP to the email on file (10-minute expiry, single use, 5 attempts, rate-limited)
     - Shopify storefront: a logged-in customer account session

     A verification stays valid for 24h per conversation.
   - **T2 (money/irreversible):** T1 verification, plus refunds only to the original payment method, plus per-customer and tenant caps, plus a step-up OTP if any signal is off (auth fail, new device or IP, mismatch, velocity).
   - **Never by AI:** changing a customer's email, phone or payment method; changing the address after fulfillment; gift-card or store-credit to a different person. These always go to a human.
   - Every verification is stored in `customer_identities.verification_method` and the audit log.
6. **Hosting: Vercel (paid plan) for the Next.js app and `/api/jobs/run`, triggered every minute by Supabase `pg_cron` + `pg_net`.**
   - Two vendors in total (Vercel + Supabase). This is the standard host for embedded Shopify Next.js apps, and longer function durations are available on paid plans.
   - Move the job runner to a dedicated always-on worker (Railway/Fly) only if agent runs regularly approach function time limits.

---

## 16. Risks

| Risk | Mitigation |
|------|------------|
| Shopify Inbox / Shopify's own AI keeps improving at free FAQ answering | Compete on **actions and resolution across platforms**, not on answering questions |
| Incumbents (Gorgias, Intercom Fin, etc.) already have action features | Narrow wedge, lower per-resolution price, faster onboarding, multi-platform beyond Shopify |
| A wrong refund or cancel destroys trust | Approval-first defaults, caps, shadow mode, idempotency, compensations, kill switch |
| Connector maintenance burden grows with the catalog | Strict contract, contract tests, recorded fixtures, version pinning, then partners carry the long tail |
| LLM cost per resolution | Model router, cached KB context, short loops, cheap triage |
| Prompt injection that triggers actions | Permissions in code only, schema validation, ownership cross-checks |

---

## 17. Explicitly out of scope

- **Chatwoot, in any form** (inbox, provisioning, webhooks, data model). ASAP owns its own inbox.
- Voice channel, social DMs and the partner marketplace before Phase 6.
- Fine-tuning work (see `docs/customer-fine-tuning-plan.md`). It's separate, and the eval set from `agent_runs` will feed it later.
