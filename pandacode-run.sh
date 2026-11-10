#!/bin/sh
# Run the ASAP dashboard locally (Next.js dev server).
# Needs .env.local filled in (Supabase, OpenRouter, Resend).
# pandacode-preview: http://127.0.0.1:3000
cd "$(dirname "$0")" || exit 1
exec npm run dev -- -p 3000
