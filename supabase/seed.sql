-- ASAP — Seed data
-- Runs automatically after migrations via `supabase db reset` (local only).
-- On a hosted project, paste this file into the SQL editor once.
-- Idempotent: re-running is safe.

-- ── Tenants ──────────────────────────────────────────────────────────────────
-- Only the goASAP tenant for now. STRK, Cashpile and The Daily Post are left
-- out on purpose (not going live yet); add them back here if that changes.
-- No user IDs here; tenant_memberships are created when users sign up / are
-- added, so these seeds never reference auth.users rows that may not exist.
insert into tenants (name, slug, domain) values
  ('ASAP Platform', 'goasap', 'goasap.ai')
on conflict (slug) do nothing;
