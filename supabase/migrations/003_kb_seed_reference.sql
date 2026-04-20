-- ASAP Phase 2 — KB Seed Data
-- Sample knowledge base articles for STRK, Cashpile, TheDailyPost
-- Run AFTER: 002_knowledge_base.sql
-- Note: embeddings are null here — they will be computed on first API insertion
--       OR you can seed via the API: POST /api/kb with each article.
-- This file is for documentation/reference only.

-- For production seeding, use the seed script:
--   node scripts/seed-kb.mjs

-- ── STRK Articles ─────────────────────────────────────────────────────────────

-- "How do I create my first STRK link?"
-- "What analytics does STRK provide?"
-- "Can I use a custom domain with STRK?"
-- "How do I delete a link?"
-- "STRK pricing and plans"

-- ── Cashpile Articles ─────────────────────────────────────────────────────────

-- "How does Cashpile work?"
-- "What payment methods does Cashpile support?"
-- "How do I withdraw my earnings?"
-- "Is my data secure with Cashpile?"
-- "Cashpile refund policy"

-- ── TheDailyPost Articles ────────────────────────────────────────────────────

-- "How does TheDailyPost generate content?"
-- "Can I customise the AI tone and style?"
-- "How often is content published?"
-- "How do I connect my social accounts?"
-- "TheDailyPost subscription and billing"
