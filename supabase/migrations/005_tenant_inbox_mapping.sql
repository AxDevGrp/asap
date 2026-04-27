-- ASAP — Phase 5C: Tenant-Aware API + Config
-- Adds chatwoot_inbox_id to tenants for inbox -> tenant resolution
-- Also adds tenant_id to tickets/messages/knowledge_base (if not from 5A)
-- Paste into: Supabase Dashboard → SQL Editor → Run

-- ── Add chatwoot_inbox_id to tenants ─────────────────────────────────────────
alter table tenants
  add column if not exists chatwoot_inbox_id integer unique;

-- Update seeds: STRK=inbox 1, Cashpile=inbox 2, DailyPost=inbox 3
update tenants set chatwoot_inbox_id = 1 where slug = 'strk';
update tenants set chatwoot_inbox_id = 2 where slug = 'cashpile';
update tenants set chatwoot_inbox_id = 3 where slug = 'dailypost';

-- ── Add chatwoot_account_id to tenants (global account — all on account 1 for now) ──
update tenants set chatwoot_account_id = 1 where chatwoot_account_id is null or chatwoot_account_id in (1,2,3);

-- ── Add tenant_id to tickets (idempotent) ────────────────────────────────────
alter table tickets
  add column if not exists tenant_id uuid references tenants(id);

-- ── Add tenant_id to messages (idempotent) ───────────────────────────────────
alter table messages
  add column if not exists tenant_id uuid references tenants(id);

-- ── Add tenant_id to knowledge_base (idempotent) ─────────────────────────────
alter table knowledge_base
  add column if not exists tenant_id uuid references tenants(id);

-- ── Backfill tenant_id from product field ────────────────────────────────────
update tickets t
  set tenant_id = (select id from tenants where slug = t.product limit 1)
  where tenant_id is null and product is not null;

update knowledge_base kb
  set tenant_id = (select id from tenants where slug = kb.product limit 1)
  where tenant_id is null and product is not null;

-- ── Composite indexes for tenant-scoped queries ───────────────────────────────
create index if not exists tickets_tenant_created_idx
  on tickets(tenant_id, created_at desc);

create index if not exists tickets_tenant_status_idx
  on tickets(tenant_id, status);

create index if not exists kb_tenant_idx
  on knowledge_base(tenant_id);

create index if not exists tenants_inbox_idx
  on tenants(chatwoot_inbox_id);
