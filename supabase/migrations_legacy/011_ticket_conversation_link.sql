-- ASAP — Migration 011: Link tickets to conversations + inbound dedup
-- Additive only — safe to apply now.
-- Paste into: Supabase Dashboard → SQL Editor → Run

-- ── Link tickets to the custom conversations engine ───────────────────────────
alter table tickets
  add column if not exists conversation_id uuid references conversations(id) on delete set null;

create index if not exists tickets_conversation_id_idx on tickets(conversation_id);

-- ── Deduplicate inbound webhooks by Resend message_id ─────────────────────────
alter table inbound_messages
  add column if not exists message_id text;

create unique index if not exists inbound_messages_message_id_key
  on inbound_messages(message_id)
  where message_id is not null;
