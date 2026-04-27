-- Migration: Update tickets table for Resend webhook support
-- Makes Chatwoot columns nullable and adds new columns for email-based tickets

-- Add missing columns for the new goASAP architecture
alter table tickets
  add column if not exists tenant_id uuid references tenants(id) on delete set null,
  add column if not exists subject text,
  add column if not exists body text,
  add column if not exists auto_resolved boolean default false;

-- Make Chatwoot legacy columns nullable (we're moving away from Chatwoot dependency)
alter table tickets
  alter column chatwoot_inbox_id drop not null,
  alter column chatwoot_convo_id drop not null,
  alter column product drop not null;

-- Drop the unique constraint on chatwoot_convo_id (not needed for email-based tickets)
-- Note: This may fail if the constraint has a different name; run manually in Supabase if needed
-- alter table tickets drop constraint if exists tickets_chatwoot_convo_id_key;

-- Add index for tenant lookups
create index if not exists tickets_tenant_id_idx on tickets(tenant_id);
