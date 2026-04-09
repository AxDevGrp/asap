# ASAP — AI Support Anytime Platform

An AI-first customer support platform. Visit us at [goASAP.ai](https://goASAP.ai).

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Database**: Supabase
- **Email**: Resend
- **Validation**: Zod

## Getting Started

1. Copy `.env.example` to `.env.local` and fill in your environment variables
2. Install dependencies: `npm install`
3. Run the development server: `npm run dev`
4. Open [http://localhost:3000](http://localhost:3000)

## Project Structure

```
├── src/
│   ├── app/              # Next.js App Router
│   │   ├── layout.tsx    # Root layout
│   │   ├── page.tsx      # Home page
│   │   └── globals.css   # Global styles
│   └── lib/              # Utility libraries
│       ├── supabase.ts   # Supabase client
│       └── resend.ts     # Resend client
├── .env.example          # Environment variables template
├── next.config.ts        # Next.js configuration
├── tailwind.config.ts    # Tailwind CSS configuration
└── tsconfig.json         # TypeScript configuration
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anonymous key |
| `RESEND_API_KEY` | Resend API key for email |
| `CHATWOOT_API_URL` | Chatwoot instance URL |
| `CHATWOOT_API_KEY` | Chatwoot API key |
