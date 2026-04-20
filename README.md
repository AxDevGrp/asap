# ASAP — AI Support Anytime Platform

An AI-first customer support platform. Incoming emails are triaged by AI, matched against a per-product RAG knowledge base, and draft replies are posted for human review — all within Chatwoot. Visit us at [goASAP.ai](https://goASAP.ai).

## How It Works

1. Customer emails `support@product.com` → lands in Chatwoot inbox
2. Chatwoot webhook fires → ASAP triages with Gemma 4 26B
3. RAG pipeline searches product-specific knowledge base (pgvector)
4. AI generates a grounded draft reply → posted as **private note** in Chatwoot
5. Human (k3nz0) reviews the draft and sends it to the customer
6. Follow-up messages also get AI draft replies with full conversation context

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Database**: Supabase (PostgreSQL + pgvector for RAG)
- **AI Triage**: Gemma 4 26B via Gemini API
- **Embeddings**: Google text-embedding-004 (768-dim)
- **Inbox**: Chatwoot (unified inbox for STRK, Cashpile, DailyPost)
- **Email**: Resend (initialized, not yet in outbound path)
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
│   │   │   ├── webhook/chatwoot/route.ts  # Main webhook handler
│   │   │   └── kb/route.ts                # KB CRUD API
│   │   ├── layout.tsx
│   │   ├── page.tsx                       # Landing page (stub)
│   │   └── globals.css
│   ├── lib/
│   │   ├── chatwoot.ts      # Chatwoot API client (reply, note, labels, status)
│   │   ├── config.ts        # Inbox→product mapping
│   │   ├── db.ts            # Supabase data layer (KB, tickets, messages)
│   │   ├── embeddings.ts    # Google text-embedding-004
│   │   ├── gemini.ts        # AI triage (Gemma 4 26B)
│   │   ├── rag.ts           # RAG search + reply generation
│   │   ├── resend.ts        # Resend client (initialized, not yet used)
│   │   └── supabase.ts      # Supabase client singleton
│   └── types/
│       └── chatwoot.ts      # TypeScript types for Chatwoot payloads + triage
├── scripts/
│   └── seed-kb.mjs          # Seed 15 KB articles (5 per product)
├── supabase/migrations/
│   ├── 001_initial_schema.sql       # tickets + messages tables
│   ├── 002_knowledge_base.sql       # knowledge_base table + pgvector RPC
│   └── 003_kb_seed_reference.sql    # Reference for seed articles
├── .env.example
├── next.config.mjs
├── tailwind.config.ts
└── tsconfig.json
```

## API Endpoints

### Webhook: `POST /api/webhook/chatwoot`
Receives Chatwoot webhook events. Supports:
- `conversation_created` — Triages, saves ticket, searches KB, generates draft reply as private note
- `message_created` — Logs follow-up, generates contextual draft reply

### Knowledge Base: `/api/kb`
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/kb?product=strk` | List articles (optional product filter) |
| POST | `/api/kb` | Create article (auto-embeds) |
| PUT | `/api/kb?id=<uuid>` | Update article (re-embeds on content change) |
| DELETE | `/api/kb?id=<uuid>` | Delete article |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key |
| `GOOGLE_API_KEY` | Google API key (Gemini + embeddings) |
| `RESEND_API_KEY` | Resend API key for email |
| `CHATWOOT_API_URL` | Chatwoot instance URL |
| `CHATWOOT_API_KEY` | Chatwoot API key |
| `CHATWOOT_WEBHOOK_SECRET` | Webhook signature secret (optional, verified if set) |
| `APP_URL` | App URL for callbacks |

## Phase Status

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 0 | Chatwoot on Railway + Email Ingestion | Done |
| Phase 1 | AI Triage: LLM Ticket Classification | Done |
| Phase 2 | RAG Knowledge Base + AI Draft Replies | Done |
| Phase 3 | Auto-Resolve: End-to-End Autonomous Handling | Backlog |
| Phase 4 | Dashboard: Analytics + Review Queue UI | Backlog |
| Phase 5 | Productise: Multi-Tenant SaaS | Backlog |
