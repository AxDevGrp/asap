-- ASAP — Migration 012: Remove Chatwoot columns
--
-- ⚠️  DESTRUCTIVE MIGRATION — DO NOT AUTO-APPLY.
-- This drops all Chatwoot-related columns and any indexes/constraints on them.
-- Run this MANUALLY in the Supabase SQL Editor ONLY after taking a full backup
-- of the database. Data in these columns is permanently lost.
--
-- Outbound email now flows through Resend and inbound email through
-- /api/webhook/resend; tickets link to conversations via tickets.conversation_id
-- (added by migration 011).

-- ── tickets ───────────────────────────────────────────────────────────────────
drop index if exists tickets_chatwoot_convo_id_key;
alter table tickets
  drop column if exists chatwoot_inbox_id,
  drop column if exists chatwoot_convo_id;

-- ── messages ──────────────────────────────────────────────────────────────────
alter table messages
  drop column if exists chatwoot_message_id;

-- ── tenants ───────────────────────────────────────────────────────────────────
drop index if exists tenants_inbox_idx;
alter table tenants
  drop column if exists chatwoot_account_id,
  drop column if exists chatwoot_inbox_id;

-- ── outbound_messages ─────────────────────────────────────────────────────────
alter table outbound_messages
  drop column if exists chatwoot_convo_id;

-- ── resolve_audit ─────────────────────────────────────────────────────────────
alter table resolve_audit
  drop column if exists chatwoot_convo_id;
