# ASAP — AI Support Anytime Platform

An AI-first customer support platform. Incoming emails arrive via Resend, are triaged by AI, matched against a per-tenant RAG knowledge base, and a grounded draft reply is generated for review in the dashboard. Visit us at [goASAP.ai](https://goASAP.ai).

## How It Works

1. Customer emails `support@tenant.com` → Resend receives it and fires a signed webhook
2. ASAP verifies the Svix signature, resolves the tenant by recipient domain, and threads the message into a conversation (reusing the open ticket when it is a follow-up)
3. AI triage classifies the message with Gemma 4 26B
4. RAG searches the tenant-scoped knowledge base (pgvector) and generates a grounded draft reply
5. The draft is stored on the ticket (`auto_reply_text`) and pre-filled in the dashboard for human review
6. Auto-send via Resend is **off by default** — it only fires when a tenant opts in with `settings.autoSendEnabled === true` and the auto-resolve policy agrees. Follow-ups never auto-send.

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Database**: Supabase (PostgreSQL + pgvector for RAG)
- **AI Triage**: Gemma 4 26B via Gemini API
- **Embeddings**: Google gemini-embedding-2 (768-dim)
- **Email**: Resend (inbound webhooks + outbound replies)
- **Validation**: Zod

## Getting Started

1. Copy `.env.example` to `.env.local` and fill in your environment variables
2. Install dependencies: `npm install`
3. Run the development server: `npm run dev`
4. Open [http://localhost:3000](http://localhost:3000)

## Project Structure

```
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── webhook/resend/route.ts  # Inbound email webhook
│   │   │   ├── send/route.ts            # Outbound reply via Resend
│   │   │   └── kb/route.ts              # KB CRUD API
│   │   ├── dashboard/                   # Ticket, KB, settings UI
│   │   ├── layout.tsx
│   │   └── page.tsx                     # Landing page
│   ├── lib/
│   │   ├── pipeline.ts      # Channel-agnostic AI pipeline (triage → KB → draft)
│   │   ├── db.ts            # Supabase data layer
│   │   ├── embeddings.ts    # Google gemini-embedding-2
│   │   ├── gemini.ts        # AI triage (Gemma 4 26B)
│   │   ├── rag.ts           # RAG search + reply generation
│   │   ├── auto-resolve.ts  # Auto-resolve policy
│   │   ├── rate-limit.ts    # Webhook/API rate limiting
│   │   ├── resend.ts        # Resend client (send + domains)
│   │   └── supabase.ts      # Supabase client singleton
│   └── types/
│       └── triage.ts        # Triage types
├── scripts/
│   └── seed-kb.mjs          # Seed KB articles
├── supabase/migrations/
│   └── ...                  # Schema migrations
├── .env.example
└── package.json
```

## API Endpoints

### Webhook: `POST /api/webhook/resend`
Receives Resend inbound email events (`email.received`). Verifies the Svix signature, resolves the tenant by recipient domain, fetches the email body from the Resend receiving API (`RESEND_API_KEY` is required for body retrieval), deduplicates retries by `message_id`, threads the message into a conversation, and runs the AI pipeline. Other event types are ignored with a 200. Each decision is recorded in `resolve_audit`.

### Send: `POST /api/send`
Sends an outbound reply to a customer through Resend and logs it to `outbound_messages`.

### Knowledge Base: `/api/kb`
Requires a signed-in workspace member; all operations are scoped to the caller's tenant (optional `tenant_id` must be one they belong to). Seed articles with `node --env-file=.env.local scripts/seed-kb.mjs`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/kb` | List the caller's tenant articles |
| POST | `/api/kb` | Create article (auto-embeds) |
| PUT | `/api/kb?id=<uuid>` | Update article (re-embeds on content change) |
| DELETE | `/api/kb?id=<uuid>` | Delete article |

## Background Jobs

Slow work (triage → KB → draft → auto-resolve) does not run inside the inbound webhook. The webhook enqueues a durable job in the Postgres `jobs` table and returns `202` immediately; a worker drains the queue.

- **Queue**: `jobs` table + `claim_jobs()` SQL function (atomic `FOR UPDATE SKIP LOCKED` claims, stale-lock reclaim, exponential backoff, `dead` after `max_attempts`).
- **Runner**: `POST /api/jobs/run` (GET also supported for platform crons) claims and runs due jobs within a ~45s budget. Auth is `Authorization: Bearer <JOBS_SECRET>` (falls back to `CRON_SECRET`).
- **Local dev**: `node --env-file=.env.local scripts/run-jobs.mjs` polls the runner every `JOBS_POLL_INTERVAL_MS` (default 5000).
- **Production**: a scheduler must call `/api/jobs/run` about once a minute — Vercel Cron, Supabase `pg_cron` + `pg_net`, or any external cron. The webhook also fires a best-effort `kickJobRunner()` nudge, but the scheduler is the backstop.
- **Pluggable runner**: the queue is plain Postgres and vendor-neutral; swapping in Inngest or another runner later only changes who calls the runner, not the queue or handlers.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key (server-side writes) |
| `GOOGLE_API_KEY` | Google API key (Gemini + embeddings) |
| `RESEND_API_KEY` | Resend API key for sending and fetching received email bodies |
| `RESEND_WEBHOOK_SECRET` | Resend/Svix webhook signing secret |
| `APP_URL` | App URL for callbacks |

## Phase Status

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 0 | Email Ingestion via Resend | Done |
| Phase 1 | AI Triage: LLM Ticket Classification | Done |
| Phase 2 | RAG Knowledge Base + AI Draft Replies | Done |
| Phase 3 | Auto-Resolve: End-to-End Autonomous Handling | Done |
| Phase 4 | Dashboard: Analytics + Review Queue UI | Backlog |
| Phase 5 | Productise: Multi-Tenant SaaS | Backlog |
