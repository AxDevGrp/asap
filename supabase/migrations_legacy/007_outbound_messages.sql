-- ASAP — Phase 5D: Per-Tenant Email Sending
-- Creates the outbound_messages table for tracking Resend email delivery
-- Paste into: Supabase Dashboard → SQL Editor → Run

-- ── outbound_messages table ───────────────────────────────────────────────────
-- Stores every outgoing email sent via Resend, with delivery tracking.
-- Updated by the Resend delivery webhook (/api/webhook/resend).

create table if not exists outbound_messages (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  ticket_id           uuid references tickets(id) on delete set null,
  chatwoot_convo_id   integer,
  resend_message_id   text unique,           -- Resend's message ID (for webhook lookup)
  to_email            text not null,
  from_email          text not null,
  subject             text not null,
  body_text           text not null,
  body_html           text,
  status              text not null default 'pending'
                        check (status in ('pending','sent','delivered','bounced','complained','failed')),
  error_message       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Fast lookup by Resend message ID (for webhook updates)
create index if not exists outbound_messages_resend_id_idx
  on outbound_messages(resend_message_id)
  where resend_message_id is not null;

-- Tenant-scoped queries (analytics dashboard)
create index if not exists outbound_messages_tenant_created_idx
  on outbound_messages(tenant_id, created_at desc);

-- Ticket-scoped queries (conversation thread view)
create index if not exists outbound_messages_ticket_idx
  on outbound_messages(ticket_id)
  where ticket_id is not null;

-- Status filter (find bounced/complained for alerts)
create index if not exists outbound_messages_status_idx
  on outbound_messages(status);

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Service role bypasses RLS; tenant members can only read their own messages.

alter table outbound_messages enable row level security;

-- Service role has full access (used by API routes)
create policy "service_role_full_access" on outbound_messages
  as permissive for all
  to service_role
  using (true);

-- Tenant members can read their own outbound messages
create policy "tenant_members_read" on outbound_messages
  as permissive for select
  to authenticated
  using (
    tenant_id in (
      select tenant_id from tenant_memberships
      where user_id = auth.uid() and role in ('owner', 'admin', 'member')
    )
  );

-- ── Updated_at trigger ────────────────────────────────────────────────────────
-- Auto-update updated_at on any row change

create or replace function update_outbound_messages_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger outbound_messages_updated_at
  before update on outbound_messages
  for each row execute function update_outbound_messages_updated_at();
