-- ASAP — Migration 009: Fix messages table + create inbound_messages
-- Paste into: Supabase Dashboard → SQL Editor → Run

-- ── Fix legacy messages table (make Chatwoot field nullable) ─────────────────
ALTER TABLE messages ALTER COLUMN chatwoot_message_id DROP NOT NULL;

-- ── Create dedicated inbound_messages table (clean, no Chatwoot deps) ────────
CREATE TABLE IF NOT EXISTS inbound_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_email      text NOT NULL,
  subject         text NOT NULL DEFAULT '(No Subject)',
  body_text       text NOT NULL DEFAULT '',
  body_html       text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbound_messages_conversation_idx ON inbound_messages(conversation_id);
CREATE INDEX IF NOT EXISTS inbound_messages_tenant_idx       ON inbound_messages(tenant_id);

ALTER TABLE inbound_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access_inbound" ON inbound_messages
  AS PERMISSIVE FOR ALL TO service_role USING (true);
